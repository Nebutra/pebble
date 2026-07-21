import type { PreloadApi } from '../../../packages/product-core/shared/preload-api-types'
import type {
  AiVaultListArgs,
  AiVaultListResult
} from '../../../packages/product-core/shared/ai-vault-types'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../packages/product-core/shared/execution-host'
import { ensurePebbleRuntimeProcess, requestRuntimeJson } from './pebble-tauri-runtime-transport'

export function createPebbleAiVaultApi(base: PreloadApi['aiVault']): PreloadApi['aiVault'] {
  const focusListeners = new Set<() => void>()
  window.addEventListener('focus', () => {
    for (const listener of focusListeners) {
      listener()
    }
  })
  return {
    ...base,
    listSessions: (args?: AiVaultListArgs) => listAiVaultSessions(args),
    onWindowFocused: (callback) => {
      focusListeners.add(callback)
      return () => focusListeners.delete(callback)
    }
  }
}

async function listAiVaultSessions(args?: AiVaultListArgs): Promise<AiVaultListResult> {
  const scope = args?.executionHostScope ?? LOCAL_EXECUTION_HOST_ID
  const parsedScope = parseExecutionHostId(scope)
  if (parsedScope?.kind === 'runtime') {
    return listPairedRuntimeSessions(parsedScope.environmentId, args)
  }
  if (scope === 'all') {
    return listAllRuntimeSessions(args)
  }
  return listLocalRuntimeSessions(args)
}

async function listLocalRuntimeSessions(args?: AiVaultListArgs): Promise<AiVaultListResult> {
  // Why: the panel mounts during renderer bootstrap, before the sidecar's
  // fire-and-forget startup is guaranteed to have completed.
  await ensurePebbleRuntimeProcess()
  const query = new URLSearchParams({ limit: String(args?.limit ?? 1000) })
  if (args?.executionHostScope) {
    query.set('executionHostScope', args.executionHostScope)
  }
  for (const scopePath of args?.scopePaths ?? []) {
    query.append('scopePath', scopePath)
  }
  const path = `/v1/ai-vault/sessions?${query.toString()}`
  try {
    return await requestRuntimeJson<AiVaultListResult>(path, {
      method: 'GET',
      timeoutMs: 30_000
    })
  } catch {
    // A process can be running while its HTTP listener is still binding.
    await waitForRuntimeListener()
    return requestRuntimeJson<AiVaultListResult>(path, {
      method: 'GET',
      timeoutMs: 30_000
    })
  }
}

async function listPairedRuntimeSessions(
  environmentId: string,
  args?: AiVaultListArgs
): Promise<AiVaultListResult> {
  const response = await window.api.runtimeEnvironments.call({
    selector: environmentId,
    method: 'aiVault.listSessions',
    params: {
      limit: normalizeLimit(args?.limit),
      executionHostScope: LOCAL_EXECUTION_HOST_ID,
      scopePaths: [...(args?.scopePaths ?? [])]
    },
    timeoutMs: 30_000
  })
  if (!response.ok) {
    return pairedRuntimeIssue(environmentId, response.error.message || response.error.code)
  }
  return rewritePairedRuntimeResult(
    response.result as AiVaultListResult,
    toRuntimeExecutionHostId(environmentId)
  )
}

async function listAllRuntimeSessions(args?: AiVaultListArgs): Promise<AiVaultListResult> {
  const limit = normalizeLimit(args?.limit)
  const localPromise = listLocalRuntimeSessions({ ...args, limit, executionHostScope: 'all' })
  let environments: Awaited<ReturnType<PreloadApi['runtimeEnvironments']['list']>> = []
  try {
    environments = await window.api.runtimeEnvironments.list()
  } catch {
    // Local and SSH history remain useful when the pairing registry is unavailable.
  }
  const results = await Promise.all([
    localPromise,
    ...environments.map((environment) =>
      listPairedRuntimeSessions(environment.id, { ...args, limit })
    )
  ])
  return mergeAiVaultResults(results, limit)
}

function rewritePairedRuntimeResult(
  result: AiVaultListResult,
  executionHostId: ExecutionHostId
): AiVaultListResult {
  return {
    ...result,
    sessions: result.sessions.map((session) => ({
      ...session,
      id: rewriteSessionHostId(session.id, executionHostId),
      executionHostId
    })),
    issues: result.issues.map((issue) => ({ ...issue, executionHostId }))
  }
}

function rewriteSessionHostId(id: string, executionHostId: ExecutionHostId): string {
  const separator = id.indexOf(':')
  return separator < 0 ? `${executionHostId}:${id}` : `${executionHostId}${id.slice(separator)}`
}

function pairedRuntimeIssue(environmentId: string, message: string): AiVaultListResult {
  const executionHostId = toRuntimeExecutionHostId(environmentId)
  return {
    sessions: [],
    issues: [{ executionHostId, agent: 'codex', path: environmentId, message }],
    scannedAt: new Date().toISOString()
  }
}

function mergeAiVaultResults(
  results: readonly AiVaultListResult[],
  limit: number
): AiVaultListResult {
  const sessionsById = new Map<string, AiVaultListResult['sessions'][number]>()
  for (const result of results) {
    for (const session of result.sessions) {
      sessionsById.set(session.id, session)
    }
  }
  return {
    sessions: [...sessionsById.values()]
      .sort((left, right) => sessionTimestamp(right) - sessionTimestamp(left))
      .slice(0, limit),
    issues: results.flatMap((result) => result.issues),
    scannedAt: new Date().toISOString()
  }
}

function sessionTimestamp(session: AiVaultListResult['sessions'][number]): number {
  return Date.parse(session.updatedAt ?? session.modifiedAt ?? session.createdAt ?? '') || 0
}

function normalizeLimit(limit: number | undefined): number {
  return limit && limit > 0 ? Math.floor(limit) : 1000
}

async function waitForRuntimeListener(): Promise<void> {
  await new Promise<void>((resolve) => window.setTimeout(resolve, 250))
  await ensurePebbleRuntimeProcess()
}
