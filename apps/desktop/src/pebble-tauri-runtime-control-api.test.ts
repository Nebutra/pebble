import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PreloadApi } from '../../../packages/product-core/shared/preload-api-types'
import { createPebbleRuntimeApi } from './pebble-tauri-runtime-control-api'
import { deliverRuntimeBrowserDriver } from './tauri-runtime-browser-driver-relay'

const { readReposMock, readWorktreesMock, emitActivateWorktreeMock, requestRuntimeJsonMock } =
  vi.hoisted(() => ({
    readReposMock: vi.fn(),
    readWorktreesMock: vi.fn(),
    emitActivateWorktreeMock: vi.fn(),
    requestRuntimeJsonMock: vi.fn()
  }))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn()
}))

vi.mock('./pebble-tauri-workspace-runtime-api', () => ({
  getRuntimeRepoId: (params: unknown) => {
    const input =
      typeof params === 'object' && params !== null ? (params as Record<string, unknown>) : {}
    return typeof input.repo === 'string'
      ? input.repo
      : typeof input.repoId === 'string'
        ? input.repoId
        : null
  },
  readRepos: readReposMock,
  readWorktrees: readWorktreesMock
}))

vi.mock('./tauri-settings-event-api', () => ({
  emitTauriActivateWorktree: emitActivateWorktreeMock
}))

vi.mock('./pebble-tauri-runtime-transport', () => ({
  ensurePebbleRuntimeProcess: vi.fn(),
  getErrorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
  getHostPlatform: () => 'darwin',
  hasTauriInternals: () => true,
  readPebbleStatusOrNull: vi.fn(),
  requestRuntimeJson: requestRuntimeJsonMock
}))

