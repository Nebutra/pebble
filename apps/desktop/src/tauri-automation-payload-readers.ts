import type {
  Automation,
  AutomationExecutionTargetType,
  AutomationPrecheck,
  AutomationSchedulerOwner,
  AutomationWorkspaceMode
} from '../../../packages/product-core/shared/automations-types'
import { isTuiAgent } from '../../../packages/product-core/shared/tui-agent-config'
import type { TuiAgent } from '../../../packages/product-core/shared/types'

// Value coercion and stored-payload field readers, split out of
// tauri-automation-runtime-mapping.ts so the mapping module stays focused on
// assembling renderer-facing automation records.
export const AUTOMATION_PAYLOAD_KEY = 'pebbleAutomation'
export const DEFAULT_AUTOMATION_GRACE_MINUTES = 720

export type AutomationPayloadSnapshot = Pick<
  Automation,
  | 'name'
  | 'prompt'
  | 'precheck'
  | 'agentId'
  | 'runContext'
  | 'sourceContext'
  | 'projectId'
  | 'executionTargetType'
  | 'executionTargetId'
  | 'schedulerOwner'
  | 'workspaceMode'
  | 'workspaceId'
  | 'baseBranch'
  | 'setupDecision'
  | 'reuseSession'
  | 'timezone'
  | 'rrule'
  | 'dtstart'
  | 'enabled'
  | 'missedRunGraceMinutes'
>

export function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function nullableStringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export function numberValue(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

export function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

export function dateMs(value: string | undefined, fallback: number): number {
  const parsed = Date.parse(value ?? '')
  return Number.isFinite(parsed) ? parsed : fallback
}

export function normalizePrecheck(value: unknown): AutomationPrecheck | null {
  const record = objectValue(value)
  if (!record) {
    return null
  }
  const command = stringValue(record.command)
  if (!command) {
    return null
  }
  return {
    command,
    timeoutSeconds: Math.max(1, numberValue(record.timeoutSeconds, 60))
  }
}

export function readAutomationPayload(payload: Record<string, unknown>): Record<string, unknown> {
  return objectValue(payload[AUTOMATION_PAYLOAD_KEY]) ?? {}
}

export function readSetupDecision(
  workspaceMode: AutomationWorkspaceMode,
  value: unknown
): Automation['setupDecision'] {
  return workspaceMode === 'new_per_run' && (value === 'run' || value === 'skip')
    ? value
    : undefined
}

export function readTuiAgent(value: unknown): TuiAgent {
  return isTuiAgent(value) ? value : 'codex'
}

export function readWorkspaceMode(value: unknown): AutomationWorkspaceMode {
  return value === 'existing' ? 'existing' : 'new_per_run'
}

export function readExecutionTargetType(
  hostId: string | undefined
): AutomationExecutionTargetType {
  return hostId?.startsWith('ssh:') ? 'ssh' : 'local'
}

export function readStoredExecutionTargetType(
  value: unknown
): AutomationExecutionTargetType | null {
  return value === 'ssh' || value === 'local' ? value : null
}

export function readExecutionTargetId(hostId: string | undefined): string {
  return hostId?.startsWith('ssh:') ? hostId.slice('ssh:'.length) : 'local'
}

export function readSchedulerOwner(hostId: string | undefined): AutomationSchedulerOwner {
  if (hostId?.startsWith('runtime:')) {
    return 'remote_host_service'
  }
  return hostId?.startsWith('ssh:') ? 'ssh_bridge' : 'local_host_service'
}

export function readStoredSchedulerOwner(value: unknown): AutomationSchedulerOwner | null {
  if (value === 'local_host_service' || value === 'ssh_bridge' || value === 'remote_host_service') {
    return value
  }
  return null
}
