import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createTauriNativeChatApi } from './tauri-native-chat-api'

const { invokeMock, listenMock } = vi.hoisted(() => ({ invokeMock: vi.fn(), listenMock: vi.fn() }))

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }))

beforeEach(() => {
  vi.clearAllMocks()
  listenMock.mockResolvedValue(vi.fn())
})

describe('createTauriNativeChatApi', () => {
  it('reads and windows native transcript entries through the shared decoder', async () => {
    invokeMock.mockResolvedValue({
      entries: [
        {
          line: JSON.stringify({ type: 'user', uuid: 'one', message: { content: 'first' } }),
          fallbackId: 'f1'
        },
        {
          line: JSON.stringify({ type: 'assistant', uuid: 'two', message: { content: 'second' } }),
          fallbackId: 'f2'
        }
      ]
    })

    const result = await createTauriNativeChatApi().readSession('claude', 'session-1', 1)

    expect(result).toEqual({
      messages: [expect.objectContaining({ id: 'two', role: 'assistant' })]
    })
    expect(invokeMock).toHaveBeenCalledWith('native_chat_read_session', {
      input: { agent: 'claude', sessionId: 'session-1', transcriptPath: null }
    })
  })

  it('subscribes before starting the watcher and always tears native state down', async () => {
    const stopListening = vi.fn()
    let emit: ((event: { payload: unknown }) => void) | undefined
    listenMock.mockImplementation((_event, callback) => {
      emit = callback
      return Promise.resolve(stopListening)
    })
    invokeMock.mockResolvedValue(undefined)
    const onAppended = vi.fn()
    const stop = createTauriNativeChatApi().subscribe(
      { subscriptionId: 'sub-1', agent: 'codex', sessionId: 'session-1' },
      onAppended
    )
    await vi.waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith('native_chat_subscribe', expect.anything())
    )

    emit?.({
      payload: {
        subscriptionId: 'sub-1',
        entries: [
          {
            line: JSON.stringify({
              type: 'event_msg',
              payload: { type: 'agent_message', message: 'done' }
            }),
            fallbackId: 'fallback'
          }
        ]
      }
    })
    expect(onAppended).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'fallback', role: 'assistant' })
    ])

    stop()
    await vi.waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith('native_chat_unsubscribe', {
        input: { subscriptionId: 'sub-1' }
      })
    )
    expect(stopListening).toHaveBeenCalledTimes(1)
  })

  it('preserves the result-style error contract when the native command rejects', async () => {
    invokeMock.mockRejectedValue('No transcript found for codex session missing.')

    await expect(createTauriNativeChatApi().readSession('codex', 'missing')).resolves.toEqual({
      error: 'No transcript found for codex session missing.'
    })
  })
})
