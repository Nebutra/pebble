import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { requestRuntimeJsonMock, subscribeRuntimeEventPushMock } = vi.hoisted(() => ({
  requestRuntimeJsonMock: vi.fn(),
  subscribeRuntimeEventPushMock: vi.fn()
}))

vi.mock('./pebble-tauri-runtime-transport', () => ({
  requestRuntimeJson: requestRuntimeJsonMock
}))
vi.mock('./tauri-runtime-event-push', () => ({
  subscribeRuntimeEventPush: subscribeRuntimeEventPushMock
}))

import {
  getTauriComputerActionCursor,
  resetTauriComputerActionWaiterForTests,
  waitForTauriComputerAction
} from './tauri-computer-action-waiter'
import type { RuntimeEventStreamEntry } from './runtime-command-shapes'

type PushHandler = (entry: RuntimeEventStreamEntry) => void
type StateHandler = (active: boolean) => void

let pushHandler: PushHandler
let stateHandler: StateHandler

function pushedAction(action: Record<string, unknown>): RuntimeEventStreamEntry {
  return {
    id: `event-${String(action.id)}`,
    topic: 'computer.changed',
    data: JSON.stringify({ topic: 'computer.changed', payload: action })
  }
}

function wait(actionId: string, kindPrefix = 'browser.', signal?: AbortSignal) {
  return waitForTauriComputerAction({
    actionId,
    kindPrefix,
    timeoutMs: 1_000,
    timeoutMessage: `Timed out waiting for ${actionId}.`,
    signal
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  requestRuntimeJsonMock.mockReset().mockResolvedValue([])
  subscribeRuntimeEventPushMock.mockReset()
  subscribeRuntimeEventPushMock.mockImplementation(
    async (onEvent: PushHandler, onState: StateHandler) => {
      pushHandler = onEvent
      stateHandler = onState
      onState(true)
      return { pushActive: true, supported: true, unsubscribe: vi.fn() }
    }
  )
})

afterEach(() => {
  resetTauriComputerActionWaiterForTests()
  vi.useRealTimers()
})

describe('waitForTauriComputerAction', () => {
  it('does not reuse a cached terminal result after a new action generation starts', async () => {
    const first = wait('reused-action')
    await vi.advanceTimersByTimeAsync(0)
    pushHandler(
      pushedAction({ id: 'reused-action', kind: 'browser.screenshot', status: 'completed' })
    )
    await expect(first).resolves.toMatchObject({ status: 'completed' })

    const cursor = getTauriComputerActionCursor()
    const second = waitForTauriComputerAction({
      actionId: 'reused-action',
      kindPrefix: 'browser.',
      timeoutMs: 1_000,
      timeoutMessage: 'timed out',
      afterSequence: cursor
    })
    let settled = false
    void second.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    pushHandler(
      pushedAction({
        id: 'reused-action',
        kind: 'browser.screenshot',
        status: 'failed',
        error: 'new generation failed'
      })
    )
    await expect(second).resolves.toMatchObject({
      status: 'failed',
      error: 'new generation failed'
    })
  })

  it('settles from push without issuing a GET', async () => {
    subscribeRuntimeEventPushMock.mockImplementationOnce(
      async (onEvent: PushHandler, onState: StateHandler) => {
        pushHandler = onEvent
        stateHandler = onState
        onState(true)
        onEvent(
          pushedAction({
            id: 'action-push',
            kind: 'browser.goto',
            status: 'completed',
            result: { ok: true }
          })
        )
        return { pushActive: true, supported: true, unsubscribe: vi.fn() }
      }
    )

    await expect(wait('action-push')).resolves.toMatchObject({ status: 'completed' })
    expect(requestRuntimeJsonMock).not.toHaveBeenCalled()
  })

  it('polls while push is disconnected', async () => {
    subscribeRuntimeEventPushMock.mockImplementationOnce(
      async (onEvent: PushHandler, onState: StateHandler) => {
        pushHandler = onEvent
        stateHandler = onState
        onState(false)
        return { pushActive: false, supported: true, unsubscribe: vi.fn() }
      }
    )
    requestRuntimeJsonMock.mockResolvedValue([
      { id: 'action-poll', kind: 'emulator.tap', status: 'completed', result: { ok: true } }
    ])

    const pending = wait('action-poll', 'emulator.')
    await vi.runAllTimersAsync()
    await expect(pending).resolves.toMatchObject({ id: 'action-poll' })
    expect(requestRuntimeJsonMock).toHaveBeenCalledTimes(1)
  })

  it('stops fallback polling as soon as push reconnects', async () => {
    subscribeRuntimeEventPushMock.mockImplementationOnce(
      async (onEvent: PushHandler, onState: StateHandler) => {
        pushHandler = onEvent
        stateHandler = onState
        onState(false)
        return { pushActive: false, supported: true, unsubscribe: vi.fn() }
      }
    )
    requestRuntimeJsonMock.mockResolvedValue([
      { id: 'action-reconnect', kind: 'browser.goto', status: 'running' }
    ])
    const pending = wait('action-reconnect')
    await vi.advanceTimersByTimeAsync(0)
    expect(requestRuntimeJsonMock).toHaveBeenCalledTimes(1)

    stateHandler(true)
    await vi.advanceTimersByTimeAsync(500)
    expect(requestRuntimeJsonMock).toHaveBeenCalledTimes(1)
    pushHandler(pushedAction({ id: 'action-reconnect', kind: 'browser.goto', status: 'completed' }))
    await expect(pending).resolves.toMatchObject({ status: 'completed' })
  })

  it('retains an early terminal event for a later waiter', async () => {
    const first = wait('action-first')
    await vi.waitFor(() => expect(subscribeRuntimeEventPushMock).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(requestRuntimeJsonMock).toHaveBeenCalledTimes(1))
    pushHandler(pushedAction({ id: 'action-early', kind: 'browser.goto', status: 'completed' }))

    await expect(wait('action-early')).resolves.toMatchObject({ id: 'action-early' })
    pushHandler(pushedAction({ id: 'action-first', kind: 'browser.goto', status: 'completed' }))
    await first
    expect(requestRuntimeJsonMock).toHaveBeenCalledTimes(1)
  })

  it('shares one disconnected poll across concurrent waits for the same prefix', async () => {
    subscribeRuntimeEventPushMock.mockImplementationOnce(
      async (onEvent: PushHandler, onState: StateHandler) => {
        pushHandler = onEvent
        stateHandler = onState
        onState(false)
        return { pushActive: false, supported: true, unsubscribe: vi.fn() }
      }
    )
    requestRuntimeJsonMock.mockResolvedValue([
      { id: 'action-a', kind: 'browser.goto', status: 'completed' },
      { id: 'action-b', kind: 'browser.click', status: 'completed' }
    ])

    const waits = Promise.all([wait('action-a'), wait('action-b')])
    await vi.runAllTimersAsync()
    await expect(waits).resolves.toHaveLength(2)
    expect(requestRuntimeJsonMock).toHaveBeenCalledTimes(1)
  })

  it('cancels without leaving fallback polling armed', async () => {
    subscribeRuntimeEventPushMock.mockImplementationOnce(
      async (onEvent: PushHandler, onState: StateHandler) => {
        pushHandler = onEvent
        stateHandler = onState
        onState(false)
        return { pushActive: false, supported: true, unsubscribe: vi.fn() }
      }
    )
    requestRuntimeJsonMock.mockResolvedValue([])
    const controller = new AbortController()
    const pending = wait('action-cancel', 'browser.', controller.signal)
    await vi.advanceTimersByTimeAsync(0)
    controller.abort()
    await expect(pending).rejects.toThrow('canceled')
    const calls = requestRuntimeJsonMock.mock.calls.length
    await vi.advanceTimersByTimeAsync(500)
    expect(requestRuntimeJsonMock).toHaveBeenCalledTimes(calls)
  })
})
