import type { SettingsNavTarget } from '@/lib/settings-navigation-types'
import type { ExecutionHostId } from '../../../packages/product-core/shared/execution-host'

const MAX_VALUE_LENGTH = 512
const SETTINGS_TARGETS = new Set<SettingsNavTarget>([
  'general',
  'integrations',
  'accounts',
  'browser',
  'git',
  'tasks',
  'appearance',
  'input',
  'floating-workspace',
  'terminal',
  'quick-commands',
  'notifications',
  'computer-use',
  'developer-permissions',
  'privacy',
  'advanced',
  'dev',
  'voice',
  'shortcuts',
  'stats',
  'ssh',
  'experimental',
  'agents',
  'orchestration',
  'servers',
  'mobile',
  'mobile-emulator',
  'repo'
])
const TASK_SOURCES = new Set(['github', 'gitlab', 'linear', 'jira'])

type PairingOffer = { endpoint: string; deviceToken: string; publicKeyB64: string }

export type DeepLinkAction =
  | { kind: 'pair'; url: string; offer: PairingOffer; key: string }
  | {
      kind: 'settings'
      pane: SettingsNavTarget
      repoId: string | null
      sectionId?: string
      intent?: 'add-quick-command'
      key: string
    }
  | { kind: 'tasks'; source?: 'github' | 'gitlab' | 'linear' | 'jira'; key: string }
  | { kind: 'activity' | 'skills' | 'mobile' | 'space'; key: string }
  | {
      kind: 'automations'
      automationId?: string
      runId?: string
      hostId?: ExecutionHostId
      key: string
    }

export function parseDeepLinkAction(input: string): DeepLinkAction | null {
  const parsed = parsePebbleUrl(input)
  if (!parsed) {
    return null
  }
  switch (parsed.hostname) {
    case 'pair':
      return parsePairingAction(parsed, input.trim())
    case 'settings':
      return parseSettingsAction(parsed)
    case 'tasks':
      return parseTasksAction(parsed)
    case 'automations':
      return parseAutomationsAction(parsed)
    case 'activity':
    case 'skills':
    case 'mobile':
    case 'space':
      return isBarePageUrl(parsed) ? { kind: parsed.hostname, key: parsed.hostname } : null
    default:
      return null
  }
}

function parsePebbleUrl(input: string): URL | null {
  const value = input.trim()
  if (!value || value.length > 8 * 1024 || hasControlCharacter(value)) {
    return null
  }
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'pebble:' && !parsed.username && !parsed.password && !parsed.port
      ? parsed
      : null
  } catch {
    return null
  }
}

function parsePairingAction(parsed: URL, url: string): DeepLinkAction | null {
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

function parseSettingsAction(parsed: URL): DeepLinkAction | null {
  if (parsed.hash || !hasOnlyParams(parsed, ['section', 'repo', 'intent'])) {
    return null
  }
  const pane = decodeSinglePathSegment(parsed.pathname)
  if (!pane || !SETTINGS_TARGETS.has(pane as SettingsNavTarget)) {
    return null
  }
  const sectionId = parseIdentifier(parsed.searchParams.get('section'), 128)
  const repoId = parseIdentifier(parsed.searchParams.get('repo'), 256)
  const intent = parsed.searchParams.get('intent')
  if (intent && (pane !== 'quick-commands' || intent !== 'add-quick-command')) {
    return null
  }
  if (
    (parsed.searchParams.has('section') && !sectionId) ||
    (parsed.searchParams.has('repo') && !repoId)
  ) {
    return null
  }
  return {
    kind: 'settings',
    pane: pane as SettingsNavTarget,
    repoId,
    ...(sectionId ? { sectionId } : {}),
    ...(intent ? { intent: 'add-quick-command' as const } : {}),
    key: `settings:${pane}:${repoId ?? ''}:${sectionId ?? ''}:${intent ?? ''}`
  }
}

function parseTasksAction(parsed: URL): DeepLinkAction | null {
  if (!isRootPath(parsed.pathname) || parsed.hash || !hasOnlyParams(parsed, ['source'])) {
    return null
  }
  const source = parsed.searchParams.get('source')
  if (source && !TASK_SOURCES.has(source)) {
    return null
  }
  return {
    kind: 'tasks',
    ...(source ? { source: source as 'github' | 'gitlab' | 'linear' | 'jira' } : {}),
    key: `tasks:${source ?? ''}`
  }
}

function parseAutomationsAction(parsed: URL): DeepLinkAction | null {
  if (parsed.hash || !hasOnlyParams(parsed, ['run', 'host'])) {
    return null
  }
  const segments = parsed.pathname.split('/').filter(Boolean)
  if (segments.length > 1) {
    return null
  }
  const automationId = decodeOptionalSinglePathSegment(parsed.pathname)
  if (segments.length === 1 && !automationId) {
    return null
  }
  const runId = parseIdentifier(parsed.searchParams.get('run'), 256)
  const hostId = parseExecutionHostId(parsed.searchParams.get('host'))
  if ((parsed.searchParams.has('run') && !runId) || (parsed.searchParams.has('host') && !hostId)) {
    return null
  }
  if ((runId || hostId) && !automationId) {
    return null
  }
  return {
    kind: 'automations',
    ...(automationId ? { automationId } : {}),
    ...(runId ? { runId } : {}),
    ...(hostId ? { hostId } : {}),
    key: `automations:${automationId ?? ''}:${runId ?? ''}:${hostId ?? ''}`
  }
}

function decodePairingOffer(code: string): PairingOffer | null {
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

function decodeSinglePathSegment(pathname: string): string | null {
  return decodeOptionalSinglePathSegment(pathname) ?? null
}

function decodeOptionalSinglePathSegment(pathname: string): string | undefined {
  const segments = pathname.split('/').filter(Boolean)
  if (segments.length !== 1) {
    return undefined
  }
  try {
    return parseIdentifier(decodeURIComponent(segments[0]).trim(), 256) ?? undefined
  } catch {
    return undefined
  }
}

function parseIdentifier(value: string | null, maxLength: number): string | null {
  if (value === null) {
    return null
  }
  const trimmed = value.trim()
  return trimmed && trimmed.length <= maxLength && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(trimmed)
    ? trimmed
    : null
}

function parseExecutionHostId(value: string | null): ExecutionHostId | null {
  const id = parseIdentifier(value, 256)
  return id && (id === 'local' || id.startsWith('ssh:') || id.startsWith('runtime:'))
    ? (id as ExecutionHostId)
    : null
}

function hasOnlyParams(url: URL, allowed: string[]): boolean {
  const keys = [...url.searchParams.keys()]
  const allowedSet = new Set(allowed)
  return keys.every((key) => allowedSet.has(key)) && new Set(keys).size === keys.length
}

function isRootPath(pathname: string): boolean {
  return pathname === '' || pathname === '/'
}
function isBarePageUrl(url: URL): boolean {
  return isRootPath(url.pathname) && !url.search && !url.hash
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
