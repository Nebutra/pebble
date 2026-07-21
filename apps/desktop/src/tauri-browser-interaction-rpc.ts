import { requestRuntimeJson } from './pebble-tauri-runtime-transport'
import {
  getTauriBrowserProviderActionCursor,
  type TauriBrowserProviderActionRecord,
  waitForTauriBrowserProviderAction
} from './tauri-browser-provider-action-result'
import { executeTauriBrowserActionLocally } from './tauri-browser-action-consumer'

export async function queueTauriBrowserInteraction(
  command: string,
  params: unknown
): Promise<Record<string, unknown>> {
  const input = readObject(params)
  const pageId = readRequiredString(
    input.page ?? input.browserPageId ?? input.tabId,
    'browser page id'
  )
  const payload = Object.fromEntries(
    Object.entries(input).filter(
      ([key]) => !['page', 'browserPageId', 'tabId', 'worktree'].includes(key)
    )
  )
  const localResult = await executeTauriBrowserActionLocally(pageId, command, payload)
  if (localResult) {
    return localResult
  }
  const actionCursor = getTauriBrowserProviderActionCursor()
  const action = await requestRuntimeJson<TauriBrowserProviderActionRecord>(
    `/v1/browser/tabs/${encodeURIComponent(pageId)}/commands`,
    { method: 'POST', body: { command, payload } }
  )
  const completed = await waitForTauriBrowserProviderAction(action.id, actionCursor)
  if (completed.status === 'failed') {
    throw new Error(completed.error || `Tauri browser command failed: ${command}.`)
  }
  return completed.result ?? {}
}

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function readRequiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} is required`)
  }
  return value.trim()
}
