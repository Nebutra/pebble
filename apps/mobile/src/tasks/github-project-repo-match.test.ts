import { describe, expect, it } from 'vitest'
import {
  filterGitHubProjectRowsForRepos,
  findRepoForGitHubProjectRepository,
  normalizeGitHubRepositorySlug
} from './github-project-repo-match'

const repos = [
  { id: 'repo-1', path: '/Users/me/pebble', displayName: 'pebble' },
  { id: 'repo-2', path: '/Users/me/other', displayName: 'other' }
]

describe('GitHub project repo matching', () => {
  it('normalizes owner/repo slugs case-insensitively', () => {
    expect(normalizeGitHubRepositorySlug(' Nebutra/Pebble ')).toBe('nebutra/pebble')
    expect(normalizeGitHubRepositorySlug('pebble')).toBeNull()
    expect(normalizeGitHubRepositorySlug('nebutra/pebble/extra')).toBeNull()
  })

  it('matches project rows by resolved repo slug before path/display heuristics', () => {
    expect(
      findRepoForGitHubProjectRepository('nebutra/pebble', repos, {
        'repo-1': { path: '/Users/me/pebble', slug: 'nebutra/pebble' }
      })
    ).toBe(repos[0])
  })

  it('does not pick a repo when resolved slugs are ambiguous', () => {
    expect(
      findRepoForGitHubProjectRepository('nebutra/pebble', repos, {
        'repo-1': { path: '/Users/me/pebble', slug: 'nebutra/pebble' },
        'repo-2': { path: '/Users/me/other', slug: 'nebutra/pebble' }
      })
    ).toBeNull()
  })

  it('falls back to exact display/path slug matching when slug resolution is unavailable', () => {
    expect(
      findRepoForGitHubProjectRepository('nebutra/pebble', [
        { id: 'repo-1', path: '/Users/me/nebutra/pebble', displayName: 'pebble' }
      ])
    ).toEqual({ id: 'repo-1', path: '/Users/me/nebutra/pebble', displayName: 'pebble' })
  })

  it('normalizes Windows paths before path slug fallback matching', () => {
    expect(
      findRepoForGitHubProjectRepository('nebutra/pebble', [
        { id: 'repo-1', path: 'C:\\Users\\me\\nebutra\\pebble', displayName: 'pebble' }
      ])
    ).toEqual({ id: 'repo-1', path: 'C:\\Users\\me\\nebutra\\pebble', displayName: 'pebble' })
  })

  it('does not path-match a repo whose resolved slug points somewhere else', () => {
    expect(
      findRepoForGitHubProjectRepository(
        'nebutra/pebble',
        [{ id: 'repo-1', path: '/Users/me/nebutra/pebble', displayName: 'pebble' }],
        {
          'repo-1': { path: '/Users/me/nebutra/pebble', slug: 'fork/pebble' }
        }
      )
    ).toBeNull()
  })

  it('filters project rows to rows backed by open repositories', () => {
    const rows = [
      { id: 'row-1', content: { repository: 'nebutra/pebble' } },
      { id: 'row-2', content: { repository: 'other/missing' } },
      { id: 'row-3', content: { repository: null } }
    ]

    expect(
      filterGitHubProjectRowsForRepos(rows, repos, {
        'repo-1': { path: '/Users/me/pebble', slug: 'nebutra/pebble' }
      }).map((row) => row.id)
    ).toEqual(['row-1'])
  })
})
