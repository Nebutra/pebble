import type { PreloadApi } from '../../../src/preload/api-types'
import type {
  Automation,
  AutomationCreateInput,
  AutomationDispatchResult,
  AutomationPrecheckResult,
  ExternalAutomationManager,
  AutomationRun,
  AutomationUpdateInput,
  ExternalAutomationRunsPage
} from '../../../src/shared/automations-types'
import { requestRuntimeJson } from './pebble-tauri-runtime-transport'
import { onTauriAutomationDispatchRequested } from './tauri-automation-dispatch-events'
import { toRuntimeDispatchResultRequest } from './tauri-automation-run-result-mapping'
import {
  applyAutomationUpdates,
  mapRuntimeAutomation,
  mapRuntimeAutomationRun,
  toAutomationPayloadSnapshot,
  toRuntimeCreateAutomationRequest,
  toRuntimeUpdateAutomationRequest,
  type RuntimeAutomation,
  type RuntimeAutomationRun
} from './tauri-automation-runtime-mapping'

type TauriAutomationRpcResult =
  | { handled: false }
  | { handled: true; result: unknown }

const TAURI_EXTERNAL_AUTOMATION_UNAVAILABLE =
  'External automation managers require the Tauri external automation adapter.'

export function createPebbleAutomationsApi(
  base: PreloadApi['automations']
): PreloadApi['automations'] {
  return {
    ...base,
    list: () => listTauriAutomations(),
    listRuns: ({ automationId } = {}) => listTauriAutomationRuns(automationId),
    listExternalManagers: () => Promise.resolve(getTauriExternalAutomationManagers()),
    listExternalRuns: async (input) => createEmptyExternalRunsPage(input),
    createExternal: rejectExternalAutomationOperation,
    updateExternal: rejectExternalAutomationOperation,
    runExternalAction: rejectExternalAutomationOperation,
    create: (input) => createTauriAutomation(input),
    update: ({ id, updates }) => updateTauriAutomation(id, updates),
    delete: async ({ id }) => {
      await deleteTauriAutomation(id)
    },
    runNow: ({ id }) => runTauriAutomationNow(id),
    // Why: the Go runtime already executed the precheck when the schedule
    // fired; returning the recorded result keeps the renderer's dispatch gate
    // consistent with the native gate instead of re-running the command.
    runPrecheck: ({ automationId, runId }) => readTauriAutomationPrecheckResult(automationId, runId),
    // Why: the renderer performs the actual dispatch work (workspace, agent
    // terminal), so its reported outcome must be written back onto the Go run
    // record — Electron markDispatchResult parity, not just a read-back.
    markDispatchResult: (result) => writeTauriAutomationDispatchResult(result),
    snapshotWorkspaceName: async () => 0,
    rendererReady: async () => undefined,
    onDispatchRequested: (callback) => onTauriAutomationDispatchRequested(callback)
  }
}

function getTauriExternalAutomationManagers(): ExternalAutomationManager[] {
  // Why: returning [] makes a missing adapter look like a clean empty state.
  // Surface an unavailable source so the renderer disables actions explicitly.
  return [
    {
      id: 'tauri-hermes-local-unavailable',
      provider: 'hermes',
      label: 'Hermes',
      targetLabel: 'Local',
      target: { type: 'local' },
      status: 'unavailable',
      error: TAURI_EXTERNAL_AUTOMATION_UNAVAILABLE,
      canManage: false,
      jobs: []
    },
    {
      id: 'tauri-openclaw-local-unavailable',
      provider: 'openclaw',
      label: 'OpenClaw',
      targetLabel: 'Local',
      target: { type: 'local' },
      status: 'unavailable',
      error: TAURI_EXTERNAL_AUTOMATION_UNAVAILABLE,
      canManage: false,
      jobs: []
    }
  ]
}

export async function callTauriAutomationRuntimeRpc(
  method: string,
  params?: unknown
): Promise<TauriAutomationRpcResult> {
  switch (method) {
    case 'automation.list':
      return { handled: true, result: { automations: await listTauriAutomations() } }
    case 'automation.runs':
      return {
        handled: true,
        result: { runs: await listTauriAutomationRuns(readAutomationId(params)) }
      }
    case 'automation.create':
      return {
        handled: true,
        result: { automation: await createTauriAutomation(toCreateInput(params)) }
      }
    case 'automation.update':
      return { handled: true, result: await updateTauriAutomationRpc(params) }
    case 'automation.delete':
      await deleteTauriAutomation(requireAutomationId(params))
      return { handled: true, result: { removed: true } }
    case 'automation.runNow':
      return {
        handled: true,
        result: { run: await runTauriAutomationNow(requireAutomationId(params)) }
      }
    default:
      return { handled: false }
  }
}

async function listTauriAutomations(): Promise<Automation[]> {
  return (await readRuntimeAutomations()).map(mapRuntimeAutomation)
}

