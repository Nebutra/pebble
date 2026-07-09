import type { PreloadApi } from '../../../src/preload/api-types'
import type { AgentInterruptInferenceRequest } from '../../../src/shared/agent-interrupt-intent'
import { isAgentInterruptInputIntent } from '../../../src/shared/agent-interrupt-intent'
import type {
  AgentStatusIpcPayload,
  AgentStatusState,
  AgentType
} from '../../../src/shared/agent-status-types'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../src/shared/agent-status-types'
import { makePaneKey, parsePaneKey } from '../../../src/shared/stable-pane-id'
import type { TuiAgent } from '../../../src/shared/types'
import { createRuntimeResourceGetCommand, getRuntimeResourceJson } from './runtime-bridge'

type PtySpawnOptions = Parameters<PreloadApi['pty']['spawn']>[0]

export type TauriRuntimeAgentSessionStatus =
  | 'starting'
  | 'running'
  | 'exited'
  | 'failed'
  | 'stopped'

export type TauriRuntimeAgentSession = {
  id: string
  worktreeId?: string
  command?: string[]
  agentKind?: string
  status: TauriRuntimeAgentSessionStatus
  exitCode?: number | null
  startedAt?: string
  updatedAt?: string
  tabId?: string
  leafId?: string
  launchToken?: string
  prompt?: string
}

type RuntimeAgentBinding = {
  sessionId: string
  paneKey: string
  tabId: string
  leafId: string
  worktreeId?: string
  agentType: AgentType
  terminalHandle: string
  launchToken?: string
  prompt: string
  receivedAt: number
  stateStartedAt: number
  state: AgentStatusState
  interrupted?: boolean
}

const agentStatusSetListeners = new Set<(data: AgentStatusIpcPayload) => void>()
const agentStatusClearListeners = new Set<(data: { paneKey: string }) => void>()
const bindingsBySessionId = new Map<string, RuntimeAgentBinding>()
const bindingsByPaneKey = new Map<string, RuntimeAgentBinding>()

export function installTauriAgentStatusApi(): void {
  if (!hasTauriInternals()) {
    return
  }

  window.api.agentStatus = {
    onSet: (callback) => {
      agentStatusSetListeners.add(callback)
      return () => {
        agentStatusSetListeners.delete(callback)
      }
    },
    onClear: (callback) => {
      agentStatusClearListeners.add(callback)
      return () => {
        agentStatusClearListeners.delete(callback)
      }
    },
    getSnapshot: async () => {
      await hydrateRuntimeAgentSessionSnapshot()
      return Array.from(bindingsByPaneKey.values(), toAgentStatusPayload)
    },
    inferInterrupt: async (request) => inferRuntimeAgentInterrupt(request),
    onMigrationUnsupported: () => noopUnsubscribe,
    onMigrationUnsupportedClear: () => noopUnsubscribe,
    getMigrationUnsupportedSnapshot: () => Promise.resolve([]),
    drop: (paneKey) => {
      dropRuntimeAgentPane(paneKey)
    },
    dropByTabPrefix: (tabId) => {
      dropRuntimeAgentTab(tabId)
    }
  } satisfies PreloadApi['agentStatus']
}

export function recordRuntimeAgentSessionSpawn(args: {
  session: TauriRuntimeAgentSession
  spawnOptions: PtySpawnOptions
}): void {
  const agentType = readAgentType(args.spawnOptions.launchAgent ?? args.session.agentKind)
  if (!agentType) {
    return
  }
  const binding = createBindingFromSession(args.session, {
    agentType,
    tabId: args.spawnOptions.tabId,
    leafId: args.spawnOptions.leafId,
    launchToken: args.spawnOptions.launchToken,
    prompt: readPrompt(args.session.prompt)
  })
  if (!binding) {
    return
  }
  rememberBinding(binding)
  emitAgentStatus(binding)
}

