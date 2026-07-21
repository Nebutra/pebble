import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  acknowledgeRuntimePtyData,
  addRuntimePtyDeliveryListener,
  enqueueRuntimePtyData,
  forgetRuntimePtyDelivery,
  getRuntimePtyDeliveryDebugSnapshot,
  resetRuntimePtyDeliveryDebug,
  setActiveRuntimeRendererPty,
  setRuntimeRendererPtyVisible
} from './tauri-runtime-pty-delivery'

describe('Tauri runtime PTY renderer delivery', () => {
  beforeEach(async () => {
    for (const id of ['active', 'background', 'pty-1']) {
      forgetRuntimePtyDelivery(id)
    }
    await resetRuntimePtyDeliveryDebug()
  })

  it('holds output above the in-flight limit until the renderer acknowledges data', async () => {
    const listener = vi.fn()
    const unsubscribe = addRuntimePtyDeliveryListener(listener)
    enqueueRuntimePtyData({ id: 'pty-1', data: 'a'.repeat(128 * 1024), rawLength: 128 * 1024 })
    enqueueRuntimePtyData({ id: 'pty-1', data: 'b', rawLength: 1 })
    await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(1))

    acknowledgeRuntimePtyData('pty-1', 128 * 1024)
    await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(2))
    expect((await getRuntimePtyDeliveryDebugSnapshot()).ackGatedFlushSkipCount).toBeGreaterThan(0)
    unsubscribe()
  })

  it('delivers active output before hidden background output', async () => {
    const delivered: string[] = []
    const unsubscribe = addRuntimePtyDeliveryListener((event) => delivered.push(event.id))
    setRuntimeRendererPtyVisible('background', false)
    setActiveRuntimeRendererPty('active', true)
    enqueueRuntimePtyData({ id: 'background', data: 'background' })
    enqueueRuntimePtyData({ id: 'active', data: 'active' })

    await vi.waitFor(() => expect(delivered).toHaveLength(2))
    expect(delivered).toEqual(['active', 'background'])
    unsubscribe()
  })
})
