import type { AgentType } from '../../../packages/product-core/shared/agent-status-types'
import type { TuiAgent } from '../../../packages/product-core/shared/types'

// Runtime agent session shape and coercion helpers, shared by the agent-status
// API and the migration-unsupported subsystem.
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

export function readAgentType(value: unknown): AgentType | null {
  return typeof value === 'string' && value.trim() ? (value.trim() as TuiAgent) : null
}

export function readPrompt(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function readRuntimeTimestamp(value: unknown): number | null {
  if (typeof value !== 'string' || !value) {
    return null
  }
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

export function isRuntimeAgentSession(value: unknown): value is TauriRuntimeAgentSession {
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
