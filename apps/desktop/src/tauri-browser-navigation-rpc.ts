import { requestRuntimeJson } from './pebble-tauri-runtime-transport'
import {
  getTauriBrowserProviderActionCursor,
  type TauriBrowserProviderActionRecord,
  waitForTauriBrowserProviderAction
} from './tauri-browser-provider-action-result'

type RuntimeBrowserTab = {
  id: string
  title: string
  url: string
  status?: 'loading' | 'ready' | 'error'
}

type BrowserNavigationResult = {
  url: string
  title: string
}

export async function queueTauriBrowserNavigation(
  command: 'goto' | 'goBack' | 'goForward' | 'reload',
  params: unknown
): Promise<BrowserNavigationResult> {
  const input = readObject(params)
  const pageId = readBrowserPageId(input)
  let tab = await readRuntimeBrowserTab(pageId)
  const payload: Record<string, unknown> = {}
  if (command === 'goto') {
    const url = readString(input.url) ?? 'about:blank'
    payload.url = url
    tab = await updateRuntimeBrowserTab(pageId, {
      url,
      title: url,
      status: 'loading'
    })
  } else if (command === 'reload') {
    tab = await updateRuntimeBrowserTab(pageId, { status: 'loading' })
  }

  const actionCursor = getTauriBrowserProviderActionCursor()
  const action = await requestRuntimeJson<TauriBrowserProviderActionRecord>(
    `/v1/browser/tabs/${encodeURIComponent(pageId)}/commands`,
    {
      method: 'POST',
      body: {
        command,
        payload
      }
    }
  )
  const completedAction = await waitForTauriBrowserProviderAction(action.id, actionCursor)
  if (completedAction.status === 'failed') {
    throw new Error(completedAction.error || `Tauri browser command failed: ${command}.`)
  }
  return readNavigationActionResult(completedAction, tab)
}

async function readRuntimeBrowserTab(pageId: string): Promise<RuntimeBrowserTab> {
  const tabs = await requestRuntimeJson<RuntimeBrowserTab[]>('/v1/browser/tabs', { method: 'GET' })
  const tab = tabs.find((entry) => entry.id === pageId)
  if (!tab) {
    throw new Error(`Browser tab not found: ${pageId}`)
  }
  return tab
}

async function updateRuntimeBrowserTab(
  pageId: string,
  body: Partial<Pick<RuntimeBrowserTab, 'title' | 'url' | 'status'>>
): Promise<RuntimeBrowserTab> {
  return requestRuntimeJson<RuntimeBrowserTab>(`/v1/browser/tabs/${encodeURIComponent(pageId)}`, {
    method: 'PATCH',
    body
  })
}

function readNavigationActionResult(
  action: TauriBrowserProviderActionRecord,
  fallback: RuntimeBrowserTab
): BrowserNavigationResult {
  const result = action.result ?? {}
  const url = readString(result.url) ?? fallback.url
  return {
    url,
    title: readString(result.title) ?? (fallback.title || url)
  }
}

function readBrowserPageId(input: Record<string, unknown>): string {
  const pageId = readString(input.page ?? input.browserPageId ?? input.tabId)
  if (!pageId) {
    throw new Error('Missing browser page id')
  }
  return pageId
}

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}