export function emitRuntimeAgentSessionStatus(session: TauriRuntimeAgentSession): void {
  const binding = bindingsBySessionId.get(session.id) ?? createBindingFromRuntimeSession(session)
  if (!binding) {
    return
  }
  const nextState = toAgentStatusState(session.status)
  const now = readRuntimeTimestamp(session.updatedAt) ?? Date.now()
  binding.stateStartedAt = binding.state === nextState ? binding.stateStartedAt : now
  binding.state = nextState
  binding.receivedAt = now
  binding.interrupted = session.status === 'stopped' ? true : undefined
  rememberBinding(binding)
  emitAgentStatus(binding)
}

export function markRuntimeAgentSessionStopped(sessionId: string): void {
  const binding = bindingsBySessionId.get(sessionId)
  if (!binding) {
    return
  }
  const now = Date.now()
  binding.stateStartedAt = binding.state === 'done' ? binding.stateStartedAt : now
  binding.state = 'done'
  binding.receivedAt = now
  binding.interrupted = true
  emitAgentStatus(binding)
}

function hasTauriInternals(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

const noopUnsubscribe = (): void => {}

async function hydrateRuntimeAgentSessionSnapshot(): Promise<void> {
  const sessions = await listRuntimeSessions().catch(() => [])
  for (const session of sessions) {
    const binding = createBindingFromRuntimeSession(session)
    if (!binding) {
      continue
    }
    rememberBinding(binding)
  }
}

async function listRuntimeSessions(): Promise<TauriRuntimeAgentSession[]> {
  const result = await getRuntimeResourceJson(
    createRuntimeResourceGetCommand({ path: '/v1/sessions', timeoutMs: 1500 })
  )
  if (
    result.transport !== 'connected' ||
    (result.httpStatus !== null && (result.httpStatus < 200 || result.httpStatus > 299)) ||
    !result.body
  ) {
    return []
  }
  const parsed = JSON.parse(result.body)
  return Array.isArray(parsed) ? parsed.filter(isRuntimeAgentSession) : []
}

function createBindingFromRuntimeSession(
  session: TauriRuntimeAgentSession
): RuntimeAgentBinding | null {
  const agentType = readAgentType(session.agentKind)
  if (!agentType) {
    return null
  }
  return createBindingFromSession(session, {
    agentType,
    tabId: session.tabId,
    leafId: session.leafId,
    launchToken: session.launchToken,
    prompt: readPrompt(session.prompt)
  })
}

function createBindingFromSession(
  session: TauriRuntimeAgentSession,
  metadata: {
    agentType: AgentType
    tabId?: string
    leafId?: string
    launchToken?: string
    prompt: string
  }
): RuntimeAgentBinding | null {
  const paneIdentity = createPaneIdentity(metadata.tabId, metadata.leafId)
  if (!paneIdentity) {
    return null
  }
  const existing =
    bindingsBySessionId.get(session.id) ?? bindingsByPaneKey.get(paneIdentity.paneKey)
  const now =
    readRuntimeTimestamp(session.updatedAt) ?? readRuntimeTimestamp(session.startedAt) ?? Date.now()
  const state = toAgentStatusState(session.status)
  return {
    sessionId: session.id,
    paneKey: paneIdentity.paneKey,
    tabId: paneIdentity.tabId,
    leafId: paneIdentity.leafId,
    ...(session.worktreeId ? { worktreeId: session.worktreeId } : {}),
    agentType: metadata.agentType,
    terminalHandle: session.id,
    ...(metadata.launchToken ? { launchToken: metadata.launchToken } : {}),
    prompt: metadata.prompt,
    receivedAt: now,
    stateStartedAt: existing?.state === state ? existing.stateStartedAt : now,
    state,
    interrupted: session.status === 'stopped' ? true : undefined
  }
}

function createPaneIdentity(
  tabId: string | undefined,
  leafId: string | undefined
): { tabId: string; leafId: string; paneKey: string } | null {
  if (!tabId || !leafId) {
    return null
  }
  try {
    return { tabId, leafId, paneKey: makePaneKey(tabId, leafId) }
  } catch {
    return null
  }
}

function rememberBinding(binding: RuntimeAgentBinding): void {
  bindingsBySessionId.set(binding.sessionId, binding)
  bindingsByPaneKey.set(binding.paneKey, binding)
}

function emitAgentStatus(binding: RuntimeAgentBinding): void {
  const payload = toAgentStatusPayload(binding)
  for (const listener of agentStatusSetListeners) {
    listener(payload)
  }
}

function toAgentStatusPayload(binding: RuntimeAgentBinding): AgentStatusIpcPayload {
  return {
    state: binding.state,
    prompt: binding.prompt,
    agentType: binding.agentType,
    paneKey: binding.paneKey,
    tabId: binding.tabId,
    ...(binding.worktreeId ? { worktreeId: binding.worktreeId } : {}),
    terminalHandle: binding.terminalHandle,
    ...(binding.launchToken ? { launchToken: binding.launchToken } : {}),
    connectionId: null,
    receivedAt: binding.receivedAt,
    stateStartedAt: binding.stateStartedAt,
    ...(binding.interrupted ? { interrupted: true } : {})
  }
}

function dropRuntimeAgentPane(paneKey: string): void {
  const parsed = parsePaneKey(paneKey)
  if (!parsed) {
    return
  }
  const binding = bindingsByPaneKey.get(paneKey)
  if (binding) {
    bindingsBySessionId.delete(binding.sessionId)
    bindingsByPaneKey.delete(paneKey)
  }
  emitAgentStatusClear(paneKey)
}

function dropRuntimeAgentTab(tabId: string): void {
  if (!tabId) {
    return
  }
  for (const paneKey of Array.from(bindingsByPaneKey.keys())) {
    if (paneKey.startsWith(`${tabId}:`)) {
      dropRuntimeAgentPane(paneKey)
    }
  }
}

function emitAgentStatusClear(paneKey: string): void {
  for (const listener of agentStatusClearListeners) {
    listener({ paneKey })
  }
}

function inferRuntimeAgentInterrupt(request: AgentInterruptInferenceRequest): boolean {
  if (!parsePaneKey(request.paneKey) || !isAgentInterruptInputIntent(request.intent)) {
    return false
  }
  const binding = bindingsByPaneKey.get(request.paneKey)
  if (!binding) {
    return false
  }
  if (binding.agentType === 'droid' && request.intent === 'ctrl-c') {
    return false
  }
  if (
    (binding.agentType === 'opencode' || binding.agentType === 'copilot') &&
    request.intent === 'plain-escape' &&
    request.inputCount !== 2
  ) {
    return false
  }
  if (
    binding.state !== 'working' ||
    !equivalentInterruptAgentType(binding.agentType, request.baselineAgentType) ||
    binding.prompt !== request.baselinePrompt ||
    binding.receivedAt !== request.baselineUpdatedAt ||
    binding.stateStartedAt !== request.baselineStateStartedAt ||
    Date.now() - binding.receivedAt > AGENT_STATUS_STALE_AFTER_MS
  ) {
    return false
  }
  const now = Date.now()
  binding.state = 'done'
  binding.receivedAt = now
  binding.stateStartedAt = now
  binding.interrupted = true
  emitAgentStatus(binding)
  return true
}

function equivalentInterruptAgentType(
  actual: AgentType | undefined,
  baseline: AgentType | undefined
): boolean {
  return (
    (actual === 'unknown' ? undefined : actual) === (baseline === 'unknown' ? undefined : baseline)
  )
}

function toAgentStatusState(status: TauriRuntimeAgentSessionStatus): AgentStatusState {
  return status === 'starting' || status === 'running' ? 'working' : 'done'
}

function readAgentType(value: unknown): AgentType | null {
  return typeof value === 'string' && value.trim() ? (value.trim() as TuiAgent) : null
}

function readPrompt(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function readRuntimeTimestamp(value: unknown): number | null {
  if (typeof value !== 'string' || !value) {
    return null
  }
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function isRuntimeAgentSession(value: unknown): value is TauriRuntimeAgentSession {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const record = value as Record<string, unknown>
  return (
    typeof record.id === 'string' &&
    typeof record.status === 'string' &&
    ['starting', 'running', 'exited', 'failed', 'stopped'].includes(record.status)
  )
}
