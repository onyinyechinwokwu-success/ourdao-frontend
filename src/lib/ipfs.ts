import { IPFS_GATEWAY, IPFS_GATEWAYS, IPFS_GATEWAY_TIMEOUT_MS } from '@/constants'

// PBKDF2 iteration count per OWASP guidance (as of 2024).
// Raised from 100,000 to provide protection against offline brute-force attacks
// on documents stored on public IPFS. Future versions may increase this further.
const PBKDF2_ITERATIONS = 600000

// Encryption version marker: increment if algorithm changes to support migrations
const ENCRYPTION_VERSION = 1

// Encryption utilities
export async function encryptData(data: string, password: string): Promise<string> {
  const encoder = new TextEncoder()

  // Generate salt and IV
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))

  // Derive key from password
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
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256'
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
  
  // Encrypt data
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv },
    key,
    encoder.encode(data)
  )

  // Combine version, salt, iv, and encrypted data into a single blob.
  // Format: [version:1][iterations:4][salt:16][iv:12][ciphertext:...]
  // This allows future upgrades to read the parameters back and decrypt
  // old documents even if the algorithm or iteration count changes.
  const iterationsBuffer = new Uint32Array([PBKDF2_ITERATIONS])
  const combined = new Uint8Array(
    1 + iterationsBuffer.byteLength + salt.length + iv.length + encrypted.byteLength
  )
  combined[0] = ENCRYPTION_VERSION
  combined.set(new Uint8Array(iterationsBuffer.buffer), 1)
  combined.set(salt, 1 + iterationsBuffer.byteLength)
  combined.set(iv, 1 + iterationsBuffer.byteLength + salt.length)
  combined.set(
    new Uint8Array(encrypted),
    1 + iterationsBuffer.byteLength + salt.length + iv.length
  )

  return btoa(String.fromCharCode(...combined))
}

export async function decryptData(encryptedData: string, password: string): Promise<string> {
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()

  // Decode base64
  const decoded = atob(encryptedData)
  const combined = new Uint8Array(decoded.length)
  for (let i = 0; i < decoded.length; i++) {
    combined[i] = decoded.charCodeAt(i)
  }

  // Extract components: [version:1][iterations:4][salt:16][iv:12][ciphertext:...]
  // Supports both old (no version) and new (versioned) formats for backward compatibility.
  let iterations = 100000 // Old documents used 100k iterations
  let saltStart = 0
  let ivStart = 16
  let encryptedStart = 28

  // Check if this is a new versioned document (has version byte)
  if (combined.length > 33 && combined[0] <= 1) {
    const iterationsBuffer = new DataView(combined.buffer, combined.byteOffset + 1, 4)
    iterations = iterationsBuffer.getUint32(0, true)
    saltStart = 5
    ivStart = saltStart + 16
    encryptedStart = ivStart + 12
  }

  const salt = combined.slice(saltStart, saltStart + 16)
  const iv = combined.slice(ivStart, ivStart + 12)
  const encrypted = combined.slice(encryptedStart)

  // Derive key from password using the stored iteration count
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
      iterations: iterations,
      hash: 'SHA-256'
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
  
  // Decrypt data
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv },
    key,
    encrypted
  )
  
  return decoder.decode(decrypted)
}

// IPFS upload with encryption. Encryption happens here, client-side, before
// anything leaves the browser — the server route this posts to only ever
// sees the resulting ciphertext, never the plaintext file.
export async function uploadToIPFS(
  file: File,
  encrypt: boolean = false,
  password?: string
): Promise<{ hash: string; size: number; encrypted: boolean }> {
  const fileContent = await file.arrayBuffer()
  let processedData: Uint8Array

  if (encrypt && password) {
    const fileText = new TextDecoder().decode(fileContent)
    const encryptedText = await encryptData(fileText, password)
    processedData = new TextEncoder().encode(encryptedText)
  } else {
    processedData = new Uint8Array(fileContent)
  }

  // No timeout on this POST: a stalled upload route hangs until the browser gives
  // up. Gateway reads below are bounded (fetchFromGateways); this call is not.

  // TS's Uint8Array is generic over its buffer type as of TS 5.7+; BlobPart
  // requires an ArrayBuffer-backed one specifically, so copy into a fresh
  // Uint8Array to satisfy that (no behavior change) — same fix as
  // DocumentViewer.tsx's preview blob.
  const res = await fetch('/api/documents', {
    method: 'POST',
    body: new Blob([new Uint8Array(processedData)]),
  })

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error || `Document upload failed (${res.status})`)
  }

  const { hash } = (await res.json()) as { hash: string }

  return {
    hash,
    size: processedData.length,
    encrypted: encrypt,
  }
}

// Public gateways rate-limit, go down and stall, so each configured gateway is
// tried in order with a timeout; a timeout, network error or non-2xx response
// moves on to the next one instead of hanging DocumentViewer.
async function fetchFromGateways(hash: string): Promise<Response> {
  let lastError: Error | undefined
  for (const gateway of IPFS_GATEWAYS) {
    try {
      const res = await fetch(`${gateway}${hash}`, {
        signal: AbortSignal.timeout(IPFS_GATEWAY_TIMEOUT_MS),
      })
      if (res.ok) return res
      lastError = new Error(`Failed to fetch document from IPFS gateway (${res.status})`)
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
    }
  }
  throw lastError ?? new Error('No IPFS gateway configured')
}

