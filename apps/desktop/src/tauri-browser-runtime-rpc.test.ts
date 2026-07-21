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
  it('preserves the selected worktree as the video output owner', async () => {
    requestRuntimeJsonMock.mockImplementation(
      async (path: string, options?: { method?: string; body?: unknown }) => {
        if (path === '/v1/browser/tabs/page-1/commands') {
          return { id: 'record-1', kind: 'browser.recordingStart', status: 'queued' }
        }
        if (path === '/v1/computer/actions?kindPrefix=browser.') {
          return [{ id: 'record-1', kind: 'browser.recordingStart', status: 'completed' }]
        }
        throw new Error(`Unexpected request: ${path} ${options?.method}`)
      }
    )
    await expect(
      callTauriBrowserRuntimeRpc('browser.recordingStart', {
        page: 'page-1',
        worktree: 'id:wt-1',
        path: 'videos/demo.webm'
      })
    ).resolves.toEqual({ handled: true, result: {} })
    expect(requestRuntimeJsonMock).toHaveBeenCalledWith('/v1/browser/tabs/page-1/commands', {
      method: 'POST',
      body: {
        command: 'recordingStart',
        payload: { path: 'videos/demo.webm', outputWorktree: 'id:wt-1' }
      }
    })
  })

  it('saves captured bytes relative to the selected local worktree', async () => {
    vi.stubGlobal('window', {
      api: {
        worktrees: {
          listAll: vi.fn().mockResolvedValue([{ id: 'wt-1', path: '/workspace/project' }])
        }
      }
    })
    invokeMock.mockResolvedValue('/workspace/project/artifacts/page.pdf')
    await expect(
      callTauriBrowserRuntimeRpc('browser.captureSave', {
        page: 'page-1',
        worktree: 'id:wt-1',
        path: 'artifacts/page.pdf',
        capture: { data: 'cGRm', format: 'pdf' }
      })
    ).resolves.toEqual({
      handled: true,
      result: { path: '/workspace/project/artifacts/page.pdf' }
    })
    expect(invokeMock).toHaveBeenCalledWith('browser_capture_save', {
      input: {
        path: 'artifacts/page.pdf',
        baseDir: '/workspace/project',
        dataBase64: 'cGRm',
        kind: 'pdf'
      }
    })
    vi.unstubAllGlobals()
  })

  it('opens devtools only through the targeted native child WebView', async () => {
    openPageDevToolsMock.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    await expect(
      callTauriBrowserRuntimeRpc('browser.inspect', { page: 'page-1' })
    ).resolves.toEqual({ handled: true, result: { opened: true } })
    await expect(
      callTauriBrowserRuntimeRpc('browser.inspect', { page: 'page-missing' })
    ).resolves.toEqual({ handled: true, result: { opened: false } })
    expect(openPageDevToolsMock.mock.calls).toEqual([['page-1'], ['page-missing']])
  })

  it('combines native top-level and document request interception', async () => {
    let lastCommand = ''
    requestRuntimeJsonMock.mockImplementation(
      async (path: string, options?: { method?: string; body?: { command?: string } }) => {
        if (path === '/v1/browser/tabs/page-1/commands' && options?.method === 'POST') {
          lastCommand = options.body?.command ?? ''
          return { id: `action-${lastCommand}`, kind: `browser.${lastCommand}`, status: 'queued' }
        }
        if (path === '/v1/computer/actions?kindPrefix=browser.' && options?.method === 'GET') {
          const result =
            lastCommand === 'interceptList'
              ? {
                  requests: [
                    { id: 'document-1', url: 'https://example.com/api', resourceType: 'fetch' }
                  ]
                }
              : lastCommand === 'interceptDisable'
                ? { disabled: true }
                : { enabled: true }
          return [
            {
              id: `action-${lastCommand}`,
              kind: `browser.${lastCommand}`,
              status: 'completed',
              result
            }
          ]
        }
        throw new Error(`unexpected runtime request ${path}`)
      }
    )
    enableNavigationInterceptionMock.mockResolvedValue({
      enabled: true,
      patterns: ['https://example.com/**', 'https://example.com/api/**'],
      routes: [],
      scope: 'native-subresources'
    })

    const routes = [
      { pattern: 'https://example.com/**', action: 'abort' },
      {
        pattern: 'https://example.com/api/**',
        action: 'fulfill',
        body: '{"native":true}',
        status: 202,
        contentType: 'application/json'
      }
    ]

    await expect(
      callTauriBrowserRuntimeRpc('browser.intercept.enable', {
        page: 'page-1',
        routes
      })
    ).resolves.toMatchObject({
      handled: true,
      result: {
        enabled: true,
        scopes: ['native-subresources', 'document-main-frame-fetch-async-xhr']
      }
    })
    expect(enableNavigationInterceptionMock).toHaveBeenCalledWith('page-1', routes)

    listNavigationInterceptionsMock.mockResolvedValue({
      requests: [{ id: 'native-1', url: 'https://example.com/a', resourceType: 'document' }],
      scope: 'top-level-navigation'
    })
    await expect(
      callTauriBrowserRuntimeRpc('browser.intercept.list', { page: 'page-1' })
    ).resolves.toMatchObject({
      result: { requests: [{ id: 'native-1' }, { id: 'document-1' }] }
    })

    disableNavigationInterceptionMock.mockResolvedValue(true)
    await expect(
      callTauriBrowserRuntimeRpc('browser.intercept.disable', { page: 'page-1' })
    ).resolves.toMatchObject({ result: { disabled: true, nativeDisabled: true } })
  })

  it('uses native and document paused requests when enable receives patterns', async () => {
    enableNavigationInterceptionMock.mockResolvedValue({
      enabled: true,
      patterns: ['https://example.com/**'],
      routes: [{ pattern: 'https://example.com/**', action: 'pause' }],
      scope: 'native-top-level-and-windows-request-control'
    })

    await expect(
      callTauriBrowserRuntimeRpc('browser.intercept.enable', {
        page: 'page-1',
        patterns: ['https://example.com/**']
      })
    ).resolves.toMatchObject({
      result: {
        enabled: true,
        scopes: [
          'native-top-level-and-windows-request-control',
          'document-main-frame-fetch-async-xhr'
        ]
      }
    })
    expect(enableNavigationInterceptionMock).toHaveBeenCalledWith('page-1', [
      { pattern: 'https://example.com/**', action: 'pause' }
    ])
    expect(requestRuntimeJsonMock).toHaveBeenCalled()
  })

  it('resolves a paused request by tab and request identity', async () => {
    resolveBrowserRequestMock.mockResolvedValue(true)

    await callTauriBrowserRuntimeRpc('browser.intercept.continue', {
      page: 'page-1',
      requestId: 'request-1'
    })
    await callTauriBrowserRuntimeRpc('browser.intercept.fulfill', {
      page: 'page-1',
      requestId: 'request-2',
      status: 201,
      body: 'created',
      headers: { 'content-type': 'text/plain' }
    })
    await callTauriBrowserRuntimeRpc('browser.intercept.fail', {
      page: 'page-1',
      requestId: 'request-3',
      reason: 'policy denied'
    })

    expect(resolveBrowserRequestMock.mock.calls).toEqual([
      ['page-1', 'request-1', { action: 'continue' }],
      [
        'page-1',
        'request-2',
        {
          action: 'fulfill',
          body: 'created',
          status: 201,
          headers: { 'content-type': 'text/plain' }
        }
      ],
      ['page-1', 'request-3', { action: 'fail', reason: 'policy denied' }]
    ])
  })

  it('routes JavaScript dialog accept and dismiss to the native child WebView', async () => {
    resolvePageDialogMock.mockResolvedValue({ handled: true })

    await expect(
      callTauriBrowserRuntimeRpc('browser.dialogAccept', {
        page: 'page-1',
        text: 'answer'
      })
    ).resolves.toEqual({ handled: true, result: { handled: true } })
    await expect(
      callTauriBrowserRuntimeRpc('browser.dialogDismiss', { page: 'page-1' })
    ).resolves.toEqual({ handled: true, result: { handled: true } })

    expect(resolvePageDialogMock.mock.calls).toEqual([
      ['page-1', true, 'answer'],
      ['page-1', false, undefined]
    ])
  })

  it('routes runtime cookie imports through the live native WebView adapter', async () => {
    importBrowserCookiesMock.mockResolvedValueOnce({
      ok: true,
      summary: { imported: 12, skipped: 1 }
    })

    await expect(
      callTauriBrowserRuntimeRpc('browser.profileImportFromBrowser', {
        profileId: 'profile-1',
        browserFamily: 'firefox',
        browserProfile: 'default-release'
      })
    ).resolves.toEqual({
      handled: true,
      result: { ok: true, summary: { imported: 12, skipped: 1 } }
    })
    expect(importBrowserCookiesMock).toHaveBeenCalledWith({
      profileId: 'profile-1',
      browserFamily: 'firefox',
      browserProfile: 'default-release'
    })
  })

  it('clears runtime default cookies through the live native WebView adapter', async () => {
    clearDefaultCookiesMock.mockResolvedValueOnce(true)

    await expect(
      callTauriBrowserRuntimeRpc('browser.profileClearDefaultCookies', null)
    ).resolves.toEqual({ handled: true, result: { cleared: true } })
  })

  it('routes cookie management through the native WebView cookie store', async () => {
    getCookiesMock.mockResolvedValueOnce({ cookies: [{ name: 'session' }] })
    setCookieMock.mockResolvedValueOnce({ success: true })
    deleteCookieMock.mockResolvedValueOnce({ deleted: true })

    await expect(
      callTauriBrowserRuntimeRpc('browser.cookie.get', {
        page: 'page-1',
        url: 'https://example.com/account'
      })
    ).resolves.toEqual({
      handled: true,
      result: { cookies: [{ name: 'session' }] }
    })
    expect(getCookiesMock).toHaveBeenCalledWith('page-1', 'https://example.com/account')

    await expect(
      callTauriBrowserRuntimeRpc('browser.cookie.set', {
        page: 'page-1',
        name: 'session',
        value: '',
        domain: 'example.com',
        httpOnly: true
      })
    ).resolves.toEqual({ handled: true, result: { success: true } })
    expect(setCookieMock).toHaveBeenCalledWith(
      'page-1',
      expect.objectContaining({
        name: 'session',
        value: '',
        domain: 'example.com',
        httpOnly: true
      })
    )

    await expect(
      callTauriBrowserRuntimeRpc('browser.cookie.delete', {
        page: 'page-1',
        name: 'session'
      })
    ).resolves.toEqual({ handled: true, result: { deleted: true } })
    expect(deleteCookieMock).toHaveBeenCalledWith('page-1', {
      name: 'session',
      domain: undefined,
      url: undefined
    })
  })

  it('clears only the targeted live browser page cookie store', async () => {
    clearPageCookiesMock.mockResolvedValueOnce({ cleared: true })
    await expect(
      callTauriBrowserRuntimeRpc('browser.cookie.clear', { page: 'page-1' })
    ).resolves.toEqual({ handled: true, result: { cleared: true } })
    expect(clearPageCookiesMock).toHaveBeenCalledWith('page-1')
  })

  it('queues browser.goto through the runtime browser provider action path', async () => {
    requestRuntimeJsonMock.mockImplementation(
      async (path: string, options?: { method?: string }) => {
        if (path === '/v1/browser/tabs' && options?.method === 'GET') {
          return [{ id: 'page-1', url: 'about:blank', title: 'Blank' }]
        }
        if (path === '/v1/browser/tabs/page-1' && options?.method === 'PATCH') {
          return {
            id: 'page-1',
            url: 'https://example.com',
            title: 'https://example.com'
          }
        }
        if (path === '/v1/browser/tabs/page-1/commands' && options?.method === 'POST') {
          return { id: 'action-1', kind: 'browser.goto' }
        }
        if (path === '/v1/computer/actions?kindPrefix=browser.' && options?.method === 'GET') {
          return [
            {
              id: 'action-1',
              kind: 'browser.goto',
              status: 'completed',
              result: { url: 'https://example.com', title: 'example.com' }
            }
          ]
        }
        throw new Error(`unexpected runtime request ${path}`)
      }
    )

    await expect(
      callTauriBrowserRuntimeRpc('browser.goto', {
        page: 'page-1',
        url: 'https://example.com'
      })
    ).resolves.toEqual({
      handled: true,
      result: {
        url: 'https://example.com',
        title: 'example.com'
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
    requestRuntimeJsonMock.mockImplementation(
      async (path: string, options?: { method?: string }) => {
        if (path === '/v1/browser/tabs' && options?.method === 'GET') {
          return [{ id: 'page-1', url: 'https://example.com', title: 'Example' }]
        }
        if (path === '/v1/browser/tabs/page-1' && options?.method === 'PATCH') {
          return { id: 'page-1', url: 'https://example.com', title: 'Example' }
        }
        if (path === '/v1/browser/tabs/page-1/commands' && options?.method === 'POST') {
          return { id: 'action-2', kind: 'browser.reload' }
        }
        if (path === '/v1/computer/actions?kindPrefix=browser.' && options?.method === 'GET') {
          return [
            {
              id: 'action-2',
              kind: 'browser.reload',
              status: 'completed',
              result: { url: 'https://example.com', title: 'Example Reloaded' }
            }
          ]
        }
        throw new Error(`unexpected runtime request ${path}`)
      }
    )

    await expect(callTauriBrowserRuntimeRpc('browser.reload', { page: 'page-1' })).resolves.toEqual(
      {
        handled: true,
        result: {
          url: 'https://example.com',
          title: 'Example Reloaded'
        }
      }
    )

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

  it('tracks current tabs and switches by worktree-scoped index', async () => {
    requestRuntimeJsonMock.mockResolvedValue([
      { id: 'page-a', worktreeId: 'wt-1', url: 'https://a.test', title: 'A' },
      { id: 'page-b', worktreeId: 'wt-1', url: 'https://b.test', title: 'B' },
      { id: 'page-c', worktreeId: 'wt-2', url: 'https://c.test', title: 'C' }
    ])

    await expect(
      callTauriBrowserRuntimeRpc('browser.tabSwitch', {
        worktree: 'id:wt-1',
        index: 1,
        focus: true
      })
    ).resolves.toEqual({ handled: true, result: { browserPageId: 'page-b' } })
    expect(notifyActiveTabMock).toHaveBeenCalledWith('page-b')

    await expect(
      callTauriBrowserRuntimeRpc('browser.tabCurrent', {
        worktree: 'id:wt-1'
      })
    ).resolves.toMatchObject({
      handled: true,
      result: {
        tab: { browserPageId: 'page-b', active: true, worktreeId: 'wt-1' }
      }
    })
  })

  it('updates, shows, and clones real runtime tab profiles', async () => {
    requestRuntimeJsonMock.mockImplementation(
      async (path: string, options?: { method?: string; body?: Record<string, unknown> }) => {
        if (path === '/v1/browser/profiles') {
          return [{ id: 'profile-1', name: 'Work' }]
        }
        if (path === '/v1/browser/tabs' && options?.method === 'GET') {
          return [
            {
              id: 'page-1',
              worktreeId: 'wt-1',
              profileId: 'profile-1',
              url: 'https://example.com',
              title: 'Example'
            }
          ]
        }
        if (path === '/v1/browser/tabs/page-1' && options?.method === 'PATCH') {
          return {
            id: 'page-1',
            worktreeId: 'wt-1',
            profileId: options.body?.profileId,
            url: 'https://example.com',
            title: 'Example'
          }
        }
        if (path === '/v1/browser/tabs' && options?.method === 'POST') {
          return { id: 'page-clone', ...options.body }
        }
        throw new Error(`unexpected runtime request ${path}`)
      }
    )

    await expect(
      callTauriBrowserRuntimeRpc('browser.tabSetProfile', {
        page: 'page-1',
        profileId: 'profile-1'
      })
    ).resolves.toEqual({
      handled: true,
      result: {
        browserPageId: 'page-1',
        profileId: 'profile-1',
        profileLabel: 'Work'
      }
    })
    await expect(
      callTauriBrowserRuntimeRpc('browser.tabProfileShow', {
        page: 'page-1'
      })
    ).resolves.toMatchObject({
      handled: true,
      result: {
        browserPageId: 'page-1',
        profileId: 'profile-1',
        profileLabel: 'Work'
      }
    })
    await expect(
      callTauriBrowserRuntimeRpc('browser.tabProfileClone', {
        page: 'page-1',
        profileId: 'profile-1'
      })
    ).resolves.toEqual({
      handled: true,
      result: {
        browserPageId: 'page-clone',
        sourceBrowserPageId: 'page-1',
        profileId: 'profile-1'
      }
    })
  })

})
