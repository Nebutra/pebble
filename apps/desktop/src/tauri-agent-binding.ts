import type {
  AgentStatusIpcPayload,
  AgentStatusState,
  AgentType
} from '../../../packages/product-core/shared/agent-status-types'
import { makePaneKey } from '../../../packages/product-core/shared/stable-pane-id'
import {
  readAgentType,
  readPrompt,
  readRuntimeTimestamp,
  type TauriRuntimeAgentSession,
  type TauriRuntimeAgentSessionStatus
} from './tauri-agent-session-shape'

// Renderer-facing agent binding shape plus the runtime-session → binding
// mapping, split out of tauri-agent-status-api.ts. The existing-binding lookup
// is injected so this module stays free of the status module's binding maps.
export type RuntimeAgentBinding = {
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

type ExistingBindingLookup = (
  sessionId: string,
  paneKey: string
) => RuntimeAgentBinding | undefined

export function createBindingFromRuntimeSession(
  session: TauriRuntimeAgentSession,
  lookupExisting: ExistingBindingLookup
): RuntimeAgentBinding | null {
  const agentType = readAgentType(session.agentKind)
  if (!agentType) {
    return null
  }
  return createBindingFromSession(
    session,
    {
      agentType,
      tabId: session.tabId,
      leafId: session.leafId,
      launchToken: session.launchToken,
      prompt: readPrompt(session.prompt)
    },
    lookupExisting
  )
}

export function createBindingFromSession(
  session: TauriRuntimeAgentSession,
  metadata: {
    agentType: AgentType
    tabId?: string
    leafId?: string
    launchToken?: string
    prompt: string
  },
  lookupExisting: ExistingBindingLookup
): RuntimeAgentBinding | null {
  const paneIdentity = createPaneIdentity(metadata.tabId, metadata.leafId)
  if (!paneIdentity) {
    return null
  }
  const existing = lookupExisting(session.id, paneIdentity.paneKey)
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

export function toAgentStatusPayload(binding: RuntimeAgentBinding): AgentStatusIpcPayload {
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

export function toAgentStatusState(status: TauriRuntimeAgentSessionStatus): AgentStatusState {
  switch (status) {
    case 'starting':
    case 'running':
      return 'working'
    case 'failed':
      // Why: renderer AgentStatus has no "failed" state; failed runtime
      // sessions still need attention, so surface them as blocked.
      return 'blocked'
    case 'exited':
    case 'stopped':
      return 'done'
  }
}
