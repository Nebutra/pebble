import { invoke } from '@tauri-apps/api/core'
import type { PreloadApi } from '../../../packages/product-core/shared/preload-api-types'
import type { EphemeralVmRuntimeRecord } from '../../../packages/product-core/shared/ephemeral-vm-runtimes'
import type { EphemeralVmRecipeConnection } from '../../../packages/product-core/shared/ephemeral-vm-recipes'
import type { PublicKnownRuntimeEnvironment } from '../../../packages/product-core/shared/runtime-environments'
import { ensurePebbleRuntimeProcess, requestRuntimeJson } from './pebble-tauri-runtime-transport'
import { subscribeRuntimeEventPush } from './tauri-runtime-event-push'

type NativeProvisionResult =
  | {
      ok: true
      connectionType: 'pebble-server' | 'ssh'
      runtime: EphemeralVmRuntimeRecord
      connection: EphemeralVmRecipeConnection
      stderr: string
      warnings: []
    }
  | { ok: false; error: string; stdout: string; stderr: string }

const provisionListeners = new Set<
  (event: { provisionId: string; stream: 'stdout' | 'stderr'; chunk: string }) => void
>()
let eventPushInstalled = false

async function get<T>(path: string): Promise<T> {
  await ensurePebbleRuntimeProcess()
  return requestRuntimeJson<T>(path, { method: 'GET' })
}

async function post<T>(path: string, body: unknown, timeoutMs = 30 * 60_000): Promise<T> {
  await ensurePebbleRuntimeProcess()
  return requestRuntimeJson<T>(path, { method: 'POST', body, timeoutMs })
}

function installProvisionEvents(): void {
  if (eventPushInstalled) {
    return
  }
  eventPushInstalled = true
  void subscribeRuntimeEventPush((entry) => {
    if (entry.topic !== 'ephemeral-vm.provision') {
      return
    }
    try {
      const event = JSON.parse(entry.data) as {
        provisionId: string
        stream: 'stdout' | 'stderr'
        chunk: string
      }
      if (!event.provisionId || !['stdout', 'stderr'].includes(event.stream)) {
        return
      }
      for (const listener of provisionListeners) {
        listener(event)
      }
    } catch {
      // Malformed diagnostics are ignored; the final provision response is authoritative.
    }
  })
}

async function patchConnection(
  runtimeId: string,
  values: { runtimeEnvironmentId?: string; sshTargetId?: string }
): Promise<EphemeralVmRuntimeRecord> {
  return post('/v1/ephemeral-vm/connection', { runtimeId, ...values })
}

function environmentName(repoName: string, runtimeId: string): string {
  return `${repoName || 'Pebble'} VM ${runtimeId.slice(-8)}`
}

async function registerPebbleServer(
  runtime: EphemeralVmRuntimeRecord,
  connection: Extract<EphemeralVmRecipeConnection, { type: 'pebble-server' }>,
  repoName: string
): Promise<{ runtime: EphemeralVmRuntimeRecord; environment: PublicKnownRuntimeEnvironment }> {
  const added = await invoke<{ environment: PublicKnownRuntimeEnvironment }>(
    'runtime_environments_add_from_pairing_code',
    {
      input: {
        name: environmentName(repoName, runtime.id),
        pairingCode: connection.pairingCode,
        source: 'ephemeral-vm'
      }
    }
  )
  return {
    runtime: await patchConnection(runtime.id, { runtimeEnvironmentId: added.environment.id }),
    environment: added.environment
  }
}

async function registerSshTarget(
  api: PreloadApi,
  runtime: EphemeralVmRuntimeRecord,
  connection: Extract<EphemeralVmRecipeConnection, { type: 'ssh' }>
): Promise<{ runtime: EphemeralVmRuntimeRecord; sshTargetId: string }> {
  const target = await api.ssh.addTarget({
    target: {
      ...connection.target,
      owner: { type: 'on-demand-runtime', runtimeId: runtime.id },
      source: 'manual'
    }
  })
  try {
    const state = await api.ssh.connect({ targetId: target.id })
    if (state?.status !== 'connected') {
      throw new Error(state?.error || `SSH target did not connect: ${state?.status ?? 'unknown'}`)
    }
    return {
      runtime: await patchConnection(runtime.id, { sshTargetId: target.id }),
      sshTargetId: target.id
    }
  } catch (error) {
    await api.ssh.removeTarget({ id: target.id }).catch(() => undefined)
    throw error
  }
}

