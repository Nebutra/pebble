import type {
  AutomationDispatchResult,
  AutomationPrecheckResult,
  AutomationRunStatus
} from '../../../src/shared/automations-types'

export type RuntimeAutomationPrecheckResult = {
  command?: string
  exitCode?: number | null
  timedOut?: boolean
  durationMs?: number
  stdout?: string
  stderr?: string
  stdoutTruncated?: boolean
  stderrTruncated?: boolean
  error?: string
  startedAt?: string
  completedAt?: string
}

// DispatchState mirrors Go's AutomationDispatchState: the renderer-reported
// dispatch outcome persisted onto a runtime automation run record.
export type RuntimeAutomationDispatchState = {
  status?: string
  workspaceId?: string
  workspaceDisplayName?: string
  terminalSessionId?: string
  terminalPaneKey?: string
  terminalPtyId?: string
  error?: string
  reportedAt?: string
}

// Body for POST /v1/automations/runs/{id}/dispatch-result. Field list must
// stay in lockstep with Go's AutomationDispatchResultRequest — the runtime
// decodes with DisallowUnknownFields.
export function toRuntimeDispatchResultRequest(
  result: AutomationDispatchResult
): Record<string, unknown> {
  const body: Record<string, unknown> = { status: result.status }
  if (result.workspaceId) {
    body.workspaceId = result.workspaceId
  }
  if (result.workspaceDisplayName) {
    body.workspaceDisplayName = result.workspaceDisplayName
  }
  if (result.terminalSessionId) {
    body.terminalSessionId = result.terminalSessionId
  }
  if (result.terminalPaneKey) {
    body.terminalPaneKey = result.terminalPaneKey
  }
  if (result.terminalPtyId) {
    body.terminalPtyId = result.terminalPtyId
  }
  if (result.error) {
    body.error = result.error
  }
  return body
}

const RENDERER_RUN_STATUSES: readonly AutomationRunStatus[] = [
  'pending',
  'dispatching',
  'dispatched',
  'completed',
  'skipped_precheck',
  'skipped_missed',
  'skipped_unavailable',
  'skipped_needs_interactive_auth',
  'dispatch_failed'
]

export function readDispatchRunStatus(value: string | undefined): AutomationRunStatus | null {
  return value && (RENDERER_RUN_STATUSES as readonly string[]).includes(value)
    ? (value as AutomationRunStatus)
    : null
}

// Converts the Go runtime's RFC3339 precheck timestamps into the renderer's
// millisecond-epoch AutomationPrecheckResult shape.
export function mapRuntimePrecheckResult(
  result: RuntimeAutomationPrecheckResult | null | undefined
): AutomationPrecheckResult | null {
  if (!result) {
    return null
  }
  const startedAt = dateMs(result.startedAt, Date.now())
  return {
    command: stringValue(result.command),
    exitCode: typeof result.exitCode === 'number' ? result.exitCode : null,
    timedOut: result.timedOut === true,
    durationMs: numberValue(result.durationMs, 0),
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
    stdoutTruncated: result.stdoutTruncated === true,
    stderrTruncated: result.stderrTruncated === true,
    error: stringValue(result.error) || null,
    startedAt,
    completedAt: dateMs(result.completedAt, startedAt)
  }
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function dateMs(value: string | undefined, fallback: number): number {
  const parsed = Date.parse(value ?? '')
  return Number.isFinite(parsed) ? parsed : fallback
}
