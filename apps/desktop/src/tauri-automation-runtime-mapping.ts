import { nextAutomationOccurrenceAfter } from '../../../packages/product-core/shared/automation-schedules'
import type {
  Automation,
  AutomationRun,
  AutomationRunStatus,
  AutomationUpdateInput
} from '../../../packages/product-core/shared/automations-types'
import {
  mapRuntimeOutputSnapshot,
  mapRuntimePrecheckResult,
  readDispatchRunStatus,
  type RuntimeAutomationDispatchState,
  type RuntimeAutomationPrecheckResult
} from './tauri-automation-run-result-mapping'
import {
  AUTOMATION_PAYLOAD_KEY,
  DEFAULT_AUTOMATION_GRACE_MINUTES,
  booleanValue,
  dateMs,
  normalizePrecheck,
  numberValue,
  nullableStringValue,
  objectValue,
  readAutomationPayload,
  readExecutionTargetId,
  readExecutionTargetType,
  readSchedulerOwner,
  readSetupDecision,
  readStoredExecutionTargetType,
  readStoredSchedulerOwner,
  readTuiAgent,
  readWorkspaceMode,
  stringValue,
  type AutomationPayloadSnapshot
} from './tauri-automation-payload-readers'
import type {
  RuntimeAutomationAction,
  RuntimeAutomationSchedule
} from './tauri-automation-runtime-request'

export type { AutomationPayloadSnapshot } from './tauri-automation-payload-readers'
export type {
  RuntimeAutomationAction,
  RuntimeAutomationSchedule
} from './tauri-automation-runtime-request'
export {
  toRuntimeCreateAutomationRequest,
  toRuntimeUpdateAutomationRequest
} from './tauri-automation-runtime-request'

export type RuntimeAutomation = {
  id: string
  name: string
  description?: string
  enabled?: boolean
  schedule?: RuntimeAutomationSchedule
  action?: RuntimeAutomationAction
  lastTriggeredAt?: string
  nextRunAt?: string
  createdAt?: string
  updatedAt?: string
}
export type RuntimeAutomationRun = {
  id: string
  automationId: string
  reason?: 'manual' | 'schedule' | 'event'
  status?: 'queued' | 'completed' | 'failed' | 'skipped_precheck' | 'skipped_missed'
  payload?: Record<string, unknown>
  taskId?: string
  messageId?: string
  dispatchId?: string
  agentRunId?: string
  computerActionId?: string
  precheckResult?: RuntimeAutomationPrecheckResult | null
  dispatchState?: RuntimeAutomationDispatchState | null
  error?: string
  createdAt?: string
  updatedAt?: string
}

export function mapRuntimeAutomation(runtime: RuntimeAutomation): Automation {
  const payload = runtime.action?.payload ?? {}
  const stored = readAutomationPayload(payload)
  const createdAt = dateMs(runtime.createdAt, Date.now())
  const updatedAt = dateMs(runtime.updatedAt, createdAt)
  const rrule =
    stringValue(runtime.schedule?.rrule) ||
    stringValue(stored.rrule) ||
    stringValue(runtime.schedule?.cron)
  const dtstart = dateMs(runtime.schedule?.dtstart, numberValue(stored.dtstart, createdAt))
  const enabled = runtime.enabled !== false && booleanValue(stored.enabled, true)
  return {
    id: runtime.id,
    ...snapshotWithDefaults(runtime, stored, { createdAt, updatedAt, rrule, dtstart, enabled }),
    createdAt,
    updatedAt,
    nextRunAt: readNextRunAt(runtime, { rrule, dtstart, enabled }),
    lastRunAt: dateMs(runtime.lastTriggeredAt, 0) || undefined,
    missedRunPolicy: 'run_once_within_grace'
  }
}

export function mapRuntimeAutomationRun(
  run: RuntimeAutomationRun,
  runtimeAutomation?: RuntimeAutomation
): AutomationRun {
  const automation = runtimeAutomation ? mapRuntimeAutomation(runtimeAutomation) : null
  const stored = readAutomationPayload(run.payload ?? runtimeAutomation?.action?.payload ?? {})
  const createdAt = dateMs(run.createdAt, Date.now())
  const updatedAt = dateMs(run.updatedAt, createdAt)
  const runContext = objectValue(stored.runContext) as Automation['runContext']
  const sourceContext = objectValue(stored.sourceContext) as Automation['sourceContext']
  // The renderer-reported dispatch outcome (workspace/session identity,
  // final status) is authoritative over the runtime's coarser native status.
  const dispatch = run.dispatchState ?? null
  return {
    id: run.id,
    automationId: run.automationId,
    runContext: runContext ?? automation?.runContext ?? null,
    sourceContext: sourceContext ?? automation?.sourceContext ?? null,
    title: automation ? `${automation.name} run` : `Automation run ${run.id}`,
    scheduledFor: createdAt,
    status: readDispatchRunStatus(dispatch?.status) ?? mapRuntimeRunStatus(run.status),
    trigger: run.reason === 'schedule' ? 'scheduled' : 'manual',
    workspaceId:
      nullableStringValue(dispatch?.workspaceId) ??
      nullableStringValue(stored.workspaceId) ??
      automation?.workspaceId ??
      null,
    workspaceDisplayName: nullableStringValue(dispatch?.workspaceDisplayName),
    sessionKind: 'terminal',
    chatSessionId: null,
    terminalSessionId: nullableStringValue(dispatch?.terminalSessionId),
    terminalPaneKey: nullableStringValue(dispatch?.terminalPaneKey),
    terminalPtyId: nullableStringValue(dispatch?.terminalPtyId),
    // Only the native run record is authoritative after restart; never
    // synthesize user-visible output from an unrelated task/session ID.
    outputSnapshot: mapRuntimeOutputSnapshot(dispatch?.outputSnapshot),
    precheckResult: mapRuntimePrecheckResult(run.precheckResult),
    usage: null,
    error: nullableStringValue(dispatch?.error) ?? (stringValue(run.error) || null),
    startedAt: createdAt,
    dispatchedAt: updatedAt,
    createdAt
  }
}

