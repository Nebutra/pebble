import { nextAutomationOccurrenceAfter } from '../../../src/shared/automation-schedules'
import type {
  Automation,
  AutomationCreateInput,
  AutomationExecutionTargetType,
  AutomationPrecheck,
  AutomationRun,
  AutomationRunStatus,
  AutomationSchedulerOwner,
  AutomationUpdateInput,
  AutomationWorkspaceMode
} from '../../../src/shared/automations-types'
import { isTuiAgent } from '../../../src/shared/tui-agent-config'
import type { TuiAgent } from '../../../src/shared/types'

const AUTOMATION_PAYLOAD_KEY = 'pebbleAutomation'
const DEFAULT_AUTOMATION_GRACE_MINUTES = 720

export type RuntimeAutomationSchedule = {
  kind?: 'manual' | 'interval' | 'cron' | 'event'
  intervalSeconds?: number
  cron?: string
  timezone?: string
}

export type RuntimeAutomationAction = {
  kind: 'createTask' | 'sendMessage' | 'dispatchTask' | 'startAgentRun' | 'computerAction'
  payload?: Record<string, unknown>
}

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
  status?: 'queued' | 'completed' | 'failed'
  payload?: Record<string, unknown>
  taskId?: string
  messageId?: string
  dispatchId?: string
  agentRunId?: string
  computerActionId?: string
  error?: string
  createdAt?: string
  updatedAt?: string
}

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

export function toRuntimeCreateAutomationRequest(
  input: AutomationCreateInput
): Record<string, unknown> {
  const snapshot = snapshotFromCreateInput(input)
  return {
    name: snapshot.name,
    description: snapshot.prompt,
    enabled: snapshot.enabled,
    schedule: toRuntimeSchedule(snapshot),
    action: toRuntimeAction(snapshot)
  }
}

export function toRuntimeUpdateAutomationRequest(
  snapshot: AutomationPayloadSnapshot,
  updates: AutomationUpdateInput
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    action: toRuntimeAction(snapshot)
  }
  if (Object.hasOwn(updates, 'name')) {
    body.name = snapshot.name
  }
  if (Object.hasOwn(updates, 'prompt')) {
    body.description = snapshot.prompt
  }
  if (Object.hasOwn(updates, 'enabled')) {
    body.enabled = snapshot.enabled
  }
  if (
    Object.hasOwn(updates, 'timezone') ||
    Object.hasOwn(updates, 'rrule') ||
    Object.hasOwn(updates, 'dtstart') ||
    Object.hasOwn(updates, 'enabled')
  ) {
    body.schedule = toRuntimeSchedule(snapshot)
  }
  return body
}

