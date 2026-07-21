import { describe, expect, it, vi } from 'vitest'
import {
  addTauriSerializeBufferRequestListener,
  clearTauriPendingPaneSerializer,
  declareTauriPendingPaneSerializer,
  requestTauriSerializedBuffer,
  sendTauriSerializedBuffer,
  settleTauriPaneSerializer
} from './tauri-runtime-pty-serializer'

describe('Tauri runtime PTY serializer coordination', () => {
  it('round-trips a renderer buffer snapshot', async () => {
    const unsubscribe = addTauriSerializeBufferRequestListener((request) => {
      sendTauriSerializedBuffer(request.requestId, { data: 'prompt', cols: 80, rows: 24 })
    })

    await expect(requestTauriSerializedBuffer('pty-1')).resolves.toEqual({
      data: 'prompt',
      cols: 80,
      rows: 24
    })
    unsubscribe()
  })

  it('times out when a mounted serializer does not answer', async () => {
    vi.useFakeTimers()
    const unsubscribe = addTauriSerializeBufferRequestListener(() => undefined)
    const snapshot = requestTauriSerializedBuffer('pty-1', undefined, 25)
    await vi.advanceTimersByTimeAsync(25)
    await expect(snapshot).resolves.toBeNull()
    unsubscribe()
    vi.useRealTimers()
  })

  it('uses generations so stale cleanup cannot clear a newer pane declaration', async () => {
    const first = await declareTauriPendingPaneSerializer('tab:leaf')
    const second = await declareTauriPendingPaneSerializer('tab:leaf')
    await clearTauriPendingPaneSerializer('tab:leaf', first)
    await settleTauriPaneSerializer('tab:leaf', second)
    expect(second).toBeGreaterThan(first)
  })
})
