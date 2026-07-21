import type { PreloadApi } from '../../../packages/product-core/shared/preload-api-types'
import type { AgentInterruptInferenceRequest } from '../../../packages/product-core/shared/agent-interrupt-intent'
import { isAgentInterruptInputIntent } from '../../../packages/product-core/shared/agent-interrupt-intent'
import type {
  AgentStatusIpcPayload,
  AgentType
} from '../../../packages/product-core/shared/agent-status-types'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../packages/product-core/shared/agent-status-types'
import { parsePaneKey } from '../../../packages/product-core/shared/stable-pane-id'
import { createRuntimeResourceGetCommand, getRuntimeResourceJson } from './runtime-bridge'
import {
  isRuntimeAgentSession,
  readAgentType,
  readPrompt,
  readRuntimeTimestamp,
  type TauriRuntimeAgentSession
} from './tauri-agent-session-shape'
import {
  createBindingFromRuntimeSession,
  createBindingFromSession,
  toAgentStatusPayload,
  toAgentStatusState,
  type RuntimeAgentBinding
} from './tauri-agent-binding'
import {
  clearMigrationUnsupportedForPane,
  clearMigrationUnsupportedForTab,
  hydrateMigrationUnsupportedSnapshot,
  listMigrationUnsupportedEntries,
  recordMigrationUnsupportedSession,
  subscribeMigrationUnsupported,
  subscribeMigrationUnsupportedClear
} from './tauri-agent-migration-unsupported'

export type {
  TauriRuntimeAgentSession,
  TauriRuntimeAgentSessionStatus
} from './tauri-agent-session-shape'

type PtySpawnOptions = Parameters<PreloadApi['pty']['spawn']>[0]

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
    onMigrationUnsupported: (callback) => subscribeMigrationUnsupported(callback),
    onMigrationUnsupportedClear: (callback) => subscribeMigrationUnsupportedClear(callback),
    getMigrationUnsupportedSnapshot: async () => {
      await hydrateMigrationUnsupportedSnapshot()
      return listMigrationUnsupportedEntries()
    },
    drop: (paneKey) => {
      dropRuntimeAgentPane(paneKey)
    },
    dropByTabPrefix: (tabId) => {
      dropRuntimeAgentTab(tabId)
    }
  } satisfies PreloadApi['agentStatus']
  void hydrateMigrationUnsupportedSnapshot()
}
export function recordRuntimeAgentSessionSpawn(args: {
  session: TauriRuntimeAgentSession
  spawnOptions: PtySpawnOptions
}): void {
  const agentType = readAgentType(args.spawnOptions.launchAgent ?? args.session.agentKind)
  if (!agentType) {
    return
  }
  const binding = createBindingFromSession(
    args.session,
    {
      agentType,
      tabId: args.spawnOptions.tabId,
      leafId: args.spawnOptions.leafId,
      launchToken: args.spawnOptions.launchToken,
      prompt: readPrompt(args.session.prompt)
    },
    lookupExistingBinding
  )
  if (!binding) {
    recordMigrationUnsupportedSession(
      args.session,
      args.spawnOptions.connectionId ? 'ssh' : 'local'
    )
    return
  }
  rememberBinding(binding)
  emitAgentStatus(binding)
}

export function emitRuntimeAgentSessionStatus(session: TauriRuntimeAgentSession): void {
  const binding =
    bindingsBySessionId.get(session.id) ??
    createBindingFromRuntimeSession(session, lookupExistingBinding)
  if (!binding) {
    recordMigrationUnsupportedSession(session, 'local')
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

function lookupExistingBinding(
  sessionId: string,
  paneKey: string
): RuntimeAgentBinding | undefined {
  return bindingsBySessionId.get(sessionId) ?? bindingsByPaneKey.get(paneKey)
}

async function hydrateRuntimeAgentSessionSnapshot(): Promise<void> {
  const sessions = await listRuntimeSessions()
  for (const session of sessions) {
    const binding = createBindingFromRuntimeSession(session, lookupExistingBinding)
    if (!binding) {
      recordMigrationUnsupportedSession(session, 'local')
      continue
    }
    rememberBinding(binding)
  }
}

async function listRuntimeSessions(): Promise<TauriRuntimeAgentSession[]> {
  const result = await getRuntimeResourceJson(
    createRuntimeResourceGetCommand({ path: '/v1/sessions', timeoutMs: 1500 })
  )
  if (result.transport !== 'connected') {
    throw new Error(result.error ?? `Runtime transport failed: ${result.transport}`)
  }
  if (result.httpStatus !== null && (result.httpStatus < 200 || result.httpStatus > 299)) {
    throw new Error(result.body ?? `Runtime request failed with HTTP ${result.httpStatus}`)
  }
  if (!result.body) {
    throw new Error('Runtime returned an empty session response.')
  }
  const parsed = JSON.parse(result.body)
  return Array.isArray(parsed) ? parsed.filter(isRuntimeAgentSession) : []
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

function dropRuntimeAgentPane(paneKey: string): void {
  clearMigrationUnsupportedForPane(paneKey)
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
  clearMigrationUnsupportedForTab(tabId)
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
