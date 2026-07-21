// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { pollBrowserActionsMock, requestRuntimeResourceJsonMock, updateBrowserActionMock } =
  vi.hoisted(() => ({
    pollBrowserActionsMock: vi.fn(),
    requestRuntimeResourceJsonMock: vi.fn(),
    updateBrowserActionMock: vi.fn()
  }))

vi.mock('./runtime-bridge', () => ({
  createBrowserActionPollInput: (input: unknown) => ({
    runtimeUrl: 'http://127.0.0.1:17777',
    bearerToken: null,
    timeoutMs: 1500,
    ...(input as Record<string, unknown>)
  }),
  createBrowserActionUpdateInput: (input: unknown) => ({
    runtimeUrl: 'http://127.0.0.1:17777',
    bearerToken: null,
    timeoutMs: 1500,
    ...(input as Record<string, unknown>)
  }),
  createRuntimeResourceRequestCommand: (input: unknown) => ({
    runtimeUrl: 'http://127.0.0.1:17777',
    bearerToken: null,
    timeoutMs: 1500,
    ...(input as Record<string, unknown>)
  }),
  pollBrowserActions: pollBrowserActionsMock,
  requestRuntimeResourceJson: requestRuntimeResourceJsonMock,
  updateBrowserAction: updateBrowserActionMock
}))

import {
  consumeTauriBrowserActionsOnce,
  installTauriBrowserActionExecutorBridge,
  registerTauriBrowserActionExecutor
} from './tauri-browser-action-consumer'

beforeEach(() => {
  vi.clearAllMocks()
  delete window.__pebbleTauriBrowserActionExecutors
  requestRuntimeResourceJsonMock.mockResolvedValue({
    transport: 'connected',
    httpStatus: 200,
    body: '{}'
  })
  updateBrowserActionMock.mockResolvedValue({
    transport: 'connected',
    httpStatus: 200,
    body: '{}'
  })
})

describe('consumeTauriBrowserActionsOnce', () => {
  it('publishes a window bridge for renderer-owned Tauri Webview action executors', () => {
    installTauriBrowserActionExecutorBridge()

    expect(window.__pebbleTauriBrowserActionExecutors?.register).toBe(
      registerTauriBrowserActionExecutor
    )
  })

  it('does not claim hidden browser tabs without a native WebView owner', async () => {
    await expect(consumeTauriBrowserActionsOnce()).resolves.toBe(0)

    expect(pollBrowserActionsMock).not.toHaveBeenCalled()
    expect(updateBrowserActionMock).not.toHaveBeenCalled()
  })

  it('fails an action honestly when its claimed WebView owner disappears', async () => {
    const unregister = registerTauriBrowserActionExecutor('page-other', async () => ({ ok: true }))
    pollBrowserActionsMock.mockResolvedValue({
      transport: 'connected',
      httpStatus: 200,
      body: JSON.stringify([
        {
          id: 'action-1',
          kind: 'browser.goto',
          target: 'page-1',
          payload: { tabId: 'page-1', command: 'goto', url: 'https://example.com' }
        }
      ])
    })

    await expect(consumeTauriBrowserActionsOnce()).resolves.toBe(1)

    expect(requestRuntimeResourceJsonMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'PATCH',
        path: '/v1/browser/tabs/page-1',
        bodyJson: expect.stringContaining('"status":"error"')
      })
    )
    expect(updateBrowserActionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        actionId: 'action-1',
        status: 'failed',
        errorMessage: expect.stringContaining('Cannot run browser command: goto')
      })
    )
    unregister()
  })

  it('does not mark the browser tab errored when a non-navigation action fails', async () => {
    const unregister = registerTauriBrowserActionExecutor('page-other', async () => ({ ok: true }))
    pollBrowserActionsMock.mockResolvedValue({
      transport: 'connected',
      httpStatus: 200,
      body: JSON.stringify([
        {
          id: 'action-shot',
          kind: 'browser.screenshot',
          target: 'page-1',
          payload: { tabId: 'page-1', command: 'screenshot' }
        }
      ])
    })

    await expect(consumeTauriBrowserActionsOnce()).resolves.toBe(1)

    expect(requestRuntimeResourceJsonMock).not.toHaveBeenCalled()
    expect(updateBrowserActionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        actionId: 'action-shot',
        status: 'failed',
        errorMessage: expect.stringContaining('Cannot run browser command: screenshot')
      })
    )
    unregister()
  })

  it('completes browser actions through a registered adapter executor', async () => {
    pollBrowserActionsMock.mockResolvedValue({
      transport: 'connected',
      httpStatus: 200,
      body: JSON.stringify([
        {
          id: 'action-2',
          kind: 'browser.reload',
          target: 'page-2',
          payload: { tabId: 'page-2', command: 'reload' }
        }
      ])
    })
    const unregister = registerTauriBrowserActionExecutor('page-2', async () => ({
      url: 'https://example.com',
      title: 'Example'
    }))

    await expect(consumeTauriBrowserActionsOnce()).resolves.toBe(1)

    expect(requestRuntimeResourceJsonMock).not.toHaveBeenCalled()
    expect(updateBrowserActionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        actionId: 'action-2',
        status: 'completed',
        resultJson: JSON.stringify({ url: 'https://example.com', title: 'Example' })
      })
    )

    unregister()
  })

  it('rejects a stale executor result after the WebView generation changes', async () => {
    let finish: ((result: Record<string, unknown>) => void) | undefined
    const unregister = registerTauriBrowserActionExecutor(
      'page-stale',
      () => new Promise((resolve) => (finish = resolve))
    )
    pollBrowserActionsMock.mockResolvedValue({
      transport: 'connected',
      httpStatus: 200,
      body: JSON.stringify([
        { id: 'action-stale', kind: 'browser.reload', target: 'page-stale', payload: {} }
      ])
    })

    const consuming = consumeTauriBrowserActionsOnce()
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    unregister()
    const unregisterReplacement = registerTauriBrowserActionExecutor('page-stale', async () => ({
      replaced: true
    }))
    finish?.({ url: 'https://stale.example' })
    await consuming

    expect(updateBrowserActionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        actionId: 'action-stale',
        status: 'failed',
        errorMessage: expect.stringContaining('ownership changed')
      })
    )
    unregisterReplacement()
  })

  it('does not turn an empty adapter response into a successful action', async () => {
    const unregister = registerTauriBrowserActionExecutor('page-empty', async () => ({}))
    pollBrowserActionsMock.mockResolvedValue({
      transport: 'connected',
      httpStatus: 200,
      body: JSON.stringify([
        { id: 'action-empty', kind: 'browser.click', target: 'page-empty', payload: {} }
      ])
    })

    await consumeTauriBrowserActionsOnce()

    expect(updateBrowserActionMock).toHaveBeenCalledWith(
      expect.objectContaining({ actionId: 'action-empty', status: 'failed' })
    )
    unregister()
  })
})
