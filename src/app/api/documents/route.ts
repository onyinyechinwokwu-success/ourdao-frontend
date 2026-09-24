import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'

/**
 * Hard cap on an upload body. The client limits plaintext to 10 MB
 * (DocumentUpload's `maxSize`); encryption + base64 framing inflates that by
 * roughly a third, so 16 MB leaves headroom without letting an anonymous
 * caller make the server allocate arbitrary amounts of memory.
 */
export const MAX_UPLOAD_BYTES = 16 * 1024 * 1024

const tooLarge = () =>
  NextResponse.json(
    { error: `Upload exceeds the ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB limit` },
    { status: 413 }
  )

/**
 * Reads the request body, aborting as soon as it exceeds MAX_UPLOAD_BYTES.
 * Returns null when the cap is breached. Buffering is bounded by the cap, and
 * chunked bodies with no Content-Length are covered because the check runs on
 * bytes actually received, not on the (spoofable) header.
 */
async function readBounded(req: NextRequest): Promise<Uint8Array | null> {
  if (!req.body) return new Uint8Array(0)
  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_UPLOAD_BYTES) {
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.byteLength
  }
  return out
}

/**
 * Pins an already-encrypted document blob to IPFS via Pinata.
 *
 * The client encrypts client-side (see src/lib/ipfs.ts) and posts the raw
 * ciphertext bytes here as the request body — this route never sees
 * plaintext. `PINATA_JWT` is a server-only env var (no `NEXT_PUBLIC_` prefix)
 * so the credential never reaches the client bundle.
 */
export async function POST(req: NextRequest) {
  const jwt = process.env.PINATA_JWT
  if (!jwt) {
    return NextResponse.json(
      { error: 'Document uploads are not configured on the server (PINATA_JWT is unset).' },
      { status: 503 }
    )
  }

  // Reject on the declared length before reading a single byte.
  const declared = Number(req.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) return tooLarge()

  const body = await readBounded(req)
  if (!body) return tooLarge()
  if (body.byteLength === 0) {
    return NextResponse.json({ error: 'Empty upload' }, { status: 400 })
  }

  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(body)]), 'document')

  let res: Response
  try {
    // No timeout or abort signal: a hung Pinata API holds this handler open
    // instead of returning an error response.
    res = await fetch('https://api.pinata.cloud/pinning/pinFileToIPFS', {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt}` },
      body: form,
    })
  } catch {
    return NextResponse.json({ error: 'Could not reach the pinning provider' }, { status: 502 })
  }

  if (!res.ok) {
    // The provider's body can carry account ids, plan/quota state and internal
    // request ids. Keep it in server logs, keyed by a request id the client can
    // quote, and return only a generic message.
    const requestId = randomUUID()
    const detail = await res.text().catch(() => '')
    console.error(`[documents] pinning provider rejected upload (${res.status}) requestId=${requestId}`, detail)
    return NextResponse.json(
      { error: `Pinning provider rejected the upload (request ${requestId})` },
      { status: 502 }
    )
  }

  const data = (await res.json()) as { IpfsHash: string }
  return NextResponse.json({ hash: data.IpfsHash })
}
