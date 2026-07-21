import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { destroyMock, exitMock, getCurrentWindowMock, hideMock, invokeMock, listenMock } =
  vi.hoisted(() => {
    const destroy = vi.fn(() => Promise.resolve())
    const hide = vi.fn(() => Promise.resolve())
    return {
      destroyMock: destroy,
      exitMock: vi.fn(() => Promise.resolve()),
      hideMock: hide,
      invokeMock: vi.fn((_command: string): Promise<unknown> => Promise.resolve()),
      listenMock: vi.fn(() => Promise.resolve(() => undefined)),
      getCurrentWindowMock: vi.fn(() => ({
        destroy,
        hide,
        isFullscreen: vi.fn(() => Promise.resolve(false)),
        isMaximized: vi.fn(() => Promise.resolve(false)),
        minimize: vi.fn(),
        onCloseRequested: vi.fn(() => Promise.resolve(() => undefined)),
        onMoved: vi.fn(() => Promise.resolve(() => undefined)),
        onResized: vi.fn(() => Promise.resolve(() => undefined)),
        toggleMaximize: vi.fn()
      }))
    }
  })

vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: getCurrentWindowMock }))
vi.mock('@tauri-apps/plugin-process', () => ({ exit: exitMock }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }))

import {
  installTauriWindowApi,
  requestTauriAppQuit,
  resetTauriWindowApiForTests
} from './tauri-window-api'

