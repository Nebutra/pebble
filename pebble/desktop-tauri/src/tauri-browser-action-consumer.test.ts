import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  pollBrowserActionsMock,
  requestRuntimeResourceJsonMock,
  updateBrowserActionMock
} = vi.hoisted(() => ({
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
  registerTauriBrowserActionExecutor
} from './tauri-browser-action-consumer'

beforeEach(() => {
  vi.clearAllMocks()
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
  it('fails claimed browser actions when no Tauri WebView adapter is registered', async () => {
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
})