// IPFS download with decryption, read straight from the public gateway — no
// credential needed for reads.
export async function downloadFromIPFS(
  hash: string,
  encrypted: boolean = false,
  password?: string
): Promise<{ content: Uint8Array; decrypted: boolean }> {
  const res = await fetchFromGateways(hash)
  const fileData = new Uint8Array(await res.arrayBuffer())

  if (encrypted && password) {
    const encryptedText = new TextDecoder().decode(fileData)
    const decryptedText = await decryptData(encryptedText, password)
    return {
      content: new TextEncoder().encode(decryptedText),
      decrypted: true,
    }
  }

  return {
    content: fileData,
    decrypted: false,
  }
}

// Get IPFS URL for direct access
export function getIPFSUrl(hash: string): string {
  return `${IPFS_GATEWAY}${hash}`
}

// Validate IPFS hash. Not yet called by getIPFSUrl or downloadFromIPFS, so a
// malformed hash still flows straight into the gateway URL.
export function validateIPFSHash(hash: string): boolean {
  // Shape check only — validates format but not cryptographic integrity.
  // CIDv0: Qm followed by 44 base58btc chars (46 total)
  const cidV0Regex = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/

  // CIDv1: multibase prefix + variable-length hash
  // Supports common prefixes: b (base32), B (base32upper), f (base16), z (base58btc)
  // Accepts 7-60 chars after prefix to cover common multihash lengths
  const cidV1Regex = /^[bBfz][0-9A-Za-z]{7,60}$/

  return cidV0Regex.test(hash) || cidV1Regex.test(hash)
}

// Generate document metadata
export interface DocumentMetadata {
  name: string
  type: string
  size: number
  uploadedAt: Date
  encrypted: boolean
  hash: string
  tags?: string[]
  permissions?: {
    public: boolean
    allowedUsers?: string[]
    allowedRoles?: string[]
  }
}

export function createDocumentMetadata(
  file: File,
  hash: string,
  encrypted: boolean,
  permissions?: DocumentMetadata['permissions']
): DocumentMetadata {
  return {
    name: file.name,
    type: file.type,
    size: file.size,
    uploadedAt: new Date(),
    encrypted,
    hash,
    // Closed unless the caller says otherwise: encryption and public access are
    // separate decisions, so not encrypting must never imply "anyone may read".
    permissions: permissions || { public: false }
  }
}

// Document access control
export function canAccessDocument(
  metadata: DocumentMetadata,
  userAddress: string,
  userRoles: string[] = []
): boolean {
  if (metadata.permissions?.public) {
    return true
  }

  // Stellar public keys are uppercase base32 (G… / C…, 56 chars).
  // Do NOT lowercase — the canonical form is all-caps and lowercasing the
  // needle means it can never match an address stored in canonical form.
  // Compare both sides as-is; callers are responsible for passing the address
  // in the same form it was stored (canonical uppercase for Stellar).
  if (metadata.permissions?.allowedUsers?.includes(userAddress)) {
    return true
  }
  
  if (metadata.permissions?.allowedRoles?.some(role => userRoles.includes(role))) {
    return true
  }
  
  return false
}

// Batch upload multiple documents
export async function uploadMultipleDocuments(
  files: File[],
  encrypt: boolean = false,
  password?: string,
  onProgress?: (progress: number) => void,
  permissions?: DocumentMetadata['permissions']
): Promise<DocumentMetadata[]> {
  const results: DocumentMetadata[] = []
  
  for (let i = 0; i < files.length; i++) {
    const file = files[i]
    const uploadResult = await uploadToIPFS(file, encrypt, password)
    const metadata = createDocumentMetadata(file, uploadResult.hash, encrypt, permissions)
    results.push(metadata)
    
    if (onProgress) {
      onProgress((i + 1) / files.length * 100)
    }
  }
  
  return results
}

// Document search and filtering
export interface DocumentFilter {
  type?: string
  encrypted?: boolean
  tags?: string[]
  dateFrom?: Date
  dateTo?: Date
  sizeMin?: number
  sizeMax?: number
}

export function filterDocuments(
  documents: DocumentMetadata[],
  filter: DocumentFilter
): DocumentMetadata[] {
  return documents.filter(doc => {
    if (filter.type && doc.type !== filter.type) return false
    if (filter.encrypted !== undefined && doc.encrypted !== filter.encrypted) return false
    if (filter.tags && !filter.tags.some(tag => doc.tags?.includes(tag))) return false
    if (filter.dateFrom && doc.uploadedAt < filter.dateFrom) return false
    if (filter.dateTo && doc.uploadedAt > filter.dateTo) return false
    if (filter.sizeMin !== undefined && doc.size < filter.sizeMin) return false
    if (filter.sizeMax !== undefined && doc.size > filter.sizeMax) return false
    return true
  })
}