describe('installTauriWindowApi', () => {
  beforeEach(() => {
    resetTauriWindowApiForTests()
    destroyMock.mockClear()
    exitMock.mockClear()
    hideMock.mockClear()
    invokeMock
      .mockReset()
      .mockImplementation((command: string) =>
        Promise.resolve(command === 'native_quit_take_pending' ? false : undefined)
      )
    listenMock.mockClear()
    vi.stubGlobal('window', {
      __TAURI_INTERNALS__: {},
      api: {
        settings: { get: vi.fn().mockResolvedValue({}) },
        ui: {}
      }
    })
  })

  afterEach(() => vi.unstubAllGlobals())

  function listenForCloseRequest(): {
    closeRequest: ReturnType<typeof vi.fn>
    unsubscribe: () => void
  } {
    const closeRequest = vi.fn()
    const unsubscribe = window.api.ui.onWindowCloseRequested(closeRequest)
    return { closeRequest, unsubscribe }
  }

  it('exits the native app after renderer close guards confirm', async () => {
    installTauriWindowApi()
    const { closeRequest, unsubscribe } = listenForCloseRequest()
    window.api.ui.requestClose()
    const request = closeRequest.mock.calls[0][0]

    window.api.ui.confirmWindowClose(request.requestId)
    await vi.waitFor(() => expect(exitMock).toHaveBeenCalledWith(0))
    expect(invokeMock).toHaveBeenCalledWith('window_prepare_to_close')
    expect(destroyMock).not.toHaveBeenCalled()
    unsubscribe()
  })

  it('queues a traffic-light request until React installs close guards', async () => {
    const closeRequest = vi.fn()
    installTauriWindowApi()

    window.api.ui.requestClose()
    expect(exitMock).not.toHaveBeenCalled()

    const unsubscribe = window.api.ui.onWindowCloseRequested(closeRequest)
    expect(closeRequest).toHaveBeenCalledWith({ isQuitting: false, requestId: expect.any(Number) })
    window.api.ui.confirmWindowClose(closeRequest.mock.calls[0][0].requestId)
    await vi.waitFor(() => expect(exitMock).toHaveBeenCalledWith(0))
    unsubscribe()
  })

  it('replays a native quit that arrived before the renderer listener', async () => {
    invokeMock.mockImplementation((command: string) =>
      Promise.resolve(command === 'native_quit_take_pending' ? true : undefined)
    )
    installTauriWindowApi()
    const { closeRequest } = listenForCloseRequest()

    await vi.waitFor(() =>
      expect(closeRequest).toHaveBeenCalledWith({ isQuitting: true, requestId: expect.any(Number) })
    )
  })

  it('destroys the window when native process exit is unavailable', async () => {
    exitMock.mockRejectedValueOnce(new Error('process exit unavailable'))
    installTauriWindowApi()
    const { closeRequest, unsubscribe } = listenForCloseRequest()
    window.api.ui.requestClose()

    window.api.ui.confirmWindowClose(closeRequest.mock.calls[0][0].requestId)
    await vi.waitFor(() => expect(destroyMock).toHaveBeenCalledOnce())
    unsubscribe()
  })

  it('hides a macOS main window after ordinary close guards confirm', async () => {
    vi.stubGlobal('navigator', { userAgent: 'Macintosh' })
    installTauriWindowApi()
    const { closeRequest, unsubscribe } = listenForCloseRequest()
    window.api.ui.requestClose()

    window.api.ui.confirmWindowClose(closeRequest.mock.calls[0][0].requestId)
    await vi.waitFor(() => expect(hideMock).toHaveBeenCalledOnce())
    expect(exitMock).not.toHaveBeenCalled()
    unsubscribe()
  })

  it('hides a Windows window when minimize to tray is enabled', async () => {
    vi.stubGlobal('navigator', { userAgent: 'Windows' })
    window.api.settings.get = vi.fn().mockResolvedValue({ minimizeToTrayOnClose: true })
    installTauriWindowApi()
    const { closeRequest, unsubscribe } = listenForCloseRequest()
    window.api.ui.requestClose()

    window.api.ui.confirmWindowClose(closeRequest.mock.calls[0][0].requestId)

    await vi.waitFor(() => expect(hideMock).toHaveBeenCalledOnce())
    expect(exitMock).not.toHaveBeenCalled()
    expect(listenMock).toHaveBeenCalledWith('pebble://tray-quit', requestTauriAppQuit)
    unsubscribe()
  })

  it('exits macOS only after the renderer confirms an explicit app quit', async () => {
    vi.stubGlobal('navigator', { userAgent: 'Macintosh' })
    const closeRequest = vi.fn()
    installTauriWindowApi()
    const unsubscribe = window.api.ui.onWindowCloseRequested(closeRequest)

    requestTauriAppQuit()
    expect(closeRequest).toHaveBeenCalledWith({ isQuitting: true, requestId: expect.any(Number) })
    window.api.ui.confirmWindowClose(closeRequest.mock.calls[0][0].requestId)

    await vi.waitFor(() => expect(exitMock).toHaveBeenCalledWith(0))
    expect(hideMock).not.toHaveBeenCalled()
    unsubscribe()
  })

  it('does not let a stale ordinary-close confirmation consume a newer quit request', async () => {
    vi.stubGlobal('navigator', { userAgent: 'Macintosh' })
    installTauriWindowApi()
    const { closeRequest, unsubscribe } = listenForCloseRequest()

    window.api.ui.requestClose()
    const ordinaryRequest = closeRequest.mock.calls[0][0]
    requestTauriAppQuit()
    const quitRequest = closeRequest.mock.calls[1][0]
    window.api.ui.confirmWindowClose(ordinaryRequest.requestId)
    await Promise.resolve()
    expect(exitMock).not.toHaveBeenCalled()
    expect(hideMock).not.toHaveBeenCalled()

    window.api.ui.confirmWindowClose(quitRequest.requestId)
    await vi.waitFor(() => expect(exitMock).toHaveBeenCalledWith(0))
    unsubscribe()
  })

  it('does not downgrade an in-flight quit when a native close arrives', async () => {
    vi.stubGlobal('navigator', { userAgent: 'Macintosh' })
    installTauriWindowApi()
    const { closeRequest, unsubscribe } = listenForCloseRequest()

    requestTauriAppQuit()
    const quitRequest = closeRequest.mock.calls[0][0]
    window.api.ui.requestClose()
    expect(closeRequest).toHaveBeenCalledTimes(1)
    window.api.ui.confirmWindowClose(quitRequest.requestId)

    await vi.waitFor(() => expect(exitMock).toHaveBeenCalledWith(0))
    expect(hideMock).not.toHaveBeenCalled()
    unsubscribe()
  })

  it('consumes each close request at most once', async () => {
    vi.stubGlobal('navigator', { userAgent: 'Macintosh' })
    installTauriWindowApi()
    const { closeRequest, unsubscribe } = listenForCloseRequest()
    window.api.ui.requestClose()
    const request = closeRequest.mock.calls[0][0]

    window.api.ui.confirmWindowClose(request.requestId)
    await vi.waitFor(() => expect(hideMock).toHaveBeenCalledOnce())
    window.api.ui.confirmWindowClose(request.requestId)
    await Promise.resolve()
    expect(hideMock).toHaveBeenCalledOnce()
    unsubscribe()
  })

  it('forwards renderer zoom to native macOS traffic-light positioning', () => {
    installTauriWindowApi()

    window.api.ui.syncTrafficLights(1.44)

    expect(invokeMock).toHaveBeenCalledWith('window_set_traffic_light_zoom', {
      zoomFactor: 1.44
    })
  })
})
