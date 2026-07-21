import { beforeEach, describe, expect, it, vi } from 'vitest'

const { executeLocally, requestRuntimeJson, waitForAction } = vi.hoisted(() => ({
  executeLocally: vi.fn(),
  requestRuntimeJson: vi.fn(),
  waitForAction: vi.fn()
}))

vi.mock('./pebble-tauri-runtime-transport', () => ({ requestRuntimeJson }))
vi.mock('./tauri-browser-action-consumer', () => ({
  executeTauriBrowserActionLocally: executeLocally
}))
vi.mock('./tauri-browser-provider-action-result', () => ({
  getTauriBrowserProviderActionCursor: () => 41,
  waitForTauriBrowserProviderAction: waitForAction
}))

import { queueTauriBrowserInteraction } from './tauri-browser-interaction-rpc'

describe('queueTauriBrowserInteraction', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requestRuntimeJson.mockResolvedValue({ id: 'action-1', status: 'queued' })
    executeLocally.mockResolvedValue(null)
    waitForAction.mockResolvedValue({
      id: 'action-1',
      status: 'completed',
      result: { accepted: true }
    })
  })

  it('falls back to the runtime queue when the page has no local owner', async () => {
    await expect(
      queueTauriBrowserInteraction('click', { page: 'page-1', element: '#target' })
    ).resolves.toEqual({ accepted: true })

    expect(executeLocally).toHaveBeenCalledWith('page-1', 'click', { element: '#target' })
    expect(requestRuntimeJson).toHaveBeenCalledWith('/v1/browser/tabs/page-1/commands', {
      method: 'POST',
      body: { command: 'click', payload: { element: '#target' } }
    })
    expect(waitForAction).toHaveBeenCalledWith('action-1', 41)
  })

  it('executes directly when this renderer owns the WebView', async () => {
    executeLocally.mockResolvedValue({ clicked: '#target' })

    await expect(
      queueTauriBrowserInteraction('click', { page: 'page-1', element: '#target' })
    ).resolves.toEqual({ clicked: '#target' })

    expect(requestRuntimeJson).not.toHaveBeenCalled()
    expect(waitForAction).not.toHaveBeenCalled()
  })
})
