import { beforeEach, describe, expect, it, vi } from 'vitest'

const { disableNative, enableNative, queueInteraction } = vi.hoisted(() => ({
  disableNative: vi.fn(),
  enableNative: vi.fn(),
  queueInteraction: vi.fn()
}))

vi.mock('./tauri-browser-interaction-rpc', () => ({
  queueTauriBrowserInteraction: queueInteraction
}))

vi.mock('./tauri-browser-navigation-interception', () => ({
  disableTauriBrowserNavigationInterception: disableNative,
  enableTauriBrowserNavigationInterception: enableNative,
  listTauriBrowserNavigationInterceptions: vi.fn(),
  resolveTauriBrowserRequest: vi.fn(),
  tauriBrowserInterceptionScopes: (scope: string) => [scope, 'document-main-frame-fetch-async-xhr']
}))

vi.mock('@/components/browser-pane/tauri-browser-page-webview', () => ({
  deleteTauriBrowserCookie: vi.fn(),
  evaluateTauriBrowserPageExpression: vi.fn(),
  getTauriBrowserCookies: vi.fn(),
  setTauriBrowserCookie: vi.fn(),
  setTauriBrowserPageCredentials: vi.fn(),
  setTauriBrowserPageDeviceEmulation: vi.fn(),
  setTauriBrowserPageHeaders: vi.fn(),
  setTauriBrowserPageOffline: vi.fn()
}))

import { enableBrowserInterception } from './tauri-browser-page-control-rpc'

describe('Tauri browser interception activation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    disableNative.mockResolvedValue(true)
    enableNative.mockResolvedValue({
      enabled: true,
      scope: 'native-top-level-and-webkit-main-frame-fetch-async-xhr-request-control'
    })
  })

  it('rolls back native routes when document instrumentation cannot activate', async () => {
    queueInteraction.mockRejectedValue(new Error('document unavailable'))

    await expect(
      enableBrowserInterception({ page: 'page-1', patterns: ['https://example.com/**'] })
    ).rejects.toThrow('document unavailable')

    expect(disableNative).toHaveBeenCalledWith('page-1')
  })
})
