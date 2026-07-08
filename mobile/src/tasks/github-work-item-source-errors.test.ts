import { describe, expect, it } from 'vitest'
import {
  extractGitHubIssueSourceError,
  extractGitHubIssueSourceFallback
} from './github-work-item-source-errors'

describe('extractGitHubIssueSourceError', () => {
  it('keeps the failing issue source slug with the repo that produced it', () => {
    expect(
      extractGitHubIssueSourceError(
        { id: 'repo-1', path: '/work/pebble' },
        {
          sources: { issues: { owner: 'upstream', repo: 'pebble' } },
          errors: { issues: { message: 'HTTP 403: resource not accessible' } }
        }
      )
    ).toEqual({
      repoId: 'repo-1',
      repoPath: '/work/pebble',
      source: { owner: 'upstream', repo: 'pebble' },
      message: 'HTTP 403: resource not accessible'
    })
  })

  it('drops issue errors when the source slug is unavailable', () => {
    expect(
      extractGitHubIssueSourceError(
        { id: 'repo-1', path: '/work/pebble' },
        {
          sources: { issues: null },
          errors: { issues: { message: 'failed' } }
        }
      )
    ).toBeNull()
  })

  it('returns null when the envelope has no issue-side error', () => {
    expect(
      extractGitHubIssueSourceError(
        { id: 'repo-1', path: '/work/pebble' },
        {
          sources: { issues: { owner: 'nebutra', repo: 'pebble' } }
        }
      )
    ).toBeNull()
  })
})

describe('extractGitHubIssueSourceFallback', () => {
  it('reports the repo whose upstream issue source fell back to origin', () => {
    expect(
      extractGitHubIssueSourceFallback(
        { id: 'repo-1', path: '/work/pebble', displayName: 'pebble' },
        {
          issueSourceFellBack: true,
          sources: {
            issues: { owner: 'nebutra', repo: 'pebble-fork' },
            prs: { owner: 'nebutra', repo: 'pebble' }
          }
        }
      )
    ).toEqual({
      repoId: 'repo-1',
      repoPath: '/work/pebble',
      repoLabel: 'nebutra/pebble'
    })
  })

  it('uses the Pebble repo display name when the PR source is unavailable', () => {
    expect(
      extractGitHubIssueSourceFallback(
        { id: 'repo-1', path: '/work/pebble', displayName: 'pebble' },
        {
          issueSourceFellBack: true,
          sources: { issues: null, prs: null }
        }
      )
    ).toEqual({
      repoId: 'repo-1',
      repoPath: '/work/pebble',
      repoLabel: 'pebble'
    })
  })

  it('returns null when the source resolver did not fall back', () => {
    expect(
      extractGitHubIssueSourceFallback(
        { id: 'repo-1', path: '/work/pebble', displayName: 'pebble' },
        {
          sources: { issues: { owner: 'nebutra', repo: 'pebble' } }
        }
      )
    ).toBeNull()
  })
})
