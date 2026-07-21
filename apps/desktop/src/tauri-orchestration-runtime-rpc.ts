import { ensurePebbleRuntimeProcess, requestRuntimeJson } from './pebble-tauri-runtime-transport'

type RuntimeRpcResult = { handled: boolean; result?: unknown }

type RuntimeDispatch = {
  id: string
  taskId: string
  assignee: string
  sessionId?: string
  status: string
  preamble?: string
  createdAt: string
  updatedAt: string
}

type RuntimeDispatchPreamble = { preamble: string }

export async function callTauriOrchestrationRuntimeRpc(
  method: string,
  params: unknown
): Promise<RuntimeRpcResult> {
  if (method !== 'orchestration.dispatchShow') {
    return { handled: false }
  }
  const input = requireRecord(params)
  const taskId = requireString(input.task, 'task')
  await ensurePebbleRuntimeProcess()
  const dispatches = await requestRuntimeJson<RuntimeDispatch[]>(
    `/v1/orchestration/dispatches?taskId=${encodeURIComponent(taskId)}`,
    { method: 'GET', timeoutMs: 5000 }
  )
  const dispatch = dispatches.at(-1)
  const preamble =
    input.preamble === true
      ? await requestRuntimeJson<RuntimeDispatchPreamble>(
          buildPreamblePath(taskId, input.from, input.devMode),
          { method: 'GET', timeoutMs: 5000 }
        )
      : null
  return {
    handled: true,
    result: {
      dispatch: dispatch
        ? {
            id: dispatch.id,
            task_id: dispatch.taskId,
            assignee: dispatch.assignee,
            // Why: existing renderer links consume the Electron field name;
            // Go persists the same terminal identity as sessionId.
            assignee_handle: dispatch.sessionId || dispatch.assignee,
            status: dispatch.status,
            created_at: dispatch.createdAt,
            updated_at: dispatch.updatedAt
          }
        : null,
      ...(preamble ? { preamble: preamble.preamble } : {})
    }
  }
}

function buildPreamblePath(taskId: string, from: unknown, devMode: unknown): string {
  const query = new URLSearchParams({ taskId })
  if (typeof from === 'string' && from.trim()) {
    query.set('from', from.trim())
  }
  if (devMode === true) {
    query.set('devMode', 'true')
  }
  return `/v1/orchestration/dispatch-preamble?${query.toString()}`
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Orchestration parameters must be an object.')
  }
  return value as Record<string, unknown>
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Orchestration ${field} must be a non-empty string.`)
  }
  return value.trim()
}
