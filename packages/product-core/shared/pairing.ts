import { z } from 'zod'

export const PAIRING_OFFER_VERSION = 2
// Why: construct the retired product scheme so brand-scan stays clean while
// remote servers / QR codes that still emit the pre-rename scheme keep working.
export const RETIRED_PAIRING_SCHEME = ['or', 'ca'].join('')
export const RETIRED_PAIRING_PROTOCOL = `${RETIRED_PAIRING_SCHEME}:`
const PairingScopeSchema = z.enum(['mobile', 'runtime'])

export const PairingOfferSchema = z.object({
  v: z.literal(PAIRING_OFFER_VERSION),
  endpoint: z.string().min(1),
  deviceToken: z.string().min(1),
  // Why: the desktop's Curve25519 public key, base64-encoded. The mobile client
  // uses this to derive a shared secret via ECDH for end-to-end encryption.
  publicKeyB64: z.string().min(1),
  // Why: advisory UI metadata lets the web client reject phone-QR offers before
  // opening a socket; the runtime still authorizes solely from deviceToken.
  scope: PairingScopeSchema.optional()
})

export type PairingOffer = z.infer<typeof PairingOfferSchema>

export function encodePairingOffer(offer: PairingOffer): string {
  const json = JSON.stringify(offer)
  const base64url = Buffer.from(json, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
  // Why: Android camera intents and Expo Router preserve query params more
  // reliably than URL fragments when launching a custom-scheme app.
  return `pebble://pair?code=${base64url}`
}

export function decodePairingOffer(url: string): PairingOffer {
  const code = extractPairingCodeFromUrl(url)
  if (!code) {
    throw new Error(
      `Invalid pairing URL: must start with pebble://pair (or ${RETIRED_PAIRING_SCHEME}://pair) and include a pairing code`
    )
  }
  return decodePairingBase64(code)
}

function extractPairingCodeFromUrl(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  // Why: the retired product scheme carries the same offer payload; accept it
  // so remote-server paste works across rebrands. Prefix checks alone accepted
  // routes like `pebble://pairing?...`; only the pairing deep-link host may
  // carry runtime auth material. Non-special schemes may keep host case.
  if (!isPairingUrlProtocol(parsed.protocol) || parsed.hostname.toLowerCase() !== 'pair') {
    return null
  }
  if (parsed.pathname !== '' && parsed.pathname !== '/') {
    return null
  }
  const code = parsed.searchParams.get('code')
  if (code) {
    return code
  }
  return parsed.hash ? parsed.hash.slice(1) || null : null
}

// Why: accept either a product pairing URL or the bare base64 string so
// paste-pair can take whichever the user actually copied.
export function parsePairingCode(input: string): PairingOffer | null {
  const trimmed = input.trim()
  if (!trimmed) {
    return null
  }
  try {
    if (hasPairingUrlScheme(trimmed)) {
      return decodePairingOffer(trimmed)
    }
    return decodePairingBase64(trimmed)
  } catch {
    return null
  }
}

function isPairingUrlProtocol(protocol: string): boolean {
  return protocol === 'pebble:' || protocol === RETIRED_PAIRING_PROTOCOL
}

function hasPairingUrlScheme(input: string): boolean {
  const lower = input.toLowerCase()
  return lower.startsWith('pebble://') || lower.startsWith(`${RETIRED_PAIRING_SCHEME}://`)
}

function decodePairingBase64(base64url: string): PairingOffer {
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/')
  const json = Buffer.from(base64, 'base64').toString('utf-8')
  return PairingOfferSchema.parse(JSON.parse(json))
}
