import { describe, expect, it, vi } from 'vitest'

import { createRuntimePtyInputBatcher } from './runtime-pty-input-batcher'

describe('createRuntimePtyInputBatcher', () => {
  it('coalesces adjacent printable input into one ordered runtime request', async () => {
    vi.useFakeTimers()
    const sender = vi.fn().mockResolvedValue(true)
    const batcher = createRuntimePtyInputBatcher(sender)

    const first = batcher.write('session-1', 'p')
    const second = batcher.write('session-1', 'e')
    await Promise.resolve()

    await expect(Promise.all([first, second])).resolves.toEqual([true, true])
    expect(sender).toHaveBeenCalledWith('session-1', 'pe')
    vi.useRealTimers()
  })

  it('flushes Enter immediately behind already queued text', async () => {
    vi.useFakeTimers()
    const sender = vi.fn().mockResolvedValue(true)
    const batcher = createRuntimePtyInputBatcher(sender)

    const text = batcher.write('session-1', 'pwd')
    const enter = batcher.write('session-1', '\r')

    await expect(Promise.all([text, enter])).resolves.toEqual([true, true])
    expect(sender).toHaveBeenCalledWith('session-1', 'pwd\r')
    vi.useRealTimers()
  })

  it('does not hold later input behind a pending bridge acknowledgement', async () => {
    vi.useFakeTimers()
    let finishFirst: ((value: boolean) => void) | undefined
    const sender = vi
      .fn()
      .mockImplementationOnce(() => new Promise<boolean>((resolve) => (finishFirst = resolve)))
      .mockResolvedValueOnce(true)
    const batcher = createRuntimePtyInputBatcher(sender)

    const first = batcher.write('session-1', '\r')
    const second = batcher.write('session-1', '\n')
    await Promise.resolve()
    expect(sender).toHaveBeenCalledTimes(2)

    finishFirst?.(true)
    await expect(Promise.all([first, second])).resolves.toEqual([true, true])
    expect(sender.mock.calls).toEqual([
      ['session-1', '\r'],
      ['session-1', '\n']
    ])
    vi.useRealTimers()
  })

  it('merges adjacent input while an earlier bridge acknowledgement is pending', async () => {
    vi.useFakeTimers()
    let finishFirst: ((value: boolean) => void) | undefined
    const sender = vi
      .fn()
      .mockImplementationOnce(() => new Promise<boolean>((resolve) => (finishFirst = resolve)))
      .mockResolvedValueOnce(true)
    const batcher = createRuntimePtyInputBatcher(sender)

    const first = batcher.write('session-1', '\r')
    const second = batcher.write('session-1', 'p')
    const third = batcher.write('session-1', 'w')
    const fourth = batcher.write('session-1', 'd')
    await vi.advanceTimersByTimeAsync(20)
    expect(sender).toHaveBeenCalledTimes(2)

    finishFirst?.(true)
    await expect(Promise.all([first, second, third, fourth])).resolves.toEqual([
      true,
      true,
      true,
      true
    ])
    expect(sender.mock.calls).toEqual([
      ['session-1', '\r'],
      ['session-1', 'pwd']
    ])
    vi.useRealTimers()
  })
})
