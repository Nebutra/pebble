/**
 * Memory-leak regression: removing a repo must purge its sparse-preset maps (upstream #7564).
 */
import { describe, it, expect } from 'vitest'
import { omitSparsePresetsForRepos } from './sparse-presets'
import type { SparsePreset } from '../../../../shared/types'

function preset(id: string, repoId: string): SparsePreset {
  return { id, repoId, name: id, directories: ['src'], createdAt: 1, updatedAt: 1 }
}

describe('omitSparsePresetsForRepos', () => {
  it('drops all four sparse-preset maps for removed repos and keeps survivors', () => {
    const state = {
      sparsePresetsByRepo: {
        'repo-1': [preset('p1', 'repo-1')],
        'repo-2': [preset('p2', 'repo-2')]
      },
      sparsePresetsLoadingByRepo: { 'repo-1': false, 'repo-2': false },
      sparsePresetsLoadStatusByRepo: {
        'repo-1': 'loaded' as const,
        'repo-2': 'loaded' as const
      },
      sparsePresetsErrorByRepo: { 'repo-1': 'stale', 'repo-2': 'boom' }
    }

    const next = omitSparsePresetsForRepos(state, ['repo-1'])
    expect(next.sparsePresetsByRepo?.['repo-1']).toBeUndefined()
    expect(next.sparsePresetsLoadingByRepo?.['repo-1']).toBeUndefined()
    expect(next.sparsePresetsLoadStatusByRepo?.['repo-1']).toBeUndefined()
    expect(next.sparsePresetsErrorByRepo?.['repo-1']).toBeUndefined()
    expect(next.sparsePresetsByRepo?.['repo-2']).toEqual([preset('p2', 'repo-2')])
    expect(next.sparsePresetsErrorByRepo?.['repo-2']).toBe('boom')
  })

  it('returns empty patch when nothing is removed', () => {
    const state = {
      sparsePresetsByRepo: { 'repo-1': [preset('p1', 'repo-1')] },
      sparsePresetsLoadingByRepo: {},
      sparsePresetsLoadStatusByRepo: {},
      sparsePresetsErrorByRepo: {}
    }
    expect(omitSparsePresetsForRepos(state, [])).toEqual({})
    expect(omitSparsePresetsForRepos(state, ['missing'])).toEqual({})
  })
})
