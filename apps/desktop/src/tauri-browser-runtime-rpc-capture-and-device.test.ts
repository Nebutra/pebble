import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  requestRuntimeJsonMock,
  detectBrowsersMock,
  evaluateBrowserPageExpressionMock,
  importBrowserCookiesMock,
  clearDefaultCookiesMock,
  clearPageCookiesMock,
  getCookiesMock,
  setCookieMock,
  deleteCookieMock,
  setPageHeadersMock,
  setPageOfflineMock,
  setPageCredentialsMock,
  setPageDeviceEmulationMock,
  resolvePageDialogMock,
  openPageDevToolsMock,
  notifyActiveTabMock,
  enableNavigationInterceptionMock,
  disableNavigationInterceptionMock,
  listNavigationInterceptionsMock,
  resolveBrowserRequestMock,
  invokeMock
} = vi.hoisted(() => ({
  requestRuntimeJsonMock: vi.fn(),
  detectBrowsersMock: vi.fn(),
  evaluateBrowserPageExpressionMock: vi.fn(),
  importBrowserCookiesMock: vi.fn(),
  clearDefaultCookiesMock: vi.fn(),
  clearPageCookiesMock: vi.fn(),
  getCookiesMock: vi.fn(),
  setCookieMock: vi.fn(),
  deleteCookieMock: vi.fn(),
  setPageHeadersMock: vi.fn(),
  setPageOfflineMock: vi.fn(),
  setPageCredentialsMock: vi.fn(),
  setPageDeviceEmulationMock: vi.fn(),
  resolvePageDialogMock: vi.fn(),
  openPageDevToolsMock: vi.fn(),
  notifyActiveTabMock: vi.fn(),
  enableNavigationInterceptionMock: vi.fn(),
  disableNavigationInterceptionMock: vi.fn(),
  listNavigationInterceptionsMock: vi.fn(),
  resolveBrowserRequestMock: vi.fn(),
  invokeMock: vi.fn()
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

vi.mock('./pebble-tauri-runtime-transport', () => ({
  requestRuntimeJson: requestRuntimeJsonMock
}))

vi.mock('./tauri-browser-runtime-profiles', () => ({
  detectTauriBrowserSessionBrowsers: detectBrowsersMock
}))

vi.mock('./tauri-browser-runtime-events', () => ({
  notifyTauriBrowserActiveTab: notifyActiveTabMock
}))

vi.mock('./tauri-browser-navigation-interception', () => ({
  enableTauriBrowserNavigationInterception: enableNavigationInterceptionMock,
  disableTauriBrowserNavigationInterception: disableNavigationInterceptionMock,
  listTauriBrowserNavigationInterceptions: listNavigationInterceptionsMock,
  resolveTauriBrowserRequest: resolveBrowserRequestMock,
  tauriBrowserInterceptionScopes: (scope: string) => [scope, 'document-main-frame-fetch-async-xhr']
}))

vi.mock('@/components/browser-pane/tauri-browser-page-webview', () => ({
  evaluateTauriBrowserPageExpression: evaluateBrowserPageExpressionMock,
  importTauriBrowserCookiesFromBrowser: importBrowserCookiesMock,
  clearTauriBrowserDefaultCookies: clearDefaultCookiesMock,
  clearTauriBrowserPageCookies: clearPageCookiesMock,
  getTauriBrowserCookies: getCookiesMock,
  setTauriBrowserCookie: setCookieMock,
  deleteTauriBrowserCookie: deleteCookieMock,
  setTauriBrowserPageHeaders: setPageHeadersMock,
  setTauriBrowserPageOffline: setPageOfflineMock,
  setTauriBrowserPageCredentials: setPageCredentialsMock,
  setTauriBrowserPageDeviceEmulation: setPageDeviceEmulationMock,
  resolveTauriBrowserPageDialog: resolvePageDialogMock,
  openTauriBrowserPageDevTools: openPageDevToolsMock
}))

import { callTauriBrowserRuntimeRpc } from './tauri-browser-runtime-rpc'
import { resetTauriComputerActionWaiterForTests } from './tauri-computer-action-waiter'
import {
  clearTauriBrowserViewportOverrides,
  setTauriBrowserViewportOverride
} from './tauri-browser-viewport-state'

beforeEach(() => {
  resetTauriComputerActionWaiterForTests()
  vi.clearAllMocks()
  clearTauriBrowserViewportOverrides()
  setPageDeviceEmulationMock.mockResolvedValue({
    applied: true,
    scope: 'native-request-and-document-device'
  })
})

describe('callTauriBrowserRuntimeRpc', () => {
  it('queues canonical ref interactions through the browser provider', async () => {
    requestRuntimeJsonMock.mockImplementation(
      async (path: string, options?: { method?: string }) => {
        if (path === '/v1/browser/tabs/page-1/commands' && options?.method === 'POST') {
          return {
            id: 'action-click',
            kind: 'browser.click',
            status: 'queued'
          }
        }
        if (path === '/v1/computer/actions?kindPrefix=browser.' && options?.method === 'GET') {
          return [
            {
              id: 'action-click',
              kind: 'browser.click',
              status: 'completed',
              result: { clicked: '@e4' }
            }
          ]
        }
        throw new Error(`unexpected runtime request ${path}`)
      }
    )

    await expect(
      callTauriBrowserRuntimeRpc('browser.click', {
        page: 'page-1',
        worktree: 'id:worktree-1',
        element: '@e4'
      })
    ).resolves.toEqual({ handled: true, result: { clicked: '@e4' } })

    expect(requestRuntimeJsonMock).toHaveBeenCalledWith('/v1/browser/tabs/page-1/commands', {
      method: 'POST',
      body: { command: 'click', payload: { element: '@e4' } }
    })
  })

  it.each([
    ['browser.storage.local.get', 'storageLocalGet', { key: 'theme' }],
    ['browser.storage.session.set', 'storageSessionSet', { key: 'tab', value: 'one' }],
    ['browser.highlight', 'highlight', { selector: '@e2' }],
    ['browser.mouseMove', 'mouseMove', { x: 10, y: 20 }],
    ['browser.mouseWheel', 'mouseWheel', { dx: 0, dy: 50 }]
  ])('queues %s through the native browser interaction path', async (method, command, payload) => {
    requestRuntimeJsonMock.mockImplementation(
      async (path: string, options?: { method?: string }) => {
        if (path === '/v1/browser/tabs/page-1/commands' && options?.method === 'POST') {
          return { id: `action-${command}`, kind: method, status: 'queued' }
        }
        if (path === '/v1/computer/actions?kindPrefix=browser.' && options?.method === 'GET') {
          return [
            {
              id: `action-${command}`,
              kind: method,
              status: 'completed',
              result: { ok: true }
            }
          ]
        }
        throw new Error(`unexpected runtime request ${path}`)
      }
    )

    await expect(
      callTauriBrowserRuntimeRpc(method, { page: 'page-1', ...payload })
    ).resolves.toEqual({ handled: true, result: { ok: true } })
    expect(requestRuntimeJsonMock).toHaveBeenCalledWith('/v1/browser/tabs/page-1/commands', {
      method: 'POST',
      body: { command, payload }
    })
  })

  it('queues browser.upload with local paths for the native adapter', async () => {
    requestRuntimeJsonMock.mockImplementation(
      async (path: string, options?: { method?: string }) => {
        if (path === '/v1/browser/tabs/page-1/commands' && options?.method === 'POST') {
          return {
            id: 'action-upload',
            kind: 'browser.upload',
            status: 'queued'
          }
        }
        if (path === '/v1/computer/actions?kindPrefix=browser.' && options?.method === 'GET') {
          return [
            {
              id: 'action-upload',
              kind: 'browser.upload',
              status: 'completed',
              result: { uploaded: 2 }
            }
          ]
        }
        throw new Error(`unexpected runtime request ${path}`)
      }
    )

    await expect(
      callTauriBrowserRuntimeRpc('browser.upload', {
        page: 'page-1',
        element: '@e2',
        files: ['/tmp/one.txt', '/tmp/two.png']
      })
    ).resolves.toEqual({ handled: true, result: { uploaded: 2 } })

    expect(requestRuntimeJsonMock).toHaveBeenCalledWith('/v1/browser/tabs/page-1/commands', {
      method: 'POST',
      body: {
        command: 'upload',
        payload: { element: '@e2', files: ['/tmp/one.txt', '/tmp/two.png'] }
      }
    })
  })

  it('queues browser.download until the native adapter reports completion', async () => {
    requestRuntimeJsonMock.mockImplementation(
      async (path: string, options?: { method?: string }) => {
        if (path === '/v1/browser/tabs/page-1/commands' && options?.method === 'POST') {
          return {
            id: 'action-download',
            kind: 'browser.download',
            status: 'queued'
          }
        }
        if (path === '/v1/computer/actions?kindPrefix=browser.' && options?.method === 'GET') {
          return [
            {
              id: 'action-download',
              kind: 'browser.download',
              status: 'completed',
              result: { path: '/tmp/report.pdf' }
            }
          ]
        }
        throw new Error(`unexpected runtime request ${path}`)
      }
    )
    await expect(
      callTauriBrowserRuntimeRpc('browser.download', {
        page: 'page-1',
        selector: '@e2',
        path: '/tmp/report.pdf'
      })
    ).resolves.toEqual({ handled: true, result: { path: '/tmp/report.pdf' } })
  })

  it('queues geolocation overrides through the live child WebView', async () => {
    requestRuntimeJsonMock.mockImplementation(
      async (path: string, options?: { method?: string }) => {
        if (path === '/v1/browser/tabs/page-1/commands' && options?.method === 'POST') {
          return {
            id: 'action-geo',
            kind: 'browser.geolocation',
            status: 'queued'
          }
        }
        if (path === '/v1/computer/actions?kindPrefix=browser.' && options?.method === 'GET') {
          return [
            {
              id: 'action-geo',
              kind: 'browser.geolocation',
              status: 'completed',
              result: {
                latitude: 31.2304,
                longitude: 121.4737,
                accuracy: 5
              }
            }
          ]
        }
        throw new Error(`unexpected runtime request ${path}`)
      }
    )
    await expect(
      callTauriBrowserRuntimeRpc('browser.geolocation', {
        page: 'page-1',
        latitude: 31.2304,
        longitude: 121.4737,
        accuracy: 5
      })
    ).resolves.toEqual({
      handled: true,
      result: {
        latitude: 31.2304,
        longitude: 121.4737,
        accuracy: 5
      }
    })
  })

  it('queues browser.screenshot and returns the provider-completed image payload', async () => {
    requestRuntimeJsonMock.mockImplementation(
      async (path: string, options?: { method?: string }) => {
        if (path === '/v1/browser/tabs/page-1/commands' && options?.method === 'POST') {
          return {
            id: 'action-shot',
            kind: 'browser.screenshot',
            status: 'queued'
          }
        }
        if (path === '/v1/computer/actions?kindPrefix=browser.' && options?.method === 'GET') {
          return [
            {
              id: 'action-shot',
              kind: 'browser.screenshot',
              status: 'completed',
              result: { data: 'base64-shot', format: 'png' }
            }
          ]
        }
        throw new Error(`unexpected runtime request ${path}`)
      }
    )

    await expect(
      callTauriBrowserRuntimeRpc('browser.screenshot', {
        page: 'page-1',
        format: 'png'
      })
    ).resolves.toEqual({
      handled: true,
      result: {
        data: 'base64-shot',
        format: 'png'
      }
    })

    expect(requestRuntimeJsonMock).toHaveBeenCalledWith('/v1/browser/tabs/page-1/commands', {
      method: 'POST',
      body: {
        command: 'screenshot',
        payload: { format: 'png' }
      }
    })
  })

  it('queues browser.pdf and returns the native PDF payload', async () => {
    requestRuntimeJsonMock.mockImplementation(
      async (path: string, options?: { method?: string }) => {
        if (path === '/v1/browser/tabs/page-1/commands' && options?.method === 'POST') {
          return { id: 'action-pdf', kind: 'browser.pdf', status: 'queued' }
        }
        if (path === '/v1/computer/actions?kindPrefix=browser.' && options?.method === 'GET') {
          return [
            {
              id: 'action-pdf',
              kind: 'browser.pdf',
              status: 'completed',
              result: { data: 'JVBERi0xLjQ=' }
            }
          ]
        }
        throw new Error(`unexpected runtime request ${path}`)
      }
    )
    await expect(callTauriBrowserRuntimeRpc('browser.pdf', { page: 'page-1' })).resolves.toEqual({
      handled: true,
      result: { data: 'JVBERi0xLjQ=' }
    })
  })

  it('surfaces browser.screenshot provider failures instead of returning fake image data', async () => {
    requestRuntimeJsonMock.mockImplementation(
      async (path: string, options?: { method?: string }) => {
        if (path === '/v1/browser/tabs/page-1/commands' && options?.method === 'POST') {
          return {
            id: 'action-shot',
            kind: 'browser.screenshot',
            status: 'queued'
          }
        }
        if (path === '/v1/computer/actions?kindPrefix=browser.' && options?.method === 'GET') {
          return [
            {
              id: 'action-shot',
              kind: 'browser.screenshot',
              status: 'failed',
              error: 'native screenshot adapter unavailable'
            }
          ]
        }
        throw new Error(`unexpected runtime request ${path}`)
      }
    )

    await expect(
      callTauriBrowserRuntimeRpc('browser.screenshot', { page: 'page-1' })
    ).rejects.toThrow('native screenshot adapter unavailable')
  })

  it('evaluates browser expressions in the live Tauri child WebView', async () => {
    evaluateBrowserPageExpressionMock.mockResolvedValueOnce({
      result: '{"width":1280,"height":720}',
      origin: 'https://example.com'
    })

    await expect(
      callTauriBrowserRuntimeRpc('browser.eval', {
        page: 'page-1',
        expression: 'JSON.stringify({ width: innerWidth, height: innerHeight })'
      })
    ).resolves.toEqual({
      handled: true,
      result: {
        result: '{"width":1280,"height":720}',
        origin: 'https://example.com'
      }
    })
    expect(evaluateBrowserPageExpressionMock).toHaveBeenCalledWith(
      'page-1',
      'JSON.stringify({ width: innerWidth, height: innerHeight })'
    )
  })

  it('dispatches browser.exec through already migrated native RPC methods', async () => {
    requestRuntimeJsonMock.mockImplementation(
      async (path: string, options?: { method?: string }) => {
        if (path === '/v1/browser/tabs/page-1/commands' && options?.method === 'POST') {
          return {
            id: 'action-exec-click',
            kind: 'browser.click',
            status: 'queued'
          }
        }
        if (path === '/v1/computer/actions?kindPrefix=browser.' && options?.method === 'GET') {
          return [
            {
              id: 'action-exec-click',
              kind: 'browser.click',
              status: 'completed',
              result: { clicked: '@e3' }
            }
          ]
        }
        throw new Error(`unexpected runtime request ${path}`)
      }
    )
    await expect(
      callTauriBrowserRuntimeRpc('browser.exec', {
        page: 'page-1',
        command: 'click @e3'
      })
    ).resolves.toEqual({ handled: true, result: { clicked: '@e3' } })
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

  it('reads stored Tauri browser viewport overrides when no explicit size is passed', async () => {
    setTauriBrowserViewportOverride({
      browserPageId: 'page-2',
      override: {
        width: 425,
        height: 812,
        deviceScaleFactor: 2,
        mobile: true
      }
    })

    await expect(
      callTauriBrowserRuntimeRpc('browser.viewport', { page: 'page-2' })
    ).resolves.toEqual({
      handled: true,
      result: {
        width: 425,
        height: 812,
        deviceScaleFactor: 2,
        mobile: true
      }
    })
  })

  it('maps browser.setDevice names onto canonical viewport presets', async () => {
    await expect(
      callTauriBrowserRuntimeRpc('browser.setDevice', {
        page: 'page-2',
        name: 'iPhone 13'
      })
    ).resolves.toEqual({
      handled: true,
      result: {
        name: 'iphone 13',
        presetId: 'mobile-m',
        width: 375,
        height: 667,
        deviceScaleFactor: 2,
        mobile: true,
        applied: true,
        scope: 'native-request-and-document-device'
      }
    })
    expect(setPageDeviceEmulationMock).toHaveBeenCalledWith('page-2', {
      name: 'iphone 13',
      width: 375,
      height: 667,
      deviceScaleFactor: 2,
      mobile: true
    })
    await expect(
      callTauriBrowserRuntimeRpc('browser.viewport', { page: 'page-2' })
    ).resolves.toMatchObject({
      handled: true,
      result: { width: 375, height: 667, deviceScaleFactor: 2, mobile: true }
    })
    await expect(
      callTauriBrowserRuntimeRpc('browser.setDevice', {
        page: 'page-2',
        name: 'Unknown Phone'
      })
    ).rejects.toThrow('Unsupported browser device')
  })

  it('routes browser.setHeaders directly to the transient child WebView adapter', async () => {
    setPageHeadersMock.mockResolvedValueOnce({
      applied: 1,
      scope: 'fetch-xhr'
    })
    await expect(
      callTauriBrowserRuntimeRpc('browser.setHeaders', {
        page: 'page-2',
        headers: '{"Authorization":"Bearer test"}'
      })
    ).resolves.toEqual({
      handled: true,
      result: { applied: 1, scope: 'fetch-xhr' }
    })
    expect(setPageHeadersMock).toHaveBeenCalledWith('page-2', '{"Authorization":"Bearer test"}')
    expect(requestRuntimeJsonMock).not.toHaveBeenCalled()
  })

  it('routes browser.setOffline directly to the transient child WebView adapter', async () => {
    setPageOfflineMock.mockResolvedValueOnce({
      offline: true,
      scope: 'fetch-xhr'
    })
    await expect(
      callTauriBrowserRuntimeRpc('browser.setOffline', {
        page: 'page-2',
        state: 'on'
      })
    ).resolves.toEqual({
      handled: true,
      result: { offline: true, scope: 'fetch-xhr' }
    })
    expect(setPageOfflineMock).toHaveBeenCalledWith('page-2', 'on')
    expect(requestRuntimeJsonMock).not.toHaveBeenCalled()
  })

  it('routes browser.setCredentials directly without persisting secrets in Go actions', async () => {
    setPageCredentialsMock.mockResolvedValueOnce({
      configured: true,
      scope: 'fetch-xhr-basic'
    })
    await expect(
      callTauriBrowserRuntimeRpc('browser.setCredentials', {
        page: 'page-2',
        user: 'dev',
        pass: 'secret'
      })
    ).resolves.toEqual({
      handled: true,
      result: { configured: true, scope: 'fetch-xhr-basic' }
    })
    expect(setPageCredentialsMock).toHaveBeenCalledWith('page-2', 'dev', 'secret')
    expect(requestRuntimeJsonMock).not.toHaveBeenCalled()
  })
})
