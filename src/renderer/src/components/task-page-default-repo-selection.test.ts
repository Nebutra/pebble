import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../shared/types'
import {
  getDefaultTaskRepoSelection,
  getTaskProjectPickerGroups,
  getTaskProjectPickerRepos,
  normalizeTaskRepoSelection
} from './task-page-default-repo-selection'

function repo(overrides: Partial<Repo> & Pick<Repo, 'id'>): Repo {
  return {
    path: `/repos/${overrides.id}`,
    displayName: overrides.id,
    badgeColor: '#737373',
    addedAt: 100,
    kind: 'git',
    ...overrides
  }
}

describe('getDefaultTaskRepoSelection', () => {
  it('selects one source per logical GitHub project', () => {
    const selection = getDefaultTaskRepoSelection([
      repo({
        id: 'local-pebble',
        upstream: { owner: 'Nebutra', repo: 'Pebble' }
      }),
      repo({
        id: 'ssh-pebble',
        connectionId: 'builder',
        upstream: { owner: 'nebutra', repo: 'pebble' }
      }),
      repo({
        id: 'other',
        upstream: { owner: 'nebutra', repo: 'other' }
      })
    ])

    expect([...selection].sort()).toEqual(['local-pebble', 'other'])
  })

  it('prefers local checkout over a remote checkout for the same project', () => {
    const selection = getDefaultTaskRepoSelection([
      repo({
        id: 'ssh-pebble',
        addedAt: 1,
        connectionId: 'builder',
        upstream: { owner: 'nebutra', repo: 'pebble' }
      }),
      repo({
        id: 'local-pebble',
        addedAt: 2,
        upstream: { owner: 'nebutra', repo: 'pebble' }
      })
    ])

    expect([...selection]).toEqual(['local-pebble'])
  })

  it('keeps same-named folders separate when provider identity is missing', () => {
    const selection = getDefaultTaskRepoSelection([
      repo({ id: 'local-app', displayName: 'app' }),
      repo({ id: 'ssh-app', displayName: 'app', connectionId: 'builder' })
    ])

    expect([...selection].sort()).toEqual(['local-app', 'ssh-app'])
  })

  it('uses GitHub repo icon metadata to identify legacy duplicate projects', () => {
    const selection = getDefaultTaskRepoSelection([
      repo({
        id: 'local-claude-swap',
        displayName: 'claude-swap',
        repoIcon: {
          type: 'image',
          src: 'https://github.com/nebutra.png?size=64',
          source: 'github',
          label: 'nebutra/claude-swap'
        }
      }),
      repo({
        id: 'ssh-claude-swap',
        displayName: 'claude-swap',
        connectionId: 'builder',
        repoIcon: {
          type: 'image',
          src: 'https://github.com/nebutra.png?size=64',
          source: 'github',
          label: 'Nebutra/claude-swap'
        }
      })
    ])

    expect([...selection]).toEqual(['local-claude-swap'])
  })
})

describe('getTaskProjectPickerRepos', () => {
  it('shows one picker row per logical GitHub project', () => {
    const pickerRepos = getTaskProjectPickerRepos([
      repo({
        id: 'local-pebble',
        upstream: { owner: 'Nebutra', repo: 'Pebble' }
      }),
      repo({
        id: 'ssh-pebble',
        connectionId: 'builder',
        upstream: { owner: 'nebutra', repo: 'pebble' }
      }),
      repo({
        id: 'other',
        upstream: { owner: 'nebutra', repo: 'other' }
      })
    ])

    expect(pickerRepos.map((candidate) => candidate.id)).toEqual(['local-pebble', 'other'])
  })

  it('uses an explicitly selected remote source as the visible project row', () => {
    const pickerRepos = getTaskProjectPickerRepos(
      [
        repo({
          id: 'local-pebble',
          upstream: { owner: 'nebutra', repo: 'pebble' }
        }),
        repo({
          id: 'ssh-pebble',
          connectionId: 'builder',
          upstream: { owner: 'nebutra', repo: 'pebble' }
        })
      ],
      new Set(['ssh-pebble'])
    )

    expect(pickerRepos.map((candidate) => candidate.id)).toEqual(['ssh-pebble'])
  })

  it('collapses legacy local and SSH rows that share a GitHub repo icon identity', () => {
    const pickerRepos = getTaskProjectPickerRepos([
      repo({
        id: 'local-claude-swap',
        displayName: 'claude-swap',
        repoIcon: {
          type: 'image',
          src: 'https://github.com/nebutra.png?size=64',
          source: 'github',
          label: 'nebutra/claude-swap'
        }
      }),
      repo({
        id: 'ssh-claude-swap',
        displayName: 'claude-swap',
        connectionId: 'builder',
        repoIcon: {
          type: 'image',
          src: 'https://github.com/nebutra.png?size=64',
          source: 'github',
          label: 'Nebutra/claude-swap'
        }
      })
    ])

    expect(pickerRepos.map((candidate) => candidate.id)).toEqual(['local-claude-swap'])
  })
})

