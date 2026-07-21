import type {
  AutomationCreateInput,
  AutomationUpdateInput
} from '../../../packages/product-core/shared/automations-types'
import {
  AUTOMATION_PAYLOAD_KEY,
  DEFAULT_AUTOMATION_GRACE_MINUTES,
  normalizePrecheck,
  readExecutionTargetId,
  readExecutionTargetType,
  readSchedulerOwner,
  type AutomationPayloadSnapshot
} from './tauri-automation-payload-readers'

export type RuntimeAutomationSchedule = {
  kind?: 'manual' | 'interval' | 'cron' | 'event' | 'rrule'
  intervalSeconds?: number
  cron?: string
  timezone?: string
  rrule?: string
  dtstart?: string
}

export type RuntimeAutomationAction = {
  kind: 'createTask' | 'sendMessage' | 'dispatchTask' | 'startAgentRun' | 'computerAction'
  payload?: Record<string, unknown>
}

// Renderer→runtime request builders, split out of
// tauri-automation-runtime-mapping.ts.
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
  // Go owns recurrence evaluation; keep the renderer payload copy only for
  // round-trip fields that are not part of the runtime schedule contract.
  if (snapshot.rrule.trim()) {
    return {
      kind: 'rrule',
      timezone: snapshot.timezone,
      rrule: snapshot.rrule,
      dtstart: new Date(snapshot.dtstart).toISOString()
    }
  }
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
