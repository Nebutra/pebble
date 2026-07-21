import { beforeEach, describe, expect, it, vi } from 'vitest'
import { scheduleAfterInputQuiet } from '@/lib/input-quiet-scheduler'
import {
  preloadSettingsPanesInBackground,
  scheduleSettingsPanePreloadQueue
} from './settings-pane-components'
import {
  deriveNeededRepoIds,
  deriveNeededSectionIds,
  deriveRepoHookProbeIds,
  getRuntimeTargetIdentity
} from './settings-load-performance'

vi.mock('@/lib/input-quiet-scheduler', () => ({
  scheduleAfterInputQuiet: vi.fn(() => vi.fn())
}))

describe('Settings load-performance helpers', () => {
  beforeEach(() => {
    vi.mocked(scheduleAfterInputQuiet).mockClear()
  })

  it('starts background pane warming only after the startup settle window', () => {
    const cancelScheduled = vi.fn()
    vi.mocked(scheduleAfterInputQuiet).mockReturnValue(cancelScheduled)

    const cancel = preloadSettingsPanesInBackground()
    const calls = vi.mocked(scheduleAfterInputQuiet).mock.calls

    expect(calls).toHaveLength(1)
    expect(calls[0]?.[1].delayMs).toBe(1_500)
    cancel()
    expect(cancelScheduled).toHaveBeenCalledOnce()
  })

  it('never overlaps pane module evaluation and stops the queue when cancelled', async () => {
    const scheduledCallbacks: (() => void)[] = []
    vi.mocked(scheduleAfterInputQuiet).mockImplementation((callback) => {
      scheduledCallbacks.push(callback)
      return vi.fn()
    })
    let finishFirst: (() => void) | undefined
    const preload = vi
      .fn<(sectionId: string) => Promise<void>>()
      .mockImplementationOnce(() => new Promise((resolve) => (finishFirst = resolve)))
      .mockResolvedValue(undefined)

    const cancel = scheduleSettingsPanePreloadQueue(['agents', 'terminal', 'stats'], preload)
    scheduledCallbacks[0]?.()
    expect(preload).toHaveBeenCalledTimes(1)
    expect(scheduledCallbacks).toHaveLength(1)

    finishFirst?.()
    await vi.waitFor(() => expect(scheduledCallbacks).toHaveLength(2))
    scheduledCallbacks[1]?.()
    await vi.waitFor(() => expect(scheduledCallbacks).toHaveLength(3))
    expect(preload).toHaveBeenCalledTimes(2)

    cancel()
    scheduledCallbacks[2]?.()
    expect(preload).toHaveBeenCalledTimes(2)
  })

  it('keeps only eager and active sections mounted for empty search on first paint', () => {
    const needed = deriveNeededSectionIds({
      navSectionIds: ['general', 'agents', 'appearance', 'terminal', 'stats', 'ssh', 'repo-a'],
      mountedSectionIds: new Set(['general']),
      activeSectionId: 'general',
      pendingSectionId: null,
      query: '',
      visibleSectionIds: new Set([
        'general',
        'agents',
        'appearance',
        'terminal',
        'stats',
        'ssh',
        'repo-a'
      ])
    })

    expect(Array.from(needed).sort()).toEqual(['general'])
  })

  it('keeps search mounting scoped to the active section', () => {
    const needed = deriveNeededSectionIds({
      navSectionIds: ['general', 'agents', 'appearance', 'terminal', 'stats', 'repo-a'],
      mountedSectionIds: new Set(['general']),
      activeSectionId: 'general',
      pendingSectionId: null,
      query: 'stats',
      visibleSectionIds: new Set(['stats'])
    })

    expect(needed.has('stats')).toBe(false)
    expect(needed.has('general')).toBe(false)
  })

  it('mounts the active matched section during search', () => {
    const needed = deriveNeededSectionIds({
      navSectionIds: ['general', 'agents', 'appearance', 'terminal', 'stats', 'repo-a'],
      mountedSectionIds: new Set(['general']),
      activeSectionId: 'stats',
      pendingSectionId: null,
      query: 'stats',
      visibleSectionIds: new Set(['stats'])
    })

    expect(needed.has('stats')).toBe(true)
  })

  it('keeps a pending deep-link target mounted before jump work continues', () => {
    const needed = deriveNeededSectionIds({
      navSectionIds: ['general', 'agents', 'appearance', 'terminal', 'repo-a'],
      mountedSectionIds: new Set(['general']),
      activeSectionId: 'general',
      pendingSectionId: 'repo-a',
      query: '',
      visibleSectionIds: new Set(['general', 'agents', 'appearance', 'terminal', 'repo-a'])
    })

    expect(needed.has('repo-a')).toBe(true)
  })

  it('scopes repo hook checks to needed repo sections only', () => {
    const neededRepoIds = deriveNeededRepoIds(
      [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      new Set(['general', 'repo-b'])
    )

    expect(neededRepoIds).toEqual(['b'])
  })

  it('does not repeat resolved or in-flight repo hook probes on tab changes', () => {
    expect(deriveRepoHookProbeIds(['a', 'b', 'c'], new Set(['a']), new Set(['b']))).toEqual(['c'])
  })

  it('normalizes runtime target identity for cache invalidation keys', () => {
    expect(getRuntimeTargetIdentity({ activeRuntimeEnvironmentId: null })).toBe('local')
    expect(getRuntimeTargetIdentity({ activeRuntimeEnvironmentId: '  env-1  ' })).toBe('env-1')
  })

  it('keeps previously selected panes mounted while another pane is active', () => {
    const needed = deriveNeededSectionIds({
      navSectionIds: ['general', 'agents', 'terminal'],
      mountedSectionIds: new Set(['general', 'terminal']),
      activeSectionId: 'general',
      pendingSectionId: null,
      query: '',
      visibleSectionIds: new Set(['general', 'agents', 'terminal'])
    })

    expect(needed).toEqual(new Set(['general', 'terminal']))
  })
})
