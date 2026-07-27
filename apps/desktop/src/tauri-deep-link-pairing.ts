const MAX_VALUE_LENGTH = 512

export type DeepLinkPairingOffer = {
  endpoint: string
  deviceToken: string
  publicKeyB64: string
}

export type DeepLinkPairAction = {
  kind: 'pair'
  url: string
  offer: DeepLinkPairingOffer
  key: string
}

// Why: Orca remote pairing URLs use `orca://pair` with the same offer payload.
// Only the pair host is cross-scheme; other deep links stay pebble-only.
export function parsePairingDeepLinkAction(input: string): DeepLinkPairAction | null {
  const trimmed = input.trim()
  const pairingUrl = parsePairingDeepLinkUrl(trimmed)
  if (!pairingUrl) {
    return null
  }
  return parsePairingAction(pairingUrl, trimmed)
}

function parsePairingDeepLinkUrl(input: string): URL | null {
  if (!input || input.length > 8 * 1024 || hasControlCharacter(input)) {
    return null
  }
  try {
    const parsed = new URL(input)
    // Why: non-special schemes may keep host case (`ORCA://PAIR`); normalize.
    if (
      (parsed.protocol !== 'pebble:' && parsed.protocol !== 'orca:') ||
      parsed.hostname.toLowerCase() !== 'pair' ||
      parsed.username ||
      parsed.password ||
      parsed.port
    ) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

function parsePairingAction(parsed: URL, url: string): DeepLinkPairAction | null {
  if (!isRootPath(parsed.pathname) || !hasOnlyParams(parsed, ['code'])) {
    return null
  }
  const queryCode = parsed.searchParams.get('code')?.trim()
  const hashCode = parsed.hash.slice(1).trim()
  if ((!queryCode && !hashCode) || (queryCode && hashCode)) {
    return null
  }
  const offer = decodePairingOffer(queryCode ?? hashCode)
  return offer
    ? {
        kind: 'pair',
        url,
        offer,
        key: `pair:${offer.endpoint}:${offer.publicKeyB64}:${fingerprint(offer.deviceToken)}`
      }
    : null
}

function decodePairingOffer(code: string): DeepLinkPairingOffer | null {
  try {
    const value = JSON.parse(new TextDecoder().decode(base64UrlToBytes(code))) as Record<
      string,
      unknown
    >
    if (
      value.v !== 2 ||
      !isBoundedString(value.endpoint) ||
      !isBoundedString(value.deviceToken) ||
      !isBoundedString(value.publicKeyB64)
    ) {
      return null
    }
    // Why: a mobile-scoped token cannot authorize desktop project/runtime RPC;
    // importing it as a server would create a permanently degraded host.
    if (value.scope !== undefined && value.scope !== 'runtime') {
      return null
    }
    const endpoint = normalizePairingEndpoint(value.endpoint)
    return endpoint
      ? { endpoint, deviceToken: value.deviceToken, publicKeyB64: value.publicKeyB64 }
      : null
  } catch {
    return null
  }
}

function normalizePairingEndpoint(value: string): string | null {
  try {
    const parsed = new URL(value)
    if (
      !['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      !parsed.hostname
    ) {
      return null
    }
    if (parsed.protocol === 'http:') {
      parsed.protocol = 'ws:'
    }
    if (parsed.protocol === 'https:') {
      parsed.protocol = 'wss:'
    }
    return parsed.toString()
  } catch {
    return null
  }
}

function base64UrlToBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(value) || value.length > 7 * 1024) {
    throw new Error('invalid pairing code')
  }
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
  const binary = globalThis.atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='))
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

function hasOnlyParams(url: URL, allowed: string[]): boolean {
  const keys = [...url.searchParams.keys()]
  const allowedSet = new Set(allowed)
  return keys.every((key) => allowedSet.has(key)) && new Set(keys).size === keys.length
}

function isRootPath(pathname: string): boolean {
  return pathname === '' || pathname === '/'
}

function isBoundedString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_VALUE_LENGTH
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint < 0x20 || codePoint === 0x7f
  })
}

function fingerprint(value: string): string {
  // Why: replay suppression must distinguish rotated credentials without
  // retaining the pairing token itself in a process-lifetime lookup key.
  let hash = 0x811c9dc5
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}