describe('createPebbleRuntimeApi', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requestRuntimeJsonMock.mockReset()
    readReposMock.mockReset()
  })

  it('advertises the native binary browser screencast transport', async () => {
    const api = createPebbleRuntimeApi({} as PreloadApi['runtime'])
    const status = await api.getStatus()
    expect(status.capabilities).toContain('browser.screencast.v1')
  })

  it('dispatches local orchestration task links through Go instead of the fallback', async () => {
    requestRuntimeJsonMock.mockResolvedValue([
      {
        id: 'dispatch-1',
        taskId: 'task-1',
        assignee: 'codex',
        sessionId: 'session-1',
        status: 'injected',
        createdAt: '2026-07-19T01:00:00Z',
        updatedAt: '2026-07-19T01:01:00Z'
      }
    ])
    const api = createPebbleRuntimeApi({} as PreloadApi['runtime'])

    await expect(
      api.call({ method: 'orchestration.dispatchShow', params: { task: 'task-1' } })
    ).resolves.toMatchObject({
      ok: true,
      result: { dispatch: { assignee_handle: 'session-1' } }
    })
    expect(requestRuntimeJsonMock).toHaveBeenCalledWith(
      '/v1/orchestration/dispatches?taskId=task-1',
      { method: 'GET', timeoutMs: 5000 }
    )
  })

  it('projects native browser ownership events and reclaims through Go', async () => {
    requestRuntimeJsonMock.mockResolvedValue({ reclaimed: true })
    const api = createPebbleRuntimeApi({} as PreloadApi['runtime'])
    const events: unknown[] = []
    const unsubscribe = api.onBrowserDriverChanged((event) => events.push(event))

    deliverRuntimeBrowserDriver('page-native-driver', {
      kind: 'mobile',
      clientId: 'phone-1'
    })
    await expect(api.getBrowserDrivers()).resolves.toContainEqual({
      browserPageId: 'page-native-driver',
      driver: { kind: 'mobile', clientId: 'phone-1' }
    })
    expect(events).toContainEqual({
      browserPageId: 'page-native-driver',
      driver: { kind: 'mobile', clientId: 'phone-1' }
    })

    await expect(api.reclaimBrowserForDesktop('page-native-driver')).resolves.toEqual({
      reclaimed: true
    })
    expect(requestRuntimeJsonMock).toHaveBeenCalledWith(
      '/v1/browser/tabs/page-native-driver/reclaim-desktop',
      { method: 'POST', timeoutMs: 5000 }
    )
    unsubscribe()
  })

  it('dispatches GitLab issue and combined work-item reads to native routes', async () => {
    requestRuntimeJsonMock.mockImplementation(async (path: string) => {
      if (path.startsWith('/v1/providers/gitlab/issues?')) {
        return { items: [{ number: 8, title: 'Issue', state: 'opened' }] }
      }
      if (path.startsWith('/v1/providers/gitlab/work-items?')) {
        return {
          items: [
            {
              id: 'gitlab-issue-8',
              type: 'issue',
              number: 8,
              title: 'Issue',
              state: 'opened',
              url: 'https://gl/8',
              labels: [],
              updatedAt: 'now',
              author: null
            }
          ]
        }
      }
      throw new Error(`unexpected path ${path}`)
    })
    const api = createPebbleRuntimeApi({} as PreloadApi['runtime'])

    await expect(
      api.call({
        method: 'gitlab.listIssues',
        params: { repo: 'repo-1', state: 'all', limit: 25 }
      })
    ).resolves.toMatchObject({ ok: true, result: { items: [{ number: 8 }] } })
    await expect(
      api.call({
        method: 'gitlab.listWorkItems',
        params: { repo: 'repo-1', state: 'opened', page: 1, perPage: 20 }
      })
    ).resolves.toMatchObject({
      ok: true,
      result: { items: [{ repoId: 'repo-1', type: 'issue' }], page: 1, perPage: 20 }
    })
    expect(requestRuntimeJsonMock).toHaveBeenNthCalledWith(
      1,
      '/v1/providers/gitlab/issues?projectId=repo-1&limit=25&state=all',
      { method: 'GET' }
    )
    expect(requestRuntimeJsonMock).toHaveBeenNthCalledWith(
      2,
      '/v1/providers/gitlab/work-items?projectId=repo-1&page=1&perPage=20&state=opened',
      { method: 'GET' }
    )
  })

  it('dispatches GitHub issue and work-item reads to native routes', async () => {
    requestRuntimeJsonMock.mockImplementation(async (path: string) => {
      if (path.includes('/issues?')) {
        return { items: [{ number: 8 }] }
      }
      if (path.includes('/work-items?')) {
        return {
          items: [],
          sources: { issues: null, prs: null, originCandidate: null, upstreamCandidate: null }
        }
      }
      if (path.includes('/work-item-details?')) {
        return { item: { id: 'issue:8', type: 'issue' }, body: 'Body', comments: [] }
      }
      if (path.includes('/work-item?')) {
        return {
          id: 'issue:8',
          type: 'issue',
          number: 8,
          title: 'Issue',
          state: 'open',
          url: 'https://gh/8',
          labels: [],
          updatedAt: 'now',
          author: null
        }
      }
      throw new Error(`unexpected path ${path}`)
    })
    const api = createPebbleRuntimeApi({} as PreloadApi['runtime'])
    await expect(
      api.call({ method: 'github.listIssues', params: { repo: 'repo-1', limit: 20 } })
    ).resolves.toMatchObject({ ok: true, result: [{ number: 8 }] })
    await expect(
      api.call({ method: 'github.listWorkItems', params: { repo: 'repo-1', limit: 24 } })
    ).resolves.toMatchObject({ ok: true, result: { items: [] } })
    await expect(
      api.call({ method: 'github.issue', params: { repo: 'repo-1', number: 8 } })
    ).resolves.toMatchObject({ ok: true, result: { number: 8, state: 'open' } })
    await expect(
      api.call({
        method: 'github.workItemByOwnerRepo',
        params: { repo: 'repo-1', owner: 'other', ownerRepo: 'repo', number: 8, type: 'issue' }
      })
    ).resolves.toMatchObject({ ok: true, result: { id: 'issue:8' } })
    await expect(
      api.call({
        method: 'github.workItemDetails',
        params: { repo: 'repo-1', number: 8, type: 'issue' }
      })
    ).resolves.toMatchObject({ ok: true, result: { body: 'Body' } })
  })

  it('dispatches GitHub issue metadata and creation to native routes', async () => {
    requestRuntimeJsonMock.mockImplementation(
      async (path: string, options?: { method?: string }) => {
        if (path.includes('/work-items/count?')) {
          return { count: 17 }
        }
        if (path.includes('/labels?')) {
          return { labels: ['bug'] }
        }
        if (path.includes('/assignable-users?')) {
          return { users: [{ login: 'octocat', name: null, avatarUrl: '' }] }
        }
        if (path.endsWith('/issues/create') && options?.method === 'POST') {
          return { ok: true, number: 42, url: 'https://gh/42' }
        }
        throw new Error(`unexpected path ${path}`)
      }
    )
    const api = createPebbleRuntimeApi({} as PreloadApi['runtime'])
    await expect(
      api.call({ method: 'github.countWorkItems', params: { repo: 'repo-1', query: 'is:issue' } })
    ).resolves.toMatchObject({ ok: true, result: 17 })
    await expect(
      api.call({ method: 'github.listLabels', params: { repo: 'repo-1' } })
    ).resolves.toMatchObject({ ok: true, result: ['bug'] })
    await expect(
      api.call({ method: 'github.listAssignableUsers', params: { repo: 'repo-1' } })
    ).resolves.toMatchObject({ ok: true, result: [{ login: 'octocat' }] })
    await expect(
      api.call({
        method: 'github.createIssue',
        params: { repo: 'repo-1', title: 'Ship', body: 'Body', labels: ['bug'] }
      })
    ).resolves.toMatchObject({ ok: true, result: { ok: true, number: 42 } })
  })

  it('dispatches GitLab issue mutations and labels to native routes', async () => {
    requestRuntimeJsonMock.mockImplementation(async (path: string) => {
      if (path.includes('/labels?')) {
        return ['bug']
      }
      if (path.endsWith('/create')) {
        return { ok: true, number: 42, url: 'https://gl/42' }
      }
      if (path.endsWith('/update')) {
        return { ok: true }
      }
      if (path.endsWith('/comment')) {
        return { ok: true, comment: { id: 9 } }
      }
      throw new Error(`unexpected path ${path}`)
    })
    const api = createPebbleRuntimeApi({} as PreloadApi['runtime'])

    await expect(
      api.call({ method: 'gitlab.listLabels', params: { repo: 'repo-1' } })
    ).resolves.toMatchObject({ ok: true, result: ['bug'] })
    await expect(
      api.call({
        method: 'gitlab.createIssue',
        params: { repo: 'repo-1', title: 'Ship', body: 'Body' }
      })
    ).resolves.toMatchObject({ ok: true, result: { ok: true, number: 42 } })
    await expect(
      api.call({
        method: 'gitlab.updateIssue',
        params: { repo: 'repo-1', number: 42, updates: { state: 'closed' } }
      })
    ).resolves.toMatchObject({ ok: true, result: { ok: true } })
    await expect(
      api.call({
        method: 'gitlab.addIssueComment',
        params: { repo: 'repo-1', number: 42, body: 'Done' }
      })
    ).resolves.toMatchObject({ ok: true, result: { ok: true, comment: { id: 9 } } })

    expect(requestRuntimeJsonMock.mock.calls.map(([path]) => path)).toEqual([
      '/v1/providers/gitlab/labels?projectId=repo-1',
      '/v1/providers/gitlab/issues/create',
      '/v1/providers/gitlab/issues/update',
      '/v1/providers/gitlab/issues/comment'
    ])
  })

  it('dispatches every remaining GitLab todo and detail read to native routes', async () => {
    requestRuntimeJsonMock.mockImplementation(async (path: string) => {
      if (path.includes('/todos?')) {
        return [{ id: 1 }]
      }
      if (path.includes('/work-item-details?')) {
        return { item: { id: 'gitlab-mr-9' }, comments: [] }
      }
      if (path.includes('/work-item-by-path?')) {
        return { id: 'gitlab-issue-81' }
      }
      throw new Error(`unexpected path ${path}`)
    })
    const api = createPebbleRuntimeApi({} as PreloadApi['runtime'])
    await expect(
      api.call({ method: 'gitlab.todos', params: { repo: 'repo-1' } })
    ).resolves.toMatchObject({ ok: true, result: [{ id: 1 }] })
    await expect(
      api.call({
        method: 'gitlab.workItemDetails',
        params: { repo: 'repo-1', iid: 9, type: 'mr' }
      })
    ).resolves.toMatchObject({ ok: true, result: { item: { id: 'gitlab-mr-9' } } })
    await expect(
      api.call({
        method: 'gitlab.workItemByPath',
        params: { repo: 'repo-1', host: 'git.internal', path: 'g/p', iid: 8, type: 'issue' }
      })
    ).resolves.toMatchObject({ ok: true, result: { id: 'gitlab-issue-81' } })
    expect(requestRuntimeJsonMock.mock.calls.map(([path]) => path)).toEqual([
      '/v1/providers/gitlab/todos?projectId=repo-1',
      '/v1/providers/gitlab/work-item-details?projectId=repo-1&iid=9&type=mr',
      '/v1/providers/gitlab/work-item-by-path?projectId=repo-1&host=git.internal&path=g%2Fp&iid=8&type=issue'
    ])
  })

  it('reads SSH issue commands through the Go file relay', async () => {
    readReposMock.mockResolvedValue([
      {
        id: 'repo-ssh',
        kind: 'git',
        path: '/home/user/repo',
        connectionId: 'ssh-1'
      }
    ])
    requestRuntimeJsonMock.mockImplementation(async (path: string) => {
      if (path.includes('path=.pebble%2Fissue-command')) {
        return { content: 'pnpm issue' }
      }
      if (path.includes('path=pebble.yaml')) {
        return { content: 'issueCommand: pnpm shared' }
      }
      throw new Error(`unexpected path ${path}`)
    })
    const api = createPebbleRuntimeApi({} as PreloadApi['runtime'])

    await expect(
      api.call({ method: 'repo.issueCommandRead', params: { repoId: 'repo-ssh' } })
    ).resolves.toMatchObject({
      ok: true,
      result: {
        status: 'ok',
        localContent: 'pnpm issue',
        sharedContent: 'pnpm shared',
        effectiveContent: 'pnpm issue',
        source: 'local'
      }
    })
  })

  it('inspects SSH setup scripts through the Go file relay', async () => {
    readReposMock.mockResolvedValue([
      {
        id: 'repo-ssh',
        kind: 'git',
        path: '/home/user/repo',
        connectionId: 'ssh-1'
      }
    ])
    requestRuntimeJsonMock.mockImplementation(async (path: string) => {
      if (path.includes('path=.superset%2Fconfig.json')) {
        return { content: JSON.stringify({ setup: 'pnpm install' }) }
      }
      throw new Error('not found')
    })
    const api = createPebbleRuntimeApi({} as PreloadApi['runtime'])

    await expect(
      api.call({ method: 'repo.setupScriptImports', params: { repoId: 'repo-ssh' } })
    ).resolves.toMatchObject({
      ok: true,
      result: [
        {
          provider: 'superset',
          setup: 'pnpm install'
        }
      ]
    })
  })

  it('maps worktree.activate to the Tauri UI activation event', async () => {
    readWorktreesMock.mockResolvedValue([
      {
        id: 'wt-1',
        repoId: 'repo-1'
      }
    ])
    const api = createPebbleRuntimeApi({} as PreloadApi['runtime'])

    await expect(
      api.call({
        method: 'worktree.activate',
        params: { worktree: 'id:wt-1' }
      })
    ).resolves.toMatchObject({
      ok: true,
      result: {
        repoId: 'repo-1',
        worktreeId: 'wt-1',
        activated: true
      }
    })
    expect(emitActivateWorktreeMock).toHaveBeenCalledWith({
      repoId: 'repo-1',
      worktreeId: 'wt-1'
    })
  })

  it('maps GitHub title edits to the native provider review update route', async () => {
    requestRuntimeJsonMock.mockResolvedValue({ ok: true })
    const api = createPebbleRuntimeApi({} as PreloadApi['runtime'])

    await expect(
      api.call({
        method: 'github.updatePRTitle',
        params: {
          repo: 'repo-1',
          worktreeId: 'wt-1',
          prNumber: 42,
          title: 'Parallel universe ready'
        }
      })
    ).resolves.toMatchObject({ ok: true, result: { ok: true } })
    expect(requestRuntimeJsonMock).toHaveBeenCalledWith('/v1/providers/reviews/update', {
      method: 'POST',
      timeoutMs: 30_000,
      body: {
        projectId: 'repo-1',
        worktreeId: 'wt-1',
        provider: 'github',
        number: 42,
        title: 'Parallel universe ready'
      }
    })
  })

  it('preserves GitHub retarget and draft fields from the update envelope', async () => {
    requestRuntimeJsonMock.mockResolvedValue({ ok: true })
    const api = createPebbleRuntimeApi({} as PreloadApi['runtime'])

    await api.call({
      method: 'github.updatePR',
      params: {
        repo: 'repo-1',
        prNumber: 42,
        prRepo: { owner: 'upstream', repo: 'project' },
        updates: { baseRefName: 'release/next', draft: true }
      }
    })
    expect(requestRuntimeJsonMock).toHaveBeenCalledWith(
      '/v1/providers/reviews/update',
      expect.objectContaining({
        body: expect.objectContaining({
          provider: 'github',
          number: 42,
          base: 'release/next',
          draft: true,
          owner: 'upstream',
          repo: 'project'
        })
      })
    )
  })

  it('preserves GitLab target and ready fields from the update envelope', async () => {
    requestRuntimeJsonMock.mockResolvedValue({ ok: true })
    const api = createPebbleRuntimeApi({} as PreloadApi['runtime'])

    await api.call({
      method: 'gitlab.updateMR',
      params: {
        repo: 'repo-1',
        iid: 9,
        updates: { targetBranch: 'stable', draft: false }
      }
    })
    expect(requestRuntimeJsonMock).toHaveBeenCalledWith(
      '/v1/providers/reviews/update',
      expect.objectContaining({
        body: expect.objectContaining({
          provider: 'gitlab',
          number: 9,
          base: 'stable',
          draft: false
        })
      })
    )
  })

  it('maps GitHub check details and rerun actions to native provider routes', async () => {
    requestRuntimeJsonMock
      .mockResolvedValueOnce({ details: { name: 'CI', annotations: [], jobs: [] } })
      .mockResolvedValueOnce({ ok: true, count: 1 })
    const api = createPebbleRuntimeApi({} as PreloadApi['runtime'])

    await expect(
      api.call({
        method: 'github.prCheckDetails',
        params: { repo: 'repo-1', worktreeId: 'wt-1', workflowRunId: 34, checkName: 'CI' }
      })
    ).resolves.toMatchObject({ ok: true, result: { name: 'CI' } })
    await expect(
      api.call({
        method: 'github.rerunPRChecks',
        params: {
          repo: 'repo-1',
          worktreeId: 'wt-1',
          prNumber: 42,
          headSha: 'abc123',
          failedOnly: true
        }
      })
    ).resolves.toMatchObject({ ok: true, result: { ok: true, count: 1 } })
    expect(requestRuntimeJsonMock).toHaveBeenNthCalledWith(
      1,
      '/v1/providers/github/pulls/check-details?projectId=repo-1&worktreeId=wt-1&workflowRunId=34&checkName=CI',
      { method: 'GET' }
    )
    expect(requestRuntimeJsonMock).toHaveBeenNthCalledWith(
      2,
      '/v1/providers/github/pulls/checks/rerun',
      {
        method: 'POST',
        timeoutMs: 60_000,
        body: {
          projectId: 'repo-1',
          worktreeId: 'wt-1',
          prNumber: 42,
          headSha: 'abc123',
          failedOnly: true
        }
      }
    )
  })

  it('maps GitLab reviewer replacement to the native provider route', async () => {
    requestRuntimeJsonMock.mockResolvedValue({
      ok: true,
      reviewers: [{ id: 7, username: 'tanuki', avatarUrl: '' }]
    })
    const api = createPebbleRuntimeApi({} as PreloadApi['runtime'])

    await expect(
      api.call({
        method: 'gitlab.updateMRReviewers',
        params: {
          repo: 'repo-1',
          iid: 9,
          reviewerIds: [7]
        }
      })
    ).resolves.toMatchObject({
      ok: true,
      result: { ok: true, reviewers: [{ id: 7, username: 'tanuki' }] }
    })
    expect(requestRuntimeJsonMock).toHaveBeenCalledWith(
      '/v1/providers/reviews/update',
      expect.objectContaining({
        body: expect.objectContaining({
          projectId: 'repo-1',
          provider: 'gitlab',
          number: 9,
          reviewerIds: [7]
        })
      })
    )
  })

  it('maps GitLab pipeline trace and retry actions to native provider routes', async () => {
    requestRuntimeJsonMock
      .mockResolvedValueOnce({ ok: true, trace: 'failed output' })
      .mockResolvedValueOnce({ ok: true, job: { id: 100, name: 'test' } })
    const api = createPebbleRuntimeApi({} as PreloadApi['runtime'])
    const params = {
      repo: 'repo-1',
      worktreeId: 'wt-1',
      jobId: 99,
      projectRef: { host: 'git.internal', path: 'g/p' }
    }

    await expect(api.call({ method: 'gitlab.jobTrace', params })).resolves.toMatchObject({
      ok: true,
      result: { ok: true, trace: 'failed output' }
    })
    await expect(api.call({ method: 'gitlab.retryJob', params })).resolves.toMatchObject({
      ok: true,
      result: { ok: true, job: { id: 100 } }
    })
    expect(requestRuntimeJsonMock).toHaveBeenNthCalledWith(
      1,
      '/v1/providers/gitlab/jobs/trace',
      expect.objectContaining({ method: 'POST', body: expect.objectContaining({ jobId: 99 }) })
    )
    expect(requestRuntimeJsonMock).toHaveBeenNthCalledWith(
      2,
      '/v1/providers/gitlab/jobs/retry',
      expect.objectContaining({ method: 'POST', body: expect.objectContaining({ jobId: 99 }) })
    )
  })

  it('maps GitHub and self-hosted GitLab rate limits to native provider routes', async () => {
    requestRuntimeJsonMock
      .mockResolvedValueOnce({ ok: true, snapshot: { fetchedAt: 1 } })
      .mockResolvedValueOnce({ ok: true, snapshot: { fetchedAt: 2 } })
    const api = createPebbleRuntimeApi({} as PreloadApi['runtime'])

    await expect(
      api.call({ method: 'github.rateLimit', params: { force: true } })
    ).resolves.toMatchObject({ ok: true, result: { ok: true } })
    await expect(
      api.call({
        method: 'gitlab.rateLimit',
        params: { force: true, host: 'git.internal' }
      })
    ).resolves.toMatchObject({ ok: true, result: { ok: true } })
    expect(requestRuntimeJsonMock).toHaveBeenNthCalledWith(
      1,
      '/v1/providers/github/rate-limit?force=true',
      { method: 'GET' }
    )
    expect(requestRuntimeJsonMock).toHaveBeenNthCalledWith(
      2,
      '/v1/providers/gitlab/rate-limit?force=true&host=git.internal',
      { method: 'GET' }
    )
  })

  it('maps provider viewer and auth diagnostic calls to native routes', async () => {
    requestRuntimeJsonMock
      .mockResolvedValueOnce({ login: 'octocat', email: null })
      .mockResolvedValueOnce({ ghAvailable: true, accounts: [] })
      .mockResolvedValueOnce({ username: 'tanuki', email: null })
      .mockResolvedValueOnce({ glabAvailable: true, authenticated: true })
    const api = createPebbleRuntimeApi({} as PreloadApi['runtime'])

    for (const method of [
      'github.viewer',
      'github.diagnoseAuth',
      'gitlab.viewer',
      'gitlab.diagnoseAuth'
    ]) {
      await expect(api.call({ method })).resolves.toMatchObject({ ok: true })
    }
    expect(requestRuntimeJsonMock.mock.calls.map(([path]) => path)).toEqual([
      '/v1/providers/github/viewer',
      '/v1/providers/github/auth-diagnostic',
      '/v1/providers/gitlab/viewer',
      '/v1/providers/gitlab/auth-diagnostic'
    ])
  })

})