async function listTauriAutomationRuns(automationId?: string): Promise<AutomationRun[]> {
  const automations = await readRuntimeAutomations()
  const automationById = new Map(automations.map((automation) => [automation.id, automation]))
  const query = automationId ? `?automationId=${encodeURIComponent(automationId)}` : ''
  const runs = await requestRuntimeJson<RuntimeAutomationRun[]>(`/v1/automations/runs${query}`, {
    method: 'GET',
    timeoutMs: 5000
  })
  return runs.map((run) => mapRuntimeAutomationRun(run, automationById.get(run.automationId)))
}

async function createTauriAutomation(input: AutomationCreateInput): Promise<Automation> {
  const response = await requestRuntimeJson<RuntimeAutomation>('/v1/automations', {
    method: 'POST',
    body: toRuntimeCreateAutomationRequest(input),
    timeoutMs: 5000
  })
  return mapRuntimeAutomation(response)
}

async function updateTauriAutomation(
  id: string,
  updates: AutomationUpdateInput
): Promise<Automation> {
  const current = mapRuntimeAutomation(await readRuntimeAutomation(id))
  const merged = applyAutomationUpdates(toAutomationPayloadSnapshot(current), updates)
  const response = await requestRuntimeJson<RuntimeAutomation>(
    `/v1/automations/${encodeURIComponent(id)}`,
    {
      method: 'PATCH',
      body: toRuntimeUpdateAutomationRequest(merged, updates),
      timeoutMs: 5000
    }
  )
  return mapRuntimeAutomation(response)
}

async function updateTauriAutomationRpc(params: unknown): Promise<{ automation: Automation }> {
  const record = requireRecord(params)
  const id = stringValue(record.id)
  if (!id) {
    throw new Error('Missing automation id')
  }
  return {
    automation: await updateTauriAutomation(
      id,
      recordValue(record.updates) as AutomationUpdateInput
    )
  }
}

async function deleteTauriAutomation(id: string): Promise<void> {
  await requestRuntimeJson<RuntimeAutomation>(`/v1/automations/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    timeoutMs: 5000
  })
}

async function runTauriAutomationNow(id: string): Promise<AutomationRun> {
  const [run, automation] = await Promise.all([
    requestRuntimeJson<RuntimeAutomationRun>(`/v1/automations/${encodeURIComponent(id)}/runs`, {
      method: 'POST',
      body: { reason: 'manual' },
      timeoutMs: 15_000
    }),
    readRuntimeAutomation(id)
  ])
  return mapRuntimeAutomationRun(run, automation)
}

async function readTauriAutomationPrecheckResult(
  automationId: string,
  runId: string
): Promise<AutomationPrecheckResult | null> {
  const runs = await listTauriAutomationRuns(automationId)
  return runs.find((entry) => entry.id === runId)?.precheckResult ?? null
}

async function writeTauriAutomationDispatchResult(
  result: AutomationDispatchResult
): Promise<AutomationRun> {
  const run = await requestRuntimeJson<RuntimeAutomationRun>(
    `/v1/automations/runs/${encodeURIComponent(result.runId)}/dispatch-result`,
    {
      method: 'POST',
      body: toRuntimeDispatchResultRequest(result),
      timeoutMs: 5000
    }
  )
  const automations = await readRuntimeAutomations()
  return mapRuntimeAutomationRun(
    run,
    automations.find((automation) => automation.id === run.automationId)
  )
}

async function readRuntimeAutomations(): Promise<RuntimeAutomation[]> {
  return requestRuntimeJson<RuntimeAutomation[]>('/v1/automations', {
    method: 'GET',
    timeoutMs: 5000
  })
}

async function readRuntimeAutomation(id: string): Promise<RuntimeAutomation> {
  const automation = (await readRuntimeAutomations()).find((entry) => entry.id === id)
  if (!automation) {
    throw new Error('Automation not found.')
  }
  return automation
}

function createEmptyExternalRunsPage(
  input: Parameters<PreloadApi['automations']['listExternalRuns']>[0]
): ExternalAutomationRunsPage {
  return {
    ...input,
    total: 0,
    runs: []
  }
}

function rejectExternalAutomationOperation(): Promise<void> {
  return Promise.reject(new Error(TAURI_EXTERNAL_AUTOMATION_UNAVAILABLE))
}

function toCreateInput(params: unknown): AutomationCreateInput {
  return requireRecord(params) as AutomationCreateInput
}

function requireAutomationId(params: unknown): string {
  const id = readAutomationId(params)
  if (!id) {
    throw new Error('Missing automation id')
  }
  return id
}

function readAutomationId(params: unknown): string | undefined {
  return stringValue(recordValue(params)?.automationId) || stringValue(recordValue(params)?.id)
}

function requireRecord(value: unknown): Record<string, unknown> {
  const record = recordValue(value)
  if (!record) {
    throw new Error('Expected object input')
  }
  return record
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}
