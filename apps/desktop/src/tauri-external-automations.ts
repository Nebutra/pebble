import { invoke } from '@tauri-apps/api/core'
import type { PreloadApi } from '../../../packages/product-core/shared/preload-api-types'
import type {
  ExternalAutomationManager,
  ExternalAutomationRunsPage
} from '../../../packages/product-core/shared/automations-types'
import type { SshTarget } from '../../../packages/product-core/shared/ssh-types'
import {
  mapHermesJobs,
  mapOpenClawJobs
} from '../../../packages/product-core/shared/external-automation-job-mappers'
import { requestRuntimeJson } from './pebble-tauri-runtime-transport'
import { recordValue, stringValue } from './tauri-automation-value-coercion'

type LocalExternalAutomationSource = {
  provider: 'hermes' | 'openclaw'
  commandAvailable: boolean
  jobs: unknown
  error: string | null
}

// External automation managers (Hermes/OpenClaw, local and SSH), split out of
// tauri-automations-api.ts so that module stays focused on the native Go-runtime
// automation CRUD.
export async function listTauriExternalAutomationManagers(): Promise<ExternalAutomationManager[]> {
  const [sources, targets] = await Promise.all([
    invoke<LocalExternalAutomationSource[]>('external_automations_list_local'),
    requestRuntimeJson<SshTarget[]>('/v1/ssh-targets', { method: 'GET', timeoutMs: 5000 })
  ])
  const localManagers = sources
    .filter((source) => source.commandAvailable || source.error || hasExternalJobs(source.jobs))
    .map((source) => {
      const managerId = `${source.provider}:local`
      const label = source.provider === 'hermes' ? 'Hermes' : 'OpenClaw'
      return {
        id: managerId,
        provider: source.provider,
        label: `${label} on this computer`,
        targetLabel: 'this computer',
        target: { type: 'local' as const },
        status: source.error ? ('unavailable' as const) : ('available' as const),
        error:
          source.error ??
          (source.commandAvailable
            ? null
            : `${label} jobs were found, but the CLI is not on PATH.`),
        canManage: !source.error && source.commandAvailable,
        jobs:
          source.provider === 'hermes'
            ? mapHermesJobs(managerId, source.jobs)
            : mapOpenClawJobs(managerId, source.jobs)
      }
    })
  const remoteManagers = await Promise.all(
    targets
      .filter((target) => !target.owner)
      .flatMap((target) => [
        listTauriRemoteExternalAutomationManager(target, 'hermes'),
        listTauriRemoteExternalAutomationManager(target, 'openclaw')
      ])
  )
  return [...localManagers, ...remoteManagers]
}

async function listTauriRemoteExternalAutomationManager(
  target: SshTarget,
  provider: 'hermes' | 'openclaw'
): Promise<ExternalAutomationManager> {
  const label = provider === 'hermes' ? 'Hermes' : 'OpenClaw'
  const managerId = `${provider}:ssh:${target.id}`
  try {
    const source = await requestRemoteExternalAutomation(target.id, { provider, operation: 'list' })
    const error = stringValue(source.error) || null
    const commandAvailable = source.commandAvailable === true
    return {
      id: managerId,
      provider,
      label: `${label} on ${target.label}`,
      targetLabel: target.label,
      target: { type: 'ssh', connectionId: target.id },
      status: error ? 'unavailable' : 'available',
      error: error ?? (commandAvailable ? null : `${label} CLI is not on the remote PATH.`),
      canManage: !error && commandAvailable,
      jobs:
        provider === 'hermes'
          ? mapHermesJobs(managerId, source.jobs)
          : mapOpenClawJobs(managerId, source.jobs)
    }
  } catch (error) {
    return {
      id: managerId,
      provider,
      label: `${label} on ${target.label}`,
      targetLabel: target.label,
      target: { type: 'ssh', connectionId: target.id },
      status: 'unavailable',
      error: error instanceof Error ? error.message : String(error),
      canManage: false,
      jobs: []
    }
  }
}

function requestRemoteExternalAutomation(
  targetId: string,
  body: Record<string, unknown>
): Promise<Record<string, unknown>> {
  return requestRuntimeJson<Record<string, unknown>>(
    `/v1/ssh-targets/${encodeURIComponent(targetId)}/external-automations`,
    { method: 'POST', body: { version: 1, ...body }, timeoutMs: 50_000 }
  )
}

function hasExternalJobs(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.length > 0
  }
  return Boolean(
    value &&
    typeof value === 'object' &&
    Array.isArray((value as { jobs?: unknown }).jobs) &&
    (value as { jobs: unknown[] }).jobs.length > 0
  )
}

export async function mutateTauriExternalAutomation(
  operation: 'create' | 'update' | 'action',
  input: Record<string, unknown>
): Promise<void> {
  const target = recordValue(input.target)
  if (target?.type === 'ssh') {
    const connectionId = stringValue(target.connectionId)
    if (!connectionId) {
      throw new Error('Remote external automation target is missing its connection ID.')
    }
    await requestRemoteExternalAutomation(connectionId, {
      operation,
      provider: input.provider,
      jobId: input.jobId,
      action: input.action,
      name: input.name,
      prompt: input.prompt,
      schedule: input.schedule,
      workdir: input.workdir
    })
    return
  }
  if (target?.type !== 'local') {
    throw new Error('Invalid external automation target.')
  }
  await invoke('external_automations_mutate_local', {
    input: {
      operation,
      provider: input.provider,
      jobId: input.jobId,
      action: input.action,
      name: input.name,
      prompt: input.prompt,
      schedule: input.schedule,
      workdir: input.workdir
    }
  })
}

export async function listTauriExternalAutomationRuns(
  input: Parameters<PreloadApi['automations']['listExternalRuns']>[0]
): Promise<ExternalAutomationRunsPage> {
  if (input.provider !== 'hermes' || input.target.type !== 'local') {
    if (input.provider !== 'hermes' || input.target.type !== 'ssh') {
      return { ...input, total: 0, runs: [] }
    }
    const result = await requestRemoteExternalAutomation(input.target.connectionId, {
      provider: input.provider,
      operation: 'runs',
      jobId: input.jobId,
      page: input.page,
      pageSize: input.pageSize
    })
    const runs = Array.isArray(result.runs) ? result.runs : []
    return {
      ...input,
      total: typeof result.total === 'number' ? result.total : 0,
      runs: mapHermesJobs(input.managerId, [{ id: input.jobId, runs }])[0]?.runs ?? []
    }
  }
  const result = await invoke<{ total: number; runs: unknown[] }>(
    'external_automations_list_local_runs',
    { input: { jobId: input.jobId, page: input.page, pageSize: input.pageSize } }
  )
  return {
    ...input,
    total: result.total,
    runs: mapHermesJobs(input.managerId, [{ id: input.jobId, runs: result.runs }])[0]?.runs ?? []
  }
}
