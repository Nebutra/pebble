import { beforeEach, describe, expect, it, vi } from 'vitest'

const { requestRuntimeJsonMock, detectBrowsersMock } = vi.hoisted(() => ({
  requestRuntimeJsonMock: vi.fn(),
  detectBrowsersMock: vi.fn()
}))

vi.mock('./pebble-tauri-runtime-transport', () => ({
  requestRuntimeJson: requestRuntimeJsonMock
}))

vi.mock('./tauri-browser-runtime-profiles', () => ({
  detectTauriBrowserSessionBrowsers: detectBrowsersMock
}))

import { callTauriBrowserRuntimeRpc } from './tauri-browser-runtime-rpc'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('callTauriBrowserRuntimeRpc', () => {
  it('queues browser.goto through the runtime browser provider action path', async () => {
    requestRuntimeJsonMock.mockImplementation(async (path: string, options?: { method?: string }) => {
      if (path === '/v1/browser/tabs' && options?.method === 'GET') {
        return [{ id: 'page-1', url: 'about:blank', title: 'Blank' }]
      }
      if (path === '/v1/browser/tabs/page-1' && options?.method === 'PATCH') {
        return { id: 'page-1', url: 'https://example.com', title: 'https://example.com' }
      }
      if (path === '/v1/browser/tabs/page-1/commands' && options?.method === 'POST') {
        return { id: 'action-1', kind: 'browser.goto' }
      }
      throw new Error(`unexpected runtime request ${path}`)
    })

    await expect(
      callTauriBrowserRuntimeRpc('browser.goto', {
        page: 'page-1',
        url: 'https://example.com'
      })
    ).resolves.toEqual({
      handled: true,
      result: {
        url: 'https://example.com',
        title: 'https://example.com'
      }
    })

    expect(requestRuntimeJsonMock).toHaveBeenCalledWith('/v1/browser/tabs/page-1', {
      method: 'PATCH',
      body: {
        url: 'https://example.com',
        title: 'https://example.com',
        status: 'loading'
      }
    })
    expect(requestRuntimeJsonMock).toHaveBeenCalledWith('/v1/browser/tabs/page-1/commands', {
      method: 'POST',
      body: {
        command: 'goto',
        payload: { url: 'https://example.com' }
      }
    })
  })

  it('queues browser.reload without changing the known tab URL', async () => {
    requestRuntimeJsonMock.mockImplementation(async (path: string, options?: { method?: string }) => {
      if (path === '/v1/browser/tabs' && options?.method === 'GET') {
        return [{ id: 'page-1', url: 'https://example.com', title: 'Example' }]
      }
      if (path === '/v1/browser/tabs/page-1' && options?.method === 'PATCH') {
        return { id: 'page-1', url: 'https://example.com', title: 'Example' }
      }
      if (path === '/v1/browser/tabs/page-1/commands' && options?.method === 'POST') {
        return { id: 'action-2', kind: 'browser.reload' }
      }
      throw new Error(`unexpected runtime request ${path}`)
    })

    await expect(
      callTauriBrowserRuntimeRpc('browser.reload', { page: 'page-1' })
    ).resolves.toEqual({
      handled: true,
      result: {
        url: 'https://example.com',
        title: 'Example'
      }
    })

    expect(requestRuntimeJsonMock).toHaveBeenCalledWith('/v1/browser/tabs/page-1', {
      method: 'PATCH',
      body: { status: 'loading' }
    })
    expect(requestRuntimeJsonMock).toHaveBeenCalledWith('/v1/browser/tabs/page-1/commands', {
      method: 'POST',
      body: {
        command: 'reload',
        payload: {}
      }
    })
  })

  it('echoes browser viewport requests as a deterministic fallback', async () => {
    await expect(
      callTauriBrowserRuntimeRpc('browser.viewport', {
        width: 390,
        height: 844,
        deviceScaleFactor: 3,
        mobile: true
      })
    ).resolves.toEqual({
      handled: true,
      result: {
        width: 390,
        height: 844,
        deviceScaleFactor: 3,
        mobile: true
      }
    })
  })
})