export function toAutomationPayloadSnapshot(automation: Automation): AutomationPayloadSnapshot {
  return {
    name: automation.name,
    prompt: automation.prompt,
    precheck: automation.precheck,
    agentId: automation.agentId,
    runContext: automation.runContext ?? null,
    sourceContext: automation.sourceContext ?? null,
    projectId: automation.projectId,
    executionTargetType: automation.executionTargetType,
    executionTargetId: automation.executionTargetId,
    schedulerOwner: automation.schedulerOwner,
    workspaceMode: automation.workspaceMode,
    workspaceId: automation.workspaceId,
    baseBranch: automation.baseBranch,
    setupDecision: automation.setupDecision,
    reuseSession: automation.reuseSession,
    timezone: automation.timezone,
    rrule: automation.rrule,
    dtstart: automation.dtstart,
    enabled: automation.enabled,
    missedRunGraceMinutes: automation.missedRunGraceMinutes
  }
}

export function applyAutomationUpdates(
  current: AutomationPayloadSnapshot,
  updates: AutomationUpdateInput
): AutomationPayloadSnapshot {
  const next = { ...current }
  for (const key of Object.keys(updates) as (keyof AutomationUpdateInput)[]) {
    ;(next as Record<string, unknown>)[key] = updates[key]
  }
  if (next.workspaceMode !== 'existing') {
    next.workspaceId = null
    next.reuseSession = false
  }
  if (next.workspaceMode !== 'new_per_run') {
    next.baseBranch = null
    next.setupDecision = undefined
  }
  next.name = next.name.trim() || 'Untitled automation'
  next.precheck = normalizePrecheck(next.precheck)
  return next
}

function snapshotWithDefaults(
  runtime: RuntimeAutomation,
  stored: Record<string, unknown>,
  values: {
    createdAt: number
    updatedAt: number
    rrule: string
    dtstart: number
    enabled: boolean
  }
): AutomationPayloadSnapshot {
  const workspaceMode = readWorkspaceMode(stored.workspaceMode)
  const hostId = stringValue(objectValue(stored.runContext)?.hostId)
  return {
    name: stringValue(stored.name) || runtime.name || 'Untitled automation',
    prompt: stringValue(stored.prompt) || runtime.description || '',
    precheck: normalizePrecheck(stored.precheck),
    agentId: readTuiAgent(stored.agentId),
    runContext: objectValue(stored.runContext) as Automation['runContext'],
    sourceContext: objectValue(stored.sourceContext) as Automation['sourceContext'],
    projectId: stringValue(stored.projectId),
    executionTargetType:
      readStoredExecutionTargetType(stored.executionTargetType) ?? readExecutionTargetType(hostId),
    executionTargetId: stringValue(stored.executionTargetId) || readExecutionTargetId(hostId),
    schedulerOwner: readStoredSchedulerOwner(stored.schedulerOwner) ?? readSchedulerOwner(hostId),
    workspaceMode,
    workspaceId: workspaceMode === 'existing' ? nullableStringValue(stored.workspaceId) : null,
    baseBranch: workspaceMode === 'new_per_run' ? nullableStringValue(stored.baseBranch) : null,
    setupDecision: readSetupDecision(workspaceMode, stored.setupDecision),
    reuseSession: workspaceMode === 'existing' && stored.reuseSession === true,
    timezone: stringValue(stored.timezone) || runtime.schedule?.timezone || 'UTC',
    rrule: values.rrule,
    dtstart: values.dtstart,
    enabled: values.enabled,
    missedRunGraceMinutes: numberValue(
      stored.missedRunGraceMinutes,
      DEFAULT_AUTOMATION_GRACE_MINUTES
    )
  }
}

function readNextRunAt(
  runtime: RuntimeAutomation,
  schedule: { rrule: string; dtstart: number; enabled: boolean }
): number {
  const runtimeNextRunAt = dateMs(runtime.nextRunAt, 0)
  if (runtimeNextRunAt > 0) {
    return runtimeNextRunAt
  }
  if (!schedule.enabled || !schedule.rrule) {
    return 0
  }
  return nextAutomationOccurrenceAfter(schedule.rrule, schedule.dtstart, Date.now()) ?? 0
}

function mapRuntimeRunStatus(status: RuntimeAutomationRun['status']): AutomationRunStatus {
  if (status === 'completed') {
    return 'completed'
  }
  if (status === 'failed') {
    return 'dispatch_failed'
  }
  if (status === 'skipped_precheck') {
    return 'skipped_precheck'
  }
  if (status === 'skipped_missed') {
    return 'skipped_missed'
  }
  return 'pending'
}

// True when the runtime payload carries the desktop shell's automation
// envelope, i.e. the automation was authored in the renderer and its real
// work (agent terminal session) must be performed by a renderer dispatch.
export function hasRendererAutomationSnapshot(
  payload: Record<string, unknown> | undefined
): boolean {
  return Boolean(payload && objectValue(payload[AUTOMATION_PAYLOAD_KEY]))
}
