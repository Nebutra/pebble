import type { TauriRuntimeAgentSession } from './tauri-agent-status-api'
import {
  createRuntimeResourceGetCommand,
  createRuntimeResourceRequestCommand,
  getRuntimeResourceJson,
  requestRuntimeResourceJson
} from './runtime-bridge'
import type { RuntimeResourceGetResult } from './runtime-command-shapes'

export type RuntimeSession = TauriRuntimeAgentSession & {
  id: string
  projectId: string
  worktreeId?: string
  cwd: string
  command: string[]
  cols?: number
  rows?: number
  pid?: number
  startedAt?: string
  foregroundProcess?: string
  hasChildProcesses?: boolean
  foregroundProcessUnsupportedReason?: string
}

export type RuntimeOutputChunk = {
  stream: string
  content: string
}

export async function listRuntimeSessions(): Promise<RuntimeSession[]> {
  return requestRuntimePtyJson<RuntimeSession[]>('GET', '/v1/sessions')
}

export async function findRuntimeSession(id: string): Promise<RuntimeSession | null> {
  return (await listRuntimeSessions()).find((session) => session.id === id) ?? null
}

export async function requestRuntimePtyJson<T>(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
  timeoutMs = 1500
): Promise<T> {
  const result =
    method === 'GET'
      ? await getRuntimeResourceJson(createRuntimeResourceGetCommand({ path, timeoutMs }))
      : await requestRuntimeResourceJson(
          createRuntimeResourceRequestCommand({
            method,
            path,
            bodyJson: body === undefined ? null : JSON.stringify(body),
            timeoutMs
          })
        )
  return parseRuntimeResourceResult<T>(result)
}

function parseRuntimeResourceResult<T>(result: RuntimeResourceGetResult): T {
  if (result.transport !== 'connected') {
    throw new Error(result.error ?? `Runtime transport failed: ${result.transport}`)
  }
  if (result.httpStatus !== null && (result.httpStatus < 200 || result.httpStatus > 299)) {
    throw new Error(result.body ?? `Runtime request failed with HTTP ${result.httpStatus}`)
  }
  return result.body ? (JSON.parse(result.body) as T) : ({} as T)
}