describe('getTaskProjectPickerGroups', () => {
  it('keeps all host sources under one logical project row', () => {
    const groups = getTaskProjectPickerGroups([
      repo({
        id: 'local-pebble',
        upstream: { owner: 'nebutra', repo: 'pebble' }
      }),
      repo({
        id: 'ssh-pebble',
        connectionId: 'builder',
        upstream: { owner: 'nebutra', repo: 'pebble' }
      }),
      repo({
        id: 'docs',
        upstream: { owner: 'nebutra', repo: 'docs' }
      })
    ])

    expect(groups).toHaveLength(2)
    expect(groups[0]).toMatchObject({
      projectKey: 'github:nebutra/pebble',
      repo: { id: 'local-pebble' }
    })
    expect(groups[0]?.sources.map((source) => source.id)).toEqual(['local-pebble', 'ssh-pebble'])
    expect(groups[1]).toMatchObject({
      projectKey: 'github:nebutra/docs',
      repo: { id: 'docs' }
    })
  })

  it('uses the explicitly selected source as the project representative', () => {
    const groups = getTaskProjectPickerGroups(
      [
        repo({
          id: 'local-pebble',
          upstream: { owner: 'nebutra', repo: 'pebble' }
        }),
        repo({
          id: 'ssh-pebble',
          connectionId: 'builder',
          upstream: { owner: 'nebutra', repo: 'pebble' }
        })
      ],
      new Set(['ssh-pebble'])
    )

    expect(groups[0]?.repo.id).toBe('ssh-pebble')
    expect(groups[0]?.sources.map((source) => source.id)).toEqual(['local-pebble', 'ssh-pebble'])
  })
})

describe('normalizeTaskRepoSelection', () => {
  it('collapses duplicate selected sources for the same logical project', () => {
    const selection = normalizeTaskRepoSelection(
      [
        repo({
          id: 'local-pebble',
          upstream: { owner: 'nebutra', repo: 'pebble' }
        }),
        repo({
          id: 'ssh-pebble',
          connectionId: 'builder',
          upstream: { owner: 'nebutra', repo: 'pebble' }
        })
      ],
      new Set(['local-pebble', 'ssh-pebble'])
    )

    expect([...selection]).toEqual(['local-pebble'])
  })

  it('preserves a single explicit remote source selection', () => {
    const selection = normalizeTaskRepoSelection(
      [
        repo({
          id: 'local-pebble',
          upstream: { owner: 'nebutra', repo: 'pebble' }
        }),
        repo({
          id: 'ssh-pebble',
          connectionId: 'builder',
          upstream: { owner: 'nebutra', repo: 'pebble' }
        })
      ],
      new Set(['ssh-pebble'])
    )

    expect([...selection]).toEqual(['ssh-pebble'])
  })

  it('normalizes raw all-host selection to one source per logical project', () => {
    const selection = normalizeTaskRepoSelection(
      [
        repo({
          id: 'local-pebble',
          upstream: { owner: 'nebutra', repo: 'pebble' }
        }),
        repo({
          id: 'ssh-pebble',
          connectionId: 'builder',
          upstream: { owner: 'nebutra', repo: 'pebble' }
        }),
        repo({
          id: 'docs',
          upstream: { owner: 'nebutra', repo: 'docs' }
        })
      ],
      new Set(['local-pebble', 'ssh-pebble', 'docs'])
    )

    expect([...selection].sort()).toEqual(['docs', 'local-pebble'])
  })
})
