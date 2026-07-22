// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'

import {
  createAgentAwakeSyncCoordinator,
  type AgentAwakeSyncCoordinator
} from './tauri-agent-awake-sync'

type AwakeInput = Parameters<
  Parameters<typeof createAgentAwakeSyncCoordinator>[0]['invokeSync']
>[0]

function harness(initial: AwakeInput) {
  let input = initial
  let listener = () => undefined
  const invokeSync = vi.fn(async () => undefined)
  let coordinator: AgentAwakeSyncCoordinator | undefined
  coordinator = createAgentAwakeSyncCoordinator({
    invokeSync,
    readInput: () => input,
    subscribe: (nextListener) => {
      listener = nextListener
      return vi.fn()
    }
  })
  return {
    coordinator,
    invokeSync,
    update(next: AwakeInput) {
      input = next
      listener()
    }
  }
}

describe('Tauri agent awake synchronization', () => {
  it('sends current-runtime working status and reacts to the setting turning off', async () => {
    const working = {
      paneKey: 'tab-1:11111111-1111-4111-8111-111111111111',
      state: 'working' as const,
      receivedAt: 1_000,
      observedInCurrentRuntime: true as const
    }
    const test = harness({ enabled: true, statuses: [working] })

    await vi.waitFor(() => expect(test.invokeSync).toHaveBeenCalledTimes(1))
    expect(test.invokeSync).toHaveBeenLastCalledWith({ enabled: true, statuses: [working] })

    test.update({ enabled: false, statuses: [working] })
    await vi.waitFor(() => expect(test.invokeSync).toHaveBeenCalledTimes(2))
    expect(test.invokeSync).toHaveBeenLastCalledWith({ enabled: false, statuses: [working] })
  })

  it('deduplicates snapshots and serializes updates in their observed order', async () => {
    let releaseFirst = () => undefined
    const firstPending = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let input: AwakeInput = { enabled: false, statuses: [] }
    let listener = () => undefined
    const invokeSync = vi
      .fn<(input: AwakeInput) => Promise<void>>()
      .mockImplementationOnce(() => firstPending)
      .mockResolvedValue(undefined)
    createAgentAwakeSyncCoordinator({
      invokeSync,
      readInput: () => input,
      subscribe: (nextListener) => {
        listener = nextListener
        return vi.fn()
      }
    })

    listener()
    input = {
      enabled: true,
      statuses: [
        {
          paneKey: 'tab-2:22222222-2222-4222-8222-222222222222',
          state: 'working',
          receivedAt: 2_000,
          observedInCurrentRuntime: true
        }
      ]
    }
    listener()
    expect(invokeSync).toHaveBeenCalledTimes(1)

    releaseFirst()
    await vi.waitFor(() => expect(invokeSync).toHaveBeenCalledTimes(2))
    expect(invokeSync.mock.calls[1]?.[0]).toEqual(input)
  })

  it('sends the latest queued state after an earlier native sync fails', async () => {
    let rejectFirst = (_error: Error) => undefined
    const firstPending = new Promise<void>((_resolve, reject) => {
      rejectFirst = reject
    })
    let input: AwakeInput = { enabled: false, statuses: [] }
    let listener = () => undefined
    const invokeSync = vi
      .fn<(input: AwakeInput) => Promise<void>>()
      .mockImplementationOnce(() => firstPending)
      .mockResolvedValue(undefined)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    createAgentAwakeSyncCoordinator({
      invokeSync,
      readInput: () => input,
      subscribe: (nextListener) => {
        listener = nextListener
        return vi.fn()
      }
    })
    input = { enabled: true, statuses: [] }
    listener()

    rejectFirst(new Error('native channel closed'))
    await vi.waitFor(() => expect(invokeSync).toHaveBeenCalledTimes(2))
    expect(invokeSync.mock.calls[1]?.[0]).toEqual(input)
    expect(errorSpy).toHaveBeenCalledWith(
      'Failed to synchronize agent awake state:',
      expect.any(Error)
    )
    errorSpy.mockRestore()
  })

  it('releases the native assertion during renderer teardown', async () => {
    const test = harness({
      enabled: true,
      statuses: [
        {
          paneKey: 'tab-3:33333333-3333-4333-8333-333333333333',
          state: 'working',
          receivedAt: 3_000,
          observedInCurrentRuntime: true
        }
      ]
    })
    await vi.waitFor(() => expect(test.invokeSync).toHaveBeenCalledTimes(1))

    test.coordinator?.dispose()
    await vi.waitFor(() => expect(test.invokeSync).toHaveBeenCalledTimes(2))
    expect(test.invokeSync).toHaveBeenLastCalledWith({ enabled: false, statuses: [] })
  })
})
