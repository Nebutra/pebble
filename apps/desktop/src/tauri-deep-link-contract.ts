import type { SettingsNavTarget } from '@/lib/settings-navigation-types'
import type { ExecutionHostId } from '../../../packages/product-core/shared/execution-host'
import { parsePairingDeepLinkAction, type DeepLinkPairAction } from './tauri-deep-link-pairing'

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

export type DeepLinkAction =
  | DeepLinkPairAction
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
  const trimmed = input.trim()
  const pairingAction = parsePairingDeepLinkAction(trimmed)
  if (pairingAction) {
    return pairingAction
  }
  const parsed = parsePebbleUrl(trimmed)
  if (!parsed) {
    return null
  }
  switch (parsed.hostname) {
    case 'pair':
      // Pair host is handled above (pebble + orca schemes).
      return null
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

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint < 0x20 || codePoint === 0x7f
  })
}
