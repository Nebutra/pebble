import { describe, expect, it, vi } from 'vitest'

const { invokeMock, listenMock, requestRuntimeJsonMock, subscribeRuntimeEventPushMock } =
  vi.hoisted(() => ({
    invokeMock: vi.fn(),
    listenMock: vi.fn(),
    requestRuntimeJsonMock: vi.fn(),
    subscribeRuntimeEventPushMock: vi.fn(async () => ({ supported: true }))
  }))

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }))
vi.mock('./pebble-tauri-runtime-transport', () => ({
  requestRuntimeJson: requestRuntimeJsonMock
}))
vi.mock('./tauri-runtime-event-push', () => ({
  subscribeRuntimeEventPush: subscribeRuntimeEventPushMock
}))
vi.mock('./runtime-bridge', () => ({
  createRuntimeEventStreamCommand: vi.fn(),
  readRuntimeEventStream: vi.fn()
}))

import {
  cancelNativeTauriBrowserDownload,
  onTauriBrowserContextMenuDismissed,
  onTauriBrowserContextMenuRequested,
  onTauriBrowserDownloadRequested,
  onTauriBrowserGuestLoadFailed,
  onTauriBrowserGrabActionShortcut,
  onTauriBrowserGrabModeToggle,
  onTauriBrowserPermissionDenied,
  onTauriBrowserOpenLink,
  onTauriBrowserPopup
} from './tauri-browser-runtime-events'

