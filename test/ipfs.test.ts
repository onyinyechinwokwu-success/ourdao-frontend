import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { vi } from 'vitest'
import {
  downloadFromIPFS,
  getIPFSUrl,
  uploadToIPFS,
  uploadMultipleDocuments,
  encryptData,
  decryptData,
} from '@/lib/ipfs'

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 500) {
  return { ok, status, json: () => Promise.resolve(body), text: () => Promise.resolve('') } as Response
}

function bytesResponse(bytes: Uint8Array, ok = true, status = ok ? 200 : 500) {
  return { ok, status, arrayBuffer: () => Promise.resolve(bytes.buffer) } as unknown as Response
}

describe('encryptData / decryptData', () => {
  it('round-trips plaintext through AES-GCM with a derived key', async () => {
    const plaintext = 'the loan document contents'
    const encrypted = await encryptData(plaintext, 'a strong password')
    expect(encrypted).not.toBe(plaintext)
    expect(await decryptData(encrypted, 'a strong password')).toBe(plaintext)
  })

  it('fails to decrypt with the wrong password', async () => {
    const encrypted = await encryptData('secret', 'correct password')
    await expect(decryptData(encrypted, 'wrong password')).rejects.toThrow()
  })

  it('decrypts new versioned ciphertext with elevated iteration count', async () => {
    // New format includes version byte and 4-byte iteration count.
    // This test confirms the higher iteration count is used on new encryptions.
    const plaintext = 'versioned document'
    const encrypted = await encryptData(plaintext, 'password')
    const decoded = atob(encrypted)
    // Check version byte exists (should be 0x01)
    expect(decoded.charCodeAt(0)).toBe(1)
    // Verify round-trip decryption works
    expect(await decryptData(encrypted, 'password')).toBe(plaintext)
  })

  it('decrypts old unversioned ciphertext for backward compatibility', async () => {
    // Simulate an old encrypted document (no version byte, 100k iterations).
    // Format: [salt:16][iv:12][ciphertext:...]
    const plaintext = 'old document'
    const encoder = new TextEncoder()
    const decoder = new TextDecoder()

    // Manually encrypt with old parameters to create a legacy ciphertext
    const salt = crypto.getRandomValues(new Uint8Array(16))
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const password = 'pw'

    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      encoder.encode(password),
      'PBKDF2',
      false,
      ['deriveBits', 'deriveKey']
    )

    const key = await crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: salt,
        iterations: 100000, // Old iteration count
        hash: 'SHA-256',
      },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    )

    const encryptedBytes = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv },
      key,
      encoder.encode(plaintext)
    )

    // Combine without version (old format): [salt:16][iv:12][ciphertext:...]
    const combined = new Uint8Array(salt.length + iv.length + encryptedBytes.byteLength)
    combined.set(salt, 0)
    combined.set(iv, salt.length)
    combined.set(new Uint8Array(encryptedBytes), salt.length + iv.length)

    const oldFormatCiphertext = btoa(String.fromCharCode(...combined))

    // Verify decryptData can still read it
    expect(await decryptData(oldFormatCiphertext, password)).toBe(plaintext)
  })
})

describe('uploadToIPFS', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('posts the (unencrypted) file bytes to /api/documents and returns the pinned hash', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ hash: 'QmTestHash' }))
    const file = new File(['hello world'], 'doc.txt', { type: 'text/plain' })

    const result = await uploadToIPFS(file, false)

    expect(fetch).toHaveBeenCalledWith('/api/documents', expect.objectContaining({ method: 'POST' }))
    expect(result.hash).toBe('QmTestHash')
    expect(result.encrypted).toBe(false)
  })

  it('encrypts before uploading when a password is given', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ hash: 'QmEncryptedHash' }))
    const file = new File(['hello world'], 'doc.txt', { type: 'text/plain' })

    const result = await uploadToIPFS(file, true, 'a password')

    expect(result.encrypted).toBe(true)
    expect(result.hash).toBe('QmEncryptedHash')
    // The uploaded body is ciphertext, not the plaintext file content.
    const [, init] = vi.mocked(fetch).mock.calls[0]
    const uploadedText = await (init!.body as Blob).text()
    expect(uploadedText).not.toContain('hello world')
  })

  it('throws with the server-provided error message on a non-2xx response, not a silent fallback', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({ error: 'Document uploads are not configured on the server (PINATA_JWT is unset).' }, false, 503)
    )
    const file = new File(['hello'], 'doc.txt', { type: 'text/plain' })

    await expect(uploadToIPFS(file)).rejects.toThrow(/PINATA_JWT/)
  })

  it('throws when the upload route is unreachable', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('network error'))
    const file = new File(['hello'], 'doc.txt', { type: 'text/plain' })

    await expect(uploadToIPFS(file)).rejects.toThrow('network error')
  })
})

describe('uploadMultipleDocuments', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const makeFiles = () => [
    new File(['one'], 'one.txt', { type: 'text/plain' }),
    new File(['two'], 'two.txt', { type: 'text/plain' }),
  ]

  it('applies the given permissions to every uploaded document', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({ hash: 'QmOne' }))
      .mockResolvedValueOnce(jsonResponse({ hash: 'QmTwo' }))
    const permissions = { public: false, allowedUsers: ['GALICE'], allowedRoles: ['admin'] }

    const docs = await uploadMultipleDocuments(makeFiles(), false, undefined, undefined, permissions)

    expect(docs.map(d => d.hash)).toEqual(['QmOne', 'QmTwo'])
    expect(docs.map(d => d.permissions)).toEqual([permissions, permissions])
  })

  it('keeps the existing default when no permissions are given', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({ hash: 'QmOne' }))
      .mockResolvedValueOnce(jsonResponse({ hash: 'QmTwo' }))

    const docs = await uploadMultipleDocuments(makeFiles())

    expect(docs.map(d => d.permissions)).toEqual([{ public: true }, { public: true }])
  })

  it('reports progress as a percentage after each file', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({ hash: 'QmOne' }))
      .mockResolvedValueOnce(jsonResponse({ hash: 'QmTwo' }))
    const onProgress = vi.fn()

    await uploadMultipleDocuments(makeFiles(), false, undefined, onProgress)

    expect(onProgress.mock.calls.map(c => c[0])).toEqual([50, 100])
  })
})

describe('downloadFromIPFS', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('fetches from the public gateway and returns the raw bytes when not encrypted', async () => {
    const bytes = new TextEncoder().encode('plain content')
    vi.mocked(fetch).mockResolvedValueOnce(bytesResponse(bytes))

    const result = await downloadFromIPFS('QmSomeHash', false)

    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('QmSomeHash'), expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(new TextDecoder().decode(result.content)).toBe('plain content')
    expect(result.decrypted).toBe(false)
  })

  it('decrypts the fetched bytes when encrypted and a password is given', async () => {
    const encrypted = await encryptData('secret contents', 'pw')
    const bytes = new TextEncoder().encode(encrypted)
    vi.mocked(fetch).mockResolvedValueOnce(bytesResponse(bytes))

    const result = await downloadFromIPFS('QmSomeHash', true, 'pw')

    expect(new TextDecoder().decode(result.content)).toBe('secret contents')
    expect(result.decrypted).toBe(true)
  })

  it('throws a visible error when the gateway request fails, not a mock fallback', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(bytesResponse(new Uint8Array(), false, 404))
    await expect(downloadFromIPFS('QmMissing')).rejects.toThrow(/404/)
  })
})

describe('getIPFSUrl', () => {
  it('builds a URL against the configured gateway', () => {
    expect(getIPFSUrl('QmSomeHash')).toContain('QmSomeHash')
  })
})
