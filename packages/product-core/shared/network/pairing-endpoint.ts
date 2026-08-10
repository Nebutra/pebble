// Why: the address picker accepts a bare host, `host:port`, an IPv6 literal and
// a full ws/wss/http/https URL, but the QR builder appended the default port to
// all of them — a custom `home.example.com:9443` became
// `ws://home.example.com:9443:17777/v1/shared-control`, which no phone can dial.
// One resolver keeps the QR, the copied link and the endpoint label in step.

export const SHARED_CONTROL_PORT = 17777
export const SHARED_CONTROL_PATH = '/v1/shared-control'

// `//` is what separates a scheme from a host: without it `home.example.com:9443`
// and the IPv6 literal `fd7a:115c::1` both read as a scheme named after their
// first label, and every accepted scheme is hierarchical anyway.
const SCHEME_PREFIX = /^[a-z][a-z0-9+.-]*:\/\//i
const WEBSOCKET_SCHEME_FOR: Record<string, string> = {
  'http:': 'ws:',
  'https:': 'wss:',
  'ws:': 'ws:',
  'wss:': 'wss:'
}
const MAX_ADDRESS_LENGTH = 512

export function resolvePairingEndpoint(
  address: string,
  port: number = SHARED_CONTROL_PORT
): string | null {
  const trimmed = address.trim()
  if (!trimmed || trimmed.length > MAX_ADDRESS_LENGTH || hasUnsafeCharacter(trimmed)) {
    return null
  }
  const parsed = SCHEME_PREFIX.test(trimmed)
    ? parseAbsolutePairingUrl(trimmed)
    : parseHostPairingAddress(trimmed, port)
  if (!parsed) {
    return null
  }
  // An address that carries no path of its own still has to reach the
  // shared-control socket, but an explicit path is the caller's routing choice
  // (a reverse proxy in front of the runtime) and must survive untouched.
  if (parsed.pathname === '' || parsed.pathname === '/') {
    parsed.pathname = SHARED_CONTROL_PATH
  }
  return parsed.toString()
}

// A full URL already states its port, and an omitted one means the scheme's
// default — substituting the shared-control port there would redirect a
// deliberate `https://gateway.example.com` away from 443.
function parseAbsolutePairingUrl(value: string): URL | null {
  try {
    const parsed = new URL(value)
    const scheme = WEBSOCKET_SCHEME_FOR[parsed.protocol]
    if (!scheme || parsed.username || parsed.password || !parsed.hostname) {
      return null
    }
    parsed.protocol = scheme
    parsed.hash = ''
    return parsed
  } catch {
    return null
  }
}

function parseHostPairingAddress(value: string, port: number): URL | null {
  try {
    // A bare IPv6 literal has to be bracketed before the URL parser will read
    // its colons as address bytes rather than as a port separator.
    const authority = isBareIPv6Literal(value) ? `[${value}]` : value
    const parsed = new URL(`ws://${authority}`)
    // `ws://host/extra` is not a host, and neither is anything carrying
    // credentials or a query — reject rather than silently dialing part of it.
    if (
      !parsed.hostname ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      (parsed.pathname !== '' && parsed.pathname !== '/')
    ) {
      return null
    }
    if (!parsed.port) {
      parsed.port = String(port)
    }
    return parsed
  } catch {
    return null
  }
}

// A control character in a pairing address can only be a paste accident or an
// attempt to smuggle a second header line past the URL parser.
function hasUnsafeCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint <= 0x20 || codePoint === 0x7f
  })
}

function isBareIPv6Literal(value: string): boolean {
  return !value.startsWith('[') && value.indexOf(':') !== value.lastIndexOf(':')
}