describe('Tauri native browser download bridge', () => {
  it('persists native requested and finished events through the Go runtime record', async () => {
    let nativeListener: (event: { payload: Record<string, unknown> }) => void = () => {
      throw new Error('native download listener was not installed')
    }
    let popupListener: (event: { payload: Record<string, unknown> }) => void = () => {
      throw new Error('native popup listener was not installed')
    }
    let contextMenuListener: (event: { payload: Record<string, unknown> }) => void = () => {
      throw new Error('native context menu listener was not installed')
    }
    listenMock.mockImplementation(
      (eventName: string, callback: (event: { payload: Record<string, unknown> }) => void) => {
        if (eventName === 'pebble://browser-download') {
          nativeListener = callback
        }
        if (eventName === 'pebble://browser-new-window') {
          popupListener = callback
        }
        if (eventName === 'pebble://browser-context-menu') {
          contextMenuListener = callback
        }
        return Promise.resolve(() => undefined)
      }
    )
    requestRuntimeJsonMock
      .mockResolvedValueOnce({ id: 'download-runtime-1' })
      .mockResolvedValueOnce({ id: 'download-runtime-1', status: 'inProgress' })
      .mockResolvedValueOnce({ id: 'download-runtime-1', status: 'completed' })
    invokeMock.mockResolvedValueOnce(true)

    const unsubscribe = onTauriBrowserDownloadRequested(() => undefined)
    const popupCallback = vi.fn()
    const openLinkCallback = vi.fn()
    const unsubscribePopup = onTauriBrowserPopup(popupCallback)
    const unsubscribeOpenLink = onTauriBrowserOpenLink(openLinkCallback)
    const contextRequested = vi.fn()
    const contextDismissed = vi.fn()
    const permissionDenied = vi.fn()
    const grabModeToggle = vi.fn()
    const grabActionShortcut = vi.fn()
    const unsubscribeContextRequested = onTauriBrowserContextMenuRequested(contextRequested)
    const unsubscribeContextDismissed = onTauriBrowserContextMenuDismissed(contextDismissed)
    const unsubscribePermissionDenied = onTauriBrowserPermissionDenied(permissionDenied)
    const unsubscribeGrabModeToggle = onTauriBrowserGrabModeToggle(grabModeToggle)
    const unsubscribeGrabActionShortcut = onTauriBrowserGrabActionShortcut(grabActionShortcut)
    await vi.waitFor(() => expect(listenMock).toHaveBeenCalledTimes(3))

    contextMenuListener({ payload: { kind: 'grabModeToggle', browserTabId: 'tab-1' } })
    contextMenuListener({
      payload: { kind: 'grabActionShortcut', browserTabId: 'tab-1', key: 's' }
    })
    expect(grabModeToggle).toHaveBeenCalledWith('tab-1')
    expect(grabActionShortcut).toHaveBeenCalledWith({ browserPageId: 'tab-1', key: 's' })

    nativeListener({
      payload: {
        kind: 'requested',
        nativeDownloadId: 'native-1',
        browserTabId: 'tab-1',
        url: 'https://example.com/private/report.pdf?token=secret',
        filename: 'report.pdf',
        path: '/Users/test/Downloads/report.pdf'
      }
    })
    await vi.waitFor(() => expect(requestRuntimeJsonMock).toHaveBeenCalledTimes(1))
    nativeListener({
      payload: {
        kind: 'progress',
        nativeDownloadId: 'native-1',
        browserTabId: 'tab-1',
        receivedBytes: 4096,
        totalBytes: 8192
      }
    })
    await vi.waitFor(() => expect(requestRuntimeJsonMock).toHaveBeenCalledTimes(2))
    await expect(cancelNativeTauriBrowserDownload('download-runtime-1')).resolves.toBe(true)
    expect(invokeMock).toHaveBeenCalledWith('browser_child_webview_cancel_download', {
      input: { nativeDownloadId: 'native-1' }
    })
    nativeListener({
      payload: {
        kind: 'finished',
        nativeDownloadId: 'native-1',
        browserTabId: 'tab-1',
        url: 'https://example.com/private/report.pdf?token=secret',
        filename: 'report.pdf',
        path: '/Users/test/Downloads/report.pdf',
        success: true
      }
    })

    await vi.waitFor(() => expect(requestRuntimeJsonMock).toHaveBeenCalledTimes(3))
    expect(requestRuntimeJsonMock).toHaveBeenNthCalledWith(1, '/v1/browser/downloads', {
      method: 'POST',
      body: {
        tabId: 'tab-1',
        url: 'https://example.com/private/report.pdf?token=secret',
        filename: 'report.pdf',
        path: '/Users/test/Downloads/report.pdf',
        status: 'inProgress',
        bytesReceived: 0,
        totalBytes: 0
      },
      timeoutMs: 5_000
    })
    expect(requestRuntimeJsonMock).toHaveBeenNthCalledWith(
      2,
      '/v1/browser/downloads/download-runtime-1',
      {
        method: 'PATCH',
        body: {
          status: 'inProgress',
          bytesReceived: 4096,
          totalBytes: 8192
        },
        timeoutMs: 5_000
      }
    )
    expect(requestRuntimeJsonMock).toHaveBeenNthCalledWith(
      3,
      '/v1/browser/downloads/download-runtime-1',
      {
        method: 'PATCH',
        body: {
          filename: 'report.pdf',
          path: '/Users/test/Downloads/report.pdf',
          status: 'completed',
          error: ''
        },
        timeoutMs: 5_000
      }
    )
    popupListener({
      payload: {
        browserTabId: 'tab-1',
        url: 'https://example.com/oauth/callback?token=secret',
        allowedInPebble: true
      }
    })
    expect(openLinkCallback).toHaveBeenCalledWith({
      browserPageId: 'tab-1',
      url: 'https://example.com/oauth/callback?token=secret'
    })
    expect(popupCallback).toHaveBeenCalledWith({
      browserPageId: 'tab-1',
      origin: 'https://example.com',
      action: 'opened-in-pebble'
    })
    contextMenuListener({
      payload: {
        kind: 'requested',
        browserTabId: 'tab-1',
        screenX: 420,
        screenY: 240,
        pageUrl: 'https://example.com',
        linkUrl: 'https://example.com/docs',
        selectionText: 'Pebble'
      }
    })
    expect(contextRequested).toHaveBeenCalledWith(
      expect.objectContaining({
        browserPageId: 'tab-1',
        screenX: 420,
        screenY: 240,
        linkUrl: 'https://example.com/docs',
        selectionText: 'Pebble'
      })
    )
    contextMenuListener({ payload: { kind: 'dismissed', browserTabId: 'tab-1' } })
    expect(contextDismissed).toHaveBeenCalledWith({ browserPageId: 'tab-1' })
    contextMenuListener({
      payload: {
        kind: 'permissionDenied',
        browserTabId: 'tab-1',
        permission: 'media',
        origin: 'https://example.com/private?token=secret'
      }
    })
    expect(permissionDenied).toHaveBeenCalledWith({
      browserPageId: 'tab-1',
      permission: 'media',
      origin: 'https://example.com'
    })
    unsubscribe()
    unsubscribePopup()
    unsubscribeOpenLink()
    unsubscribeContextRequested()
    unsubscribeContextDismissed()
    unsubscribePermissionDenied()
    unsubscribeGrabModeToggle()
    unsubscribeGrabActionShortcut()
  })
})

describe('Tauri browser guest event bridge', () => {
  it('delivers load failures through the canonical browser API contract', async () => {
    const { reportTauriBrowserGuestLoadFailed } = await import('./tauri-browser-runtime-events')
    const listener = vi.fn()
    const unsubscribe = onTauriBrowserGuestLoadFailed(listener)
    reportTauriBrowserGuestLoadFailed({
      browserPageId: 'tab-failed',
      loadError: {
        code: -1,
        description: 'could not create webview',
        validatedUrl: 'https://bad.test'
      }
    })
    expect(listener).toHaveBeenCalledWith({
      browserPageId: 'tab-failed',
      loadError: {
        code: -1,
        description: 'could not create webview',
        validatedUrl: 'https://bad.test'
      }
    })
    unsubscribe()
  })
})
