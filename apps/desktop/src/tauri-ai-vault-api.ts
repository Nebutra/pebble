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

// Why: the desktop bridge refuses a resource response over a megabyte, and the
// session list is roughly 2.7KB per session, so the old default of 1000 asked
// for about 2.9MB and was rejected every time. The panel then sat on its
// skeletons forever, because the only failure path retried the same oversized
// request. 200 measured 546KB here — under half the ceiling, with room for
// transcripts whose previews run longer than this machine's.
const DEFAULT_SESSION_LIMIT = 200

// Why adaptive rather than a smaller constant: per-session cost is not fixed —
// it is whatever the transcript previews weigh on this machine — so any number
// picked here is only correct until someone's previews run longer. Lowering the
// default did not help the panel at all, because its caller passes an explicit
// 500 and never saw the default. Halving on refusal converges from whatever the
// caller asked for, so the ceiling is respected without anyone guessing.
const SESSION_LIMIT_FLOOR = 25

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
  const requestedLimit = normalizeLimit(args?.limit)
  let limit = requestedLimit
  for (;;) {
    try {
      const result = await requestLocalSessions(limit, args)
      return limit < requestedLimit ? withTruncationIssue(result, limit, requestedLimit) : result
    } catch (error) {
      // Why: the retry below exists for a runtime whose listener is still
      // binding, and that is worth one more attempt. A response the bridge
      // refused for its size will be refused identically, so retrying it
      // unchanged hid the failure behind a panel that never stopped loading.
      if (isResponseTooLarge(error)) {
        if (limit <= SESSION_LIMIT_FLOOR) {
          throw new Error(
            `The session list was too large for the desktop bridge even at ${limit} sessions. ${getErrorText(error)}`
          )
        }
        limit = Math.max(SESSION_LIMIT_FLOOR, Math.floor(limit / 2))
        continue
      }
      // A process can be running while its HTTP listener is still binding.
      await waitForRuntimeListener()
      return requestLocalSessions(limit, args)
    }
  }
}

function requestLocalSessions(limit: number, args?: AiVaultListArgs): Promise<AiVaultListResult> {
  const query = new URLSearchParams({ limit: String(limit) })
  if (args?.executionHostScope) {
    query.set('executionHostScope', args.executionHostScope)
  }
  for (const scopePath of args?.scopePaths ?? []) {
    query.append('scopePath', scopePath)
  }
  return requestRuntimeJson<AiVaultListResult>(`/v1/ai-vault/sessions?${query.toString()}`, {
    method: 'GET',
    timeoutMs: 30_000
  })
}

// Why: a shorter list that arrives looks identical to a complete one. Say that
// the ceiling cut it, so "my older sessions are missing" has an answer.
function withTruncationIssue(
  result: AiVaultListResult,
  limit: number,
  requestedLimit: number
): AiVaultListResult {
  return {
    ...result,
    issues: [
      ...result.issues,
      {
        agent: 'claude',
        path: '',
        message: `Showing the ${limit} most recent sessions — ${requestedLimit} did not fit the desktop bridge's 1MB response limit.`
      }
    ]
  }
}

function getErrorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isResponseTooLarge(error: unknown): boolean {
  return /exceeded|too large|payload too/i.test(getErrorText(error))
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
  return limit && limit > 0 ? Math.floor(limit) : DEFAULT_SESSION_LIMIT
}

async function waitForRuntimeListener(): Promise<void> {
  await new Promise<void>((resolve) => window.setTimeout(resolve, 250))
  await ensurePebbleRuntimeProcess()
}
