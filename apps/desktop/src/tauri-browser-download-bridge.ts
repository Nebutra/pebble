import { invoke } from '@tauri-apps/api/core'
import { requestRuntimeJson } from './pebble-tauri-runtime-transport'
import {
  downloadRequestedListeners,
  downloadProgressListeners,
  downloadFinishedListeners,
  emitTo
} from './tauri-browser-event-listener-registry'

export const NATIVE_BROWSER_DOWNLOAD_EVENT = 'pebble://browser-download'

export type RuntimeBrowserDownload = {
  id: string
  tabId?: string
  url?: string
  filename?: string
  path?: string
  status?: 'queued' | 'inProgress' | 'completed' | 'canceled' | 'failed'
  bytesReceived?: number
  totalBytes?: number
  error?: string
}

export type NativeBrowserDownloadEvent =
  | {
      kind: 'requested'
      nativeDownloadId: string
      browserTabId: string
      url: string
      filename: string
      path: string
    }
  | {
      kind: 'progress'
      nativeDownloadId: string
      browserTabId: string
      receivedBytes: number
      totalBytes: number | null
    }
  | {
      kind: 'finished'
      nativeDownloadId: string
      browserTabId: string
      url: string
      filename: string
      path: string
      success: boolean
    }

const nativeDownloadRuntimeIds = new Map<string, Promise<string | null>>()
const runtimeDownloadNativeIds = new Map<string, string>()

export async function handleNativeBrowserDownload(
  event: NativeBrowserDownloadEvent
): Promise<void> {
  if (event.kind === 'requested') {
    const registration = requestRuntimeJson<RuntimeBrowserDownload>('/v1/browser/downloads', {
      method: 'POST',
      body: {
        tabId: event.browserTabId,
        url: event.url,
        filename: event.filename,
        path: event.path,
        status: 'inProgress',
        bytesReceived: 0,
        totalBytes: 0
      },
      timeoutMs: 5_000
    })
      .then((download) => {
        runtimeDownloadNativeIds.set(download.id, event.nativeDownloadId)
        return download.id
      })
      .catch(() => null)
    nativeDownloadRuntimeIds.set(event.nativeDownloadId, registration)
    return
  }

  if (event.kind === 'progress') {
    const runtimeDownloadId = await nativeDownloadRuntimeIds.get(event.nativeDownloadId)
    if (!runtimeDownloadId) {
      return
    }
    await requestRuntimeJson<RuntimeBrowserDownload>(
      `/v1/browser/downloads/${encodeURIComponent(runtimeDownloadId)}`,
      {
        method: 'PATCH',
        body: {
          status: 'inProgress',
          bytesReceived: Math.max(0, event.receivedBytes),
          totalBytes: event.totalBytes && event.totalBytes > 0 ? event.totalBytes : 0
        },
        timeoutMs: 5_000
      }
    ).catch(() => undefined)
    return
  }

  const registration = nativeDownloadRuntimeIds.get(event.nativeDownloadId)
  nativeDownloadRuntimeIds.delete(event.nativeDownloadId)
  const runtimeDownloadId = await registration
  if (!runtimeDownloadId) {
    return
  }
  runtimeDownloadNativeIds.delete(runtimeDownloadId)
  await requestRuntimeJson<RuntimeBrowserDownload>(
    `/v1/browser/downloads/${encodeURIComponent(runtimeDownloadId)}`,
    {
      method: 'PATCH',
      body: {
        filename: event.filename,
        path: event.path,
        status: event.success ? 'completed' : 'failed',
        error: event.success ? '' : 'Native WebView download failed.'
      },
      timeoutMs: 5_000
    }
  ).catch(() => undefined)
}

export async function cancelNativeTauriBrowserDownload(
  runtimeDownloadId: string
): Promise<boolean | null> {
  const nativeDownloadId = await resolveNativeDownloadId(runtimeDownloadId)
  if (!nativeDownloadId) {
    return null
  }
  return invoke<boolean>('browser_child_webview_cancel_download', {
    input: { nativeDownloadId }
  }).catch(() => false)
}

async function resolveNativeDownloadId(runtimeDownloadId: string): Promise<string | null> {
  const known = runtimeDownloadNativeIds.get(runtimeDownloadId)
  if (known) {
    return known
  }
  // A browser.changed push can reach the UI before the POST promise resumes.
  // Await in-flight native registrations so an immediate cancel cannot become
  // a runtime-only state change while the transfer keeps running.
  for (const [nativeDownloadId, registration] of Array.from(nativeDownloadRuntimeIds)) {
    if ((await registration) === runtimeDownloadId) {
      runtimeDownloadNativeIds.set(runtimeDownloadId, nativeDownloadId)
      return nativeDownloadId
    }
  }
  return null
}

export function emitBrowserDownload(download: RuntimeBrowserDownload): void {
  const downloadId = download.id
  const totalBytes = download.totalBytes ?? null
  if (download.status === 'inProgress' || download.status === 'queued') {
    emitTo(downloadRequestedListeners, {
      browserPageId: download.tabId ?? '',
      downloadId,
      origin: sanitizeDownloadOrigin(download.url),
      filename: download.filename ?? downloadId,
      totalBytes,
      mimeType: null,
      savePath: download.path ?? '',
      status: 'downloading'
    })
    emitTo(downloadProgressListeners, {
      browserPageId: download.tabId,
      downloadId,
      receivedBytes: download.bytesReceived ?? 0,
      totalBytes,
      state: 'progressing'
    })
  }
  if (
    download.status === 'completed' ||
    download.status === 'canceled' ||
    download.status === 'failed'
  ) {
    emitTo(downloadFinishedListeners, {
      browserPageId: download.tabId,
      downloadId,
      status: download.status === 'canceled' ? 'canceled' : download.status,
      savePath: download.path ?? null,
      error: download.error ?? null
    })
  }
}

function sanitizeDownloadOrigin(value: string | undefined): string {
  if (!value) {
    return ''
  }
  try {
    return new URL(value).origin
  } catch {
    return ''
  }
}

export function isRuntimeBrowserDownload(
  value: Record<string, unknown>
): value is RuntimeBrowserDownload {
  if (typeof value.id !== 'string') {
    return false
  }
  if ('bytesReceived' in value || 'totalBytes' in value || 'filename' in value || 'path' in value) {
    return true
  }
  return (
    value.status === 'queued' ||
    value.status === 'inProgress' ||
    value.status === 'completed' ||
    value.status === 'canceled' ||
    value.status === 'failed'
  )
}
