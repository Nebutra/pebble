import { beforeEach, describe, expect, it, vi } from 'vitest'
import { requestRuntimeJson } from './pebble-tauri-runtime-transport'
import {
  deleteSessionTabLayout,
  flushSessionTabLayoutSaves,
  loadSessionTabLayout,
  scheduleSessionTabLayoutSave
} from './tauri-session-tab-layout-persistence'

vi.mock('./pebble-tauri-runtime-transport', () => ({
  requestRuntimeJson: vi.fn()
}))

const requestRuntimeJsonMock = vi.mocked(requestRuntimeJson)

describe('session tab layout persistence', () => {
  beforeEach(() => {
    requestRuntimeJsonMock.mockReset()
    requestRuntimeJsonMock.mockResolvedValue({})
  })

  it('loads the durable snapshot for a worktree', async () => {
    const snapshot = {
      worktreeId: 'wt-1',
      activeTabId: 'tab-1',
      snapshotVersion: 3,
      updatedAt: '2026-07-10T00:00:00Z'
    }
    requestRuntimeJsonMock.mockResolvedValueOnce(snapshot)
    await expect(loadSessionTabLayout('wt-1')).resolves.toEqual(snapshot)
    expect(requestRuntimeJsonMock).toHaveBeenCalledWith(
      '/v1/session-tab-layouts/wt-1',
      expect.objectContaining({ method: 'GET' })
    )
  })

  it('returns null when no snapshot exists yet (404 or transport failure)', async () => {
    requestRuntimeJsonMock.mockRejectedValueOnce(new Error('HTTP 404'))
    await expect(loadSessionTabLayout('wt-1')).resolves.toBeNull()
    await expect(loadSessionTabLayout('')).resolves.toBeNull()
  })

  it('debounces rapid layout mutations into one newest-wins PUT', async () => {
    vi.useFakeTimers()
    try {
      scheduleSessionTabLayoutSave('wt-1', { activeTabId: 'tab-1' })
      scheduleSessionTabLayoutSave('wt-1', { activeTabId: 'tab-2' })
      scheduleSessionTabLayoutSave('wt-1', { activeTabId: 'tab-3' })
      expect(requestRuntimeJsonMock).not.toHaveBeenCalled()
      await vi.runAllTimersAsync()
      expect(requestRuntimeJsonMock).toHaveBeenCalledTimes(1)
      expect(requestRuntimeJsonMock).toHaveBeenCalledWith(
        '/v1/session-tab-layouts/wt-1',
        expect.objectContaining({ method: 'PUT', body: { activeTabId: 'tab-3' } })
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps per-worktree pending writes independent', async () => {
    vi.useFakeTimers()
    try {
      scheduleSessionTabLayoutSave('wt-1', { activeTabId: 'a' })
      scheduleSessionTabLayoutSave('wt-2', { activeTabId: 'b' })
      await vi.runAllTimersAsync()
      const paths = requestRuntimeJsonMock.mock.calls.map((call) => call[0])
      expect(paths).toContain('/v1/session-tab-layouts/wt-1')
      expect(paths).toContain('/v1/session-tab-layouts/wt-2')
    } finally {
      vi.useRealTimers()
    }
  })

  it('flushes a pending write immediately on demand', async () => {
    vi.useFakeTimers()
    try {
      scheduleSessionTabLayoutSave('wt-1', { activeTabId: 'tab-1' })
      await flushSessionTabLayoutSaves('wt-1')
      expect(requestRuntimeJsonMock).toHaveBeenCalledTimes(1)
      // The debounce timer must not fire a duplicate save afterwards.
      await vi.runAllTimersAsync()
      expect(requestRuntimeJsonMock).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops any pending write when the layout is deleted', async () => {
    vi.useFakeTimers()
    try {
      requestRuntimeJsonMock.mockResolvedValue({ deleted: true })
      scheduleSessionTabLayoutSave('wt-1', { activeTabId: 'tab-1' })
      await expect(deleteSessionTabLayout('wt-1')).resolves.toBe(true)
      await vi.runAllTimersAsync()
      expect(requestRuntimeJsonMock).toHaveBeenCalledTimes(1)
      expect(requestRuntimeJsonMock).toHaveBeenCalledWith(
        '/v1/session-tab-layouts/wt-1',
        expect.objectContaining({ method: 'DELETE' })
      )
    } finally {
      vi.useRealTimers()
    }
  })
})