export function mapRuntimeAutomation(runtime: RuntimeAutomation): Automation {
  const payload = runtime.action?.payload ?? {}
  const stored = readAutomationPayload(payload)
  const createdAt = dateMs(runtime.createdAt, Date.now())
  const updatedAt = dateMs(runtime.updatedAt, createdAt)
  const rrule = stringValue(stored.rrule) || stringValue(runtime.schedule?.cron)
  const dtstart = numberValue(stored.dtstart, createdAt)
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
  return {
    id: run.id,
    automationId: run.automationId,
    runContext: runContext ?? automation?.runContext ?? null,
    sourceContext: sourceContext ?? automation?.sourceContext ?? null,
    title: automation ? `${automation.name} run` : `Automation run ${run.id}`,
    scheduledFor: createdAt,
    status: mapRuntimeRunStatus(run.status),
    trigger: run.reason === 'schedule' ? 'scheduled' : 'manual',
    workspaceId: nullableStringValue(stored.workspaceId) ?? automation?.workspaceId ?? null,
    workspaceDisplayName: null,
    sessionKind: 'terminal',
    chatSessionId: null,
    terminalSessionId: null,
    terminalPaneKey: null,
    terminalPtyId: null,
    outputSnapshot: createRunOutputSnapshot(run, updatedAt),
    precheckResult: null,
    usage: null,
    error: stringValue(run.error) || null,
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

function snapshotFromCreateInput(input: AutomationCreateInput): AutomationPayloadSnapshot {
  const workspaceMode = input.workspaceMode
  return {
    name: input.name.trim() || 'Untitled automation',
    prompt: input.prompt,
    precheck: normalizePrecheck(input.precheck),
    agentId: input.agentId,
    runContext: input.runContext ?? null,
    sourceContext: input.sourceContext ?? null,
    projectId: input.projectId,
    executionTargetType: readExecutionTargetType(input.runContext?.hostId),
    executionTargetId: readExecutionTargetId(input.runContext?.hostId),
    schedulerOwner: readSchedulerOwner(input.runContext?.hostId),
    workspaceMode,
    workspaceId: workspaceMode === 'existing' ? (input.workspaceId ?? null) : null,
    baseBranch: workspaceMode === 'new_per_run' ? (input.baseBranch ?? null) : null,
    setupDecision: workspaceMode === 'new_per_run' ? input.setupDecision : undefined,
    reuseSession: workspaceMode === 'existing' ? (input.reuseSession ?? false) : false,
    timezone: input.timezone,
    rrule: input.rrule,
    dtstart: input.dtstart,
    enabled: input.enabled ?? true,
    missedRunGraceMinutes: input.missedRunGraceMinutes ?? DEFAULT_AUTOMATION_GRACE_MINUTES
  }
}

function toRuntimeSchedule(snapshot: AutomationPayloadSnapshot): RuntimeAutomationSchedule {
  // Why: Go runtime does not accept Pebble's RRULE/cron schedule yet, so the
  // canonical renderer schedule is preserved in the payload until native parity lands.
  return {
    kind: 'manual',
    timezone: snapshot.timezone
  }
}

function toRuntimeAction(snapshot: AutomationPayloadSnapshot): RuntimeAutomationAction {
  return {
    kind: 'createTask',
    payload: {
      title: snapshot.name,
      body: snapshot.prompt,
      assignee: snapshot.agentId,
      [AUTOMATION_PAYLOAD_KEY]: snapshot
    }
  }
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

function readSetupDecision(
  workspaceMode: AutomationWorkspaceMode,
  value: unknown
): Automation['setupDecision'] {
  return workspaceMode === 'new_per_run' && (value === 'run' || value === 'skip')
    ? value
    : undefined
}

function readAutomationPayload(payload: Record<string, unknown>): Record<string, unknown> {
  return objectValue(payload[AUTOMATION_PAYLOAD_KEY]) ?? {}
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

function createRunOutputSnapshot(
  run: RuntimeAutomationRun,
  capturedAt: number
): AutomationRun['outputSnapshot'] {
  const id = run.agentRunId ?? run.dispatchId ?? run.taskId ?? run.messageId ?? run.computerActionId
  if (!id || run.status !== 'completed') {
    return null
  }
  return {
    format: 'plain_text',
    content: `Runtime automation completed: ${id}`,
    capturedAt,
    truncated: false
  }
}

function mapRuntimeRunStatus(status: RuntimeAutomationRun['status']): AutomationRunStatus {
  if (status === 'completed') {
    return 'completed'
  }
  if (status === 'failed') {
    return 'dispatch_failed'
  }
  return 'pending'
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function nullableStringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function dateMs(value: string | undefined, fallback: number): number {
  const parsed = Date.parse(value ?? '')
  return Number.isFinite(parsed) ? parsed : fallback
}

function normalizePrecheck(value: unknown): AutomationPrecheck | null {
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

function readTuiAgent(value: unknown): TuiAgent {
  return isTuiAgent(value) ? value : 'codex'
}

function readWorkspaceMode(value: unknown): AutomationWorkspaceMode {
  return value === 'existing' ? 'existing' : 'new_per_run'
}

function readExecutionTargetType(hostId: string | undefined): AutomationExecutionTargetType {
  return hostId?.startsWith('ssh:') ? 'ssh' : 'local'
}

function readStoredExecutionTargetType(value: unknown): AutomationExecutionTargetType | null {
  return value === 'ssh' || value === 'local' ? value : null
}

function readExecutionTargetId(hostId: string | undefined): string {
  return hostId?.startsWith('ssh:') ? hostId.slice('ssh:'.length) : 'local'
}

function readSchedulerOwner(hostId: string | undefined): AutomationSchedulerOwner {
  if (hostId?.startsWith('runtime:')) {
    return 'remote_host_service'
  }
  return hostId?.startsWith('ssh:') ? 'ssh_bridge' : 'local_host_service'
}

function readStoredSchedulerOwner(value: unknown): AutomationSchedulerOwner | null {
  if (
    value === 'local_host_service' ||
    value === 'ssh_bridge' ||
    value === 'remote_host_service'
  ) {
    return value
  }
  return null
}