async function removeRuntimeConnection(
  api: PreloadApi,
  runtime: EphemeralVmRuntimeRecord
): Promise<void> {
  if (runtime.runtimeEnvironmentId) {
    await api.runtimeEnvironments
      .remove({ selector: runtime.runtimeEnvironmentId })
      .catch(() => undefined)
  }
  if (runtime.sshTargetId) {
    await api.ssh.removeTarget({ id: runtime.sshTargetId }).catch(() => undefined)
  }
}

function connectionFromRuntime(runtime: EphemeralVmRuntimeRecord): EphemeralVmRecipeConnection {
  const result = runtime.recipeResult
  if ('connection' in result) {
    return result.connection
  }
  return { type: 'pebble-server', pairingCode: result.pairingCode, projectRoot: result.projectRoot }
}

export function createPebbleEphemeralVmApi(api: PreloadApi): PreloadApi['ephemeralVm'] {
  installProvisionEvents()
  return {
    listRecipes: ({ repoId }) =>
      get(`/v1/ephemeral-vm/recipes?projectId=${encodeURIComponent(repoId)}`),
    listRecipeCatalog: () => get('/v1/ephemeral-vm/recipe-catalog'),
    doctor: (args) =>
      post('/v1/ephemeral-vm/doctor', { projectId: args.repoId, recipeId: args.recipeId }),
    provision: async (args) => {
      const result = await post<NativeProvisionResult>('/v1/ephemeral-vm/provision', args)
      if (!result.ok) {
        return result
      }
      try {
        if (result.connection.type === 'ssh') {
          const registered = await registerSshTarget(api, result.runtime, result.connection)
          return {
            ok: true,
            connectionType: 'ssh',
            runtime: registered.runtime,
            sshTargetId: registered.sshTargetId,
            stderr: result.stderr,
            warnings: result.warnings
          }
        }
        const catalog = await get<
          Awaited<ReturnType<PreloadApi['ephemeralVm']['listRecipeCatalog']>>
        >('/v1/ephemeral-vm/recipe-catalog')
        const repoName = catalog.find((entry) => entry.repoId === args.repoId)?.repoName ?? 'Pebble'
        const registered = await registerPebbleServer(result.runtime, result.connection, repoName)
        return {
          ok: true,
          connectionType: 'pebble-server',
          runtime: registered.runtime,
          environment: registered.environment,
          stderr: result.stderr,
          warnings: result.warnings
        }
      } catch (error) {
        await post('/v1/ephemeral-vm/cleanup', { runtimeId: result.runtime.id }).catch(
          () => undefined
        )
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          stdout: '',
          stderr: result.stderr
        }
      }
    },
    cancelProvision: (args) => post('/v1/ephemeral-vm/cancel', args),
    onProvisionEvent: (callback) => {
      provisionListeners.add(callback)
      return () => provisionListeners.delete(callback)
    },
    listRuntimes: () => get('/v1/ephemeral-vm/runtimes'),
    attachWorkspace: (args) => post('/v1/ephemeral-vm/attach', args),
    suspendWorkspace: async (args) => {
      const runtime = await post<EphemeralVmRuntimeRecord | null>('/v1/ephemeral-vm/suspend', args)
      if (runtime?.sshTargetId && runtime.status === 'suspended') {
        await api.ssh.disconnect({ targetId: runtime.sshTargetId }).catch(() => undefined)
      }
      return runtime
    },
    resumeWorkspace: async (args) => {
      const runtime = await post<EphemeralVmRuntimeRecord | null>('/v1/ephemeral-vm/resume', args)
      if (!runtime || runtime.status !== 'running') {
        return runtime
      }
      if (runtime.sshTargetId) {
        await api.ssh.connect({ targetId: runtime.sshTargetId })
      }
      if (runtime.runtimeEnvironmentId) {
        const connection = connectionFromRuntime(runtime)
        if (connection.type === 'pebble-server') {
          await invoke('runtime_environments_update_pairing_code', {
            input: { selector: runtime.runtimeEnvironmentId, pairingCode: connection.pairingCode }
          })
        }
      }
      return runtime
    },
    cleanup: async (args) => {
      const before = (await get<EphemeralVmRuntimeRecord[]>('/v1/ephemeral-vm/runtimes')).find(
        (runtime) => runtime.id === args.runtimeId
      )
      const cleaned = await post<EphemeralVmRuntimeRecord>('/v1/ephemeral-vm/cleanup', args)
      if (before && cleaned.status === 'cleaned') {
        await removeRuntimeConnection(api, before)
      }
      return cleaned
    },
    getCleanupCommand: (args) => post('/v1/ephemeral-vm/cleanup-command', args)
  }
}
