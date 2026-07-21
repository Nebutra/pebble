import { requestRuntimeJson } from './pebble-tauri-runtime-transport'
import {
  getTauriBrowserProviderActionCursor,
  type TauriBrowserProviderActionRecord,
  waitForTauriBrowserProviderAction
} from './tauri-browser-provider-action-result'

type BrowserScreenshotResult = {
  data: string
  format: 'png' | 'jpeg'
}

export async function queueTauriBrowserScreenshot(
  params: unknown
): Promise<BrowserScreenshotResult> {
  const input = readObject(params)
  const pageId = readBrowserPageId(input)
  const format = readScreenshotFormat(input.format)
  const actionCursor = getTauriBrowserProviderActionCursor()
  const action = await requestRuntimeJson<TauriBrowserProviderActionRecord>(
    `/v1/browser/tabs/${encodeURIComponent(pageId)}/commands`,
    {
      method: 'POST',
      body: {
        command: 'screenshot',
        payload: { format }
      }
    }
  )
  const completedAction = await waitForTauriBrowserProviderAction(action.id, actionCursor)
  if (completedAction.status === 'failed') {
    throw new Error(completedAction.error || 'Tauri browser screenshot provider failed.')
  }

  return readBrowserScreenshotResult(completedAction)
}

function readBrowserScreenshotResult(
  action: TauriBrowserProviderActionRecord
): BrowserScreenshotResult {
  const result = action.result ?? {}
  const data = typeof result.data === 'string' ? result.data : ''
  if (!data) {
    throw new Error('Tauri browser screenshot provider completed without image data.')
  }
  return {
    data,
    format: readScreenshotFormat(result.format)
  }
}

function readBrowserPageId(input: Record<string, unknown>): string {
  const pageId = readString(input.page ?? input.browserPageId ?? input.tabId)
  if (!pageId) {
    throw new Error('Missing browser page id')
  }
  return pageId
}

function readScreenshotFormat(value: unknown): 'png' | 'jpeg' {
  return value === 'jpeg' ? 'jpeg' : 'png'
}

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}
