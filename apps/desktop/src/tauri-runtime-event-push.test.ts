import { beforeEach, describe, expect, it, vi } from 'vitest'

const invokeMock = vi.fn()
const listenMock = vi.fn()

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  Channel: class {
    onmessage: ((value: unknown) => void) | null = null
  }
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: (...args: unknown[]) => listenMock(...args)
}))

vi.mock('./local-runtime-auth', () => ({
  LOCAL_RUNTIME_BEARER_TOKEN: 'test-bearer-token'
}))

describe('runtime event push', () => {
  beforeEach(() => {
    vi.resetModules()
    invokeMock.mockReset()
    listenMock.mockReset()
    listenMock.mockResolvedValue(() => undefined)
    invokeMock.mockResolvedValue({ supported: true, eventName: 'e', statusEventName: 's' })
  })

  it('authenticates the pushed event stream', async () => {
    // Why: the runtime answers an unauthenticated /v1/events with 401, the native
    // task treats any non-success as a failed connect, and the renderer then polls
    // terminal output with a backoff that reaches 250ms. Sending no token made
    // that permanent, so every keystroke's echo waited on the next poll.
    const { subscribeRuntimeEventPush } = await import('./tauri-runtime-event-push')
    await subscribeRuntimeEventPush(() => undefined)

    const call = invokeMock.mock.calls.find(([command]) => command === 'start_runtime_event_stream')
    if (!call) {
      throw new Error('the push pipeline never started the native event stream')
    }
    const { input } = call[1] as { input: { bearerToken: string | null } }
    expect(input.bearerToken).toBe('test-bearer-token')
  })

  it('reports push as disconnected until the native task says otherwise', async () => {
    const { subscribeRuntimeEventPush, isRuntimeEventPushConnected } =
      await import('./tauri-runtime-event-push')
    const result = await subscribeRuntimeEventPush(() => undefined)

    expect(result.supported).toBe(true)
    // Connected is a live fact reported by the stream, never assumed from a
    // successful start; assuming it would silently disable the polling fallback.
    expect(isRuntimeEventPushConnected()).toBe(false)
    expect(result.pushActive).toBe(false)
  })
})
