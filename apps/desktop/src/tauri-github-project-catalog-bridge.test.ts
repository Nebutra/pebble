import { describe, expect, it, vi } from 'vitest'
import {
  fetchAccessibleGitHubProjects,
  fetchGitHubProjectAssignableUsers,
  fetchGitHubProjectIssueTypes,
  fetchGitHubProjectLabels,
  addGitHubProjectIssueComment,
  deleteGitHubProjectIssueComment,
  updateGitHubProjectIssue,
  updateGitHubProjectIssueComment,
  fetchGitHubProjectViewTable,
  fetchGitHubProjectViews,
  resolveGitHubProjectRef
} from './tauri-github-project-catalog-bridge'

describe('Tauri GitHub project catalog bridge', () => {
  it('loads accessible projects from the native provider route', async () => {
    const requestJson = vi.fn().mockResolvedValue({ ok: true, projects: [] })
    await fetchAccessibleGitHubProjects(requestJson)
    expect(requestJson).toHaveBeenCalledWith('/v1/providers/github/projects')
  })
  it('encodes pasted project references', async () => {
    const requestJson = vi.fn().mockResolvedValue({ ok: true, owner: 'nebutra' })
    await resolveGitHubProjectRef(requestJson, {
      input: 'https://github.com/orgs/nebutra/projects/4/views/9'
    })
    expect(requestJson).toHaveBeenCalledWith(
      '/v1/providers/github/projects/resolve?input=https%3A%2F%2Fgithub.com%2Forgs%2Fnebutra%2Fprojects%2F4%2Fviews%2F9'
    )
  })

  it('encodes project view selectors', async () => {
    const requestJson = vi.fn().mockResolvedValue({ ok: true, views: [] })
    await fetchGitHubProjectViews(requestJson, {
      owner: 'nebutra',
      ownerType: 'organization',
      projectNumber: 4
    })
    expect(requestJson).toHaveBeenCalledWith(
      '/v1/providers/github/projects/views?owner=nebutra&ownerType=organization&projectNumber=4'
    )
  })

  it('posts the complete project table selector without dropping an empty query override', async () => {
    const requestJson = vi.fn().mockResolvedValue({ ok: true, data: {} })
    await fetchGitHubProjectViewTable(requestJson, {
      owner: 'nebutra',
      ownerType: 'organization',
      projectNumber: 4,
      viewId: 'PVTV_1',
      viewNumber: 9,
      viewName: 'Current',
      queryOverride: ''
    })
    expect(requestJson).toHaveBeenCalledWith('/v1/providers/github/projects/view-table', {
      method: 'POST',
      timeoutMs: 60_000,
      body: {
        owner: 'nebutra',
        ownerType: 'organization',
        projectNumber: 4,
        viewId: 'PVTV_1',
        viewNumber: 9,
        viewName: 'Current',
        queryOverride: ''
      }
    })
  })

  it('uses explicit repository slugs for project metadata', async () => {
    const requestJson = vi.fn().mockResolvedValue({ ok: true })
    const params = { owner: 'nebutra', repo: 'pebble' }
    await fetchGitHubProjectLabels(requestJson, params)
    await fetchGitHubProjectAssignableUsers(requestJson, params)
    await fetchGitHubProjectIssueTypes(requestJson, params)
    expect(requestJson).toHaveBeenNthCalledWith(
      1,
      '/v1/providers/github/projects/repository/labels?owner=nebutra&repo=pebble'
    )
    expect(requestJson).toHaveBeenNthCalledWith(
      2,
      '/v1/providers/github/projects/repository/assignees?owner=nebutra&repo=pebble'
    )
    expect(requestJson).toHaveBeenNthCalledWith(
      3,
      '/v1/providers/github/projects/repository/issue-types?owner=nebutra&repo=pebble'
    )
  })

  it('posts slug-addressed issue and comment mutations', async () => {
    const requestJson = vi.fn().mockResolvedValue({ ok: true })
    await updateGitHubProjectIssue(requestJson, {
      owner: 'acme',
      repo: 'widgets',
      number: 7,
      updates: { title: 'New' }
    })
    await addGitHubProjectIssueComment(requestJson, {
      owner: 'acme',
      repo: 'widgets',
      number: 7,
      body: 'Hello'
    })
    await updateGitHubProjectIssueComment(requestJson, {
      owner: 'acme',
      repo: 'widgets',
      commentId: 11,
      body: 'Edited'
    })
    await deleteGitHubProjectIssueComment(requestJson, {
      owner: 'acme',
      repo: 'widgets',
      commentId: 11
    })
    expect(requestJson).toHaveBeenNthCalledWith(
      1,
      '/v1/providers/github/projects/repository/issue/update',
      expect.objectContaining({ body: expect.objectContaining({ number: 7 }) })
    )
    expect(requestJson).toHaveBeenNthCalledWith(
      2,
      '/v1/providers/github/projects/repository/comments',
      expect.objectContaining({ body: expect.objectContaining({ action: 'add' }) })
    )
    expect(requestJson).toHaveBeenNthCalledWith(
      3,
      '/v1/providers/github/projects/repository/comments',
      expect.objectContaining({
        body: expect.objectContaining({ action: 'update', commentId: 11 })
      })
    )
    expect(requestJson).toHaveBeenNthCalledWith(
      4,
      '/v1/providers/github/projects/repository/comments',
      expect.objectContaining({
        body: expect.objectContaining({ action: 'delete', commentId: 11 })
      })
    )
  })
})
