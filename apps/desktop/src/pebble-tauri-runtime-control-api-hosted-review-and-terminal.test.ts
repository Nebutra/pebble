import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PreloadApi } from '../../../packages/product-core/shared/preload-api-types'
import { createPebbleRuntimeApi } from './pebble-tauri-runtime-control-api'

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

  it.each([
    ['github.mergePR', { repo: 'repo-1', prNumber: 3 }, 'github', 'squash'],
    ['gitlab.mergeMR', { repo: 'repo-1', iid: 4 }, 'gitlab', 'merge']
  ])('maps %s with its provider default', async (method, params, provider, mergeMethod) => {
    requestRuntimeJsonMock.mockResolvedValue({ ok: true })
    const api = createPebbleRuntimeApi({} as PreloadApi['runtime'])
    await expect(api.call({ method, params })).resolves.toMatchObject({
      ok: true,
      result: { ok: true }
    })
    expect(requestRuntimeJsonMock).toHaveBeenCalledWith(
      '/v1/providers/reviews/merge',
      expect.objectContaining({
        body: expect.objectContaining({ provider, method: mergeMethod })
      })
    )
  })

  it('flattens GitLab inline input into the native diff-position route', async () => {
    requestRuntimeJsonMock.mockResolvedValue({ ok: true, comment: { id: 1 } })
    const api = createPebbleRuntimeApi({} as PreloadApi['runtime'])
    await api.call({
      method: 'gitlab.addMRInlineComment',
      params: {
        repo: 'repo-1',
        iid: 4,
        input: {
          body: 'Fix',
          path: 'src/app.ts',
          oldPath: 'src/old.ts',
          line: 12,
          baseSha: 'base',
          startSha: 'start',
          headSha: 'head'
        }
      }
    })
    expect(requestRuntimeJsonMock).toHaveBeenCalledWith(
      '/v1/providers/reviews/inline-comments',
      expect.objectContaining({
        body: expect.objectContaining({
          provider: 'gitlab',
          number: 4,
          path: 'src/app.ts',
          oldPath: 'src/old.ts',
          line: 12,
          baseSha: 'base',
          startSha: 'start',
          headSha: 'head'
        })
      })
    )
  })

  it('maps GitHub review replies and GitLab discussion reopen', async () => {
    requestRuntimeJsonMock.mockResolvedValue({ ok: true, comment: { id: 1 } })
    const api = createPebbleRuntimeApi({} as PreloadApi['runtime'])
    await api.call({
      method: 'github.addPRReviewCommentReply',
      params: { repo: 'repo-1', prNumber: 3, commentId: 2, body: 'Reply', threadId: 'thread' }
    })
    expect(requestRuntimeJsonMock).toHaveBeenLastCalledWith(
      '/v1/providers/reviews/comment-replies',
      expect.objectContaining({
        body: expect.objectContaining({ number: 3, commentId: 2, threadId: 'thread' })
      })
    )
    requestRuntimeJsonMock.mockResolvedValue({ ok: true })
    await api.call({
      method: 'gitlab.resolveMRDiscussion',
      params: { repo: 'repo-1', iid: 4, discussionId: 'discussion', resolved: false }
    })
    expect(requestRuntimeJsonMock).toHaveBeenLastCalledWith(
      '/v1/providers/reviews/threads/resolve',
      expect.objectContaining({
        body: expect.objectContaining({
          provider: 'gitlab',
          number: 4,
          threadId: 'discussion',
          resolved: false
        })
      })
    )
    requestRuntimeJsonMock.mockResolvedValue({ ok: true })
    await api.call({
      method: 'github.resolveReviewThread',
      params: { repo: 'repo-1', threadId: 'PRRT_1', resolve: false }
    })
    expect(requestRuntimeJsonMock).toHaveBeenLastCalledWith(
      '/v1/providers/reviews/threads/resolve',
      expect.objectContaining({
        body: expect.objectContaining({ provider: 'github', threadId: 'PRRT_1', resolved: false })
      })
    )
  })

  it('maps GitHub viewed-file state and returns the boolean contract', async () => {
    requestRuntimeJsonMock.mockResolvedValue({ ok: true })
    const api = createPebbleRuntimeApi({} as PreloadApi['runtime'])
    await expect(
      api.call({
        method: 'github.setPRFileViewed',
        params: { repo: 'repo-1', pullRequestId: 'PR_1', path: 'src/app.ts', viewed: false }
      })
    ).resolves.toMatchObject({ ok: true, result: true })
    // Runtime RPC wraps booleans; false here would be ambiguous with failure, so
    // the bridge must return the route's ok status rather than the requested state.
    const call = requestRuntimeJsonMock.mock.calls.at(-1)
    expect(call).toEqual([
      '/v1/providers/reviews/files/viewed',
      expect.objectContaining({
        body: expect.objectContaining({ pullRequestId: 'PR_1', path: 'src/app.ts', viewed: false })
      })
    ])
  })

  it('maps GitHub auto-merge state with the squash default', async () => {
    requestRuntimeJsonMock.mockResolvedValue({ ok: true })
    const api = createPebbleRuntimeApi({} as PreloadApi['runtime'])
    await expect(
      api.call({
        method: 'github.setPRAutoMerge',
        params: { repo: 'repo-1', prNumber: 5, enabled: true }
      })
    ).resolves.toMatchObject({ ok: true, result: { ok: true } })
    expect(requestRuntimeJsonMock).toHaveBeenCalledWith(
      '/v1/providers/reviews/auto-merge',
      expect.objectContaining({
        body: expect.objectContaining({
          projectId: 'repo-1',
          number: 5,
          enabled: true,
          method: 'squash'
        })
      })
    )
  })

  it.each([
    ['github.addIssueComment', { repo: 'repo-1', number: 3, body: 'Ship it' }, 'github', 3],
    ['gitlab.addMRComment', { repo: 'repo-1', iid: 4, body: 'Ship it' }, 'gitlab', 4]
  ])('maps %s to the native comment route', async (method, params, provider, number) => {
    requestRuntimeJsonMock.mockResolvedValue({ ok: true, comment: { id: 1 } })
    const api = createPebbleRuntimeApi({} as PreloadApi['runtime'])
    await expect(api.call({ method, params })).resolves.toMatchObject({
      ok: true,
      result: { ok: true }
    })
    expect(requestRuntimeJsonMock).toHaveBeenCalledWith(
      '/v1/providers/reviews/comments',
      expect.objectContaining({
        body: expect.objectContaining({ provider, number, body: 'Ship it' })
      })
    )
  })

  it('maps host capability runtime calls to the Go host terminal capability endpoint', async () => {
    requestRuntimeJsonMock.mockResolvedValue({
      wslAvailable: true,
      wslDistros: ['Ubuntu'],
      pwshAvailable: true,
      gitBashAvailable: false,
      hostPlatform: 'win32'
    })
    const api = createPebbleRuntimeApi({} as PreloadApi['runtime'])

    await expect(api.call({ method: 'host.platform' })).resolves.toMatchObject({
      ok: true,
      result: { platform: 'win32' }
    })
    await expect(api.call({ method: 'host.wsl.isAvailable' })).resolves.toMatchObject({
      ok: true,
      result: true
    })
    await expect(api.call({ method: 'host.wsl.listDistros' })).resolves.toMatchObject({
      ok: true,
      result: ['Ubuntu']
    })
    await expect(api.call({ method: 'host.pwsh.isAvailable' })).resolves.toMatchObject({
      ok: true,
      result: true
    })
    await expect(api.call({ method: 'host.gitBash.isAvailable' })).resolves.toMatchObject({
      ok: true,
      result: false
    })
    expect(requestRuntimeJsonMock).toHaveBeenCalledWith('/v1/host/terminal-capabilities', {
      method: 'GET',
      timeoutMs: 8000
    })
  })

  it('maps hosted review lookup to the local provider bridge', async () => {
    requestRuntimeJsonMock.mockImplementation(async (path: string) => {
      if (path === '/v1/providers/github/pulls?projectId=repo-1&limit=24') {
        return {
          items: [
            {
              number: 42,
              title: 'Open PR',
              state: 'OPEN',
              url: 'https://github.com/nebutra/pebble/pull/42',
              updatedAt: '2026-07-08T12:00:00.000Z',
              branchName: 'feature/review',
              baseRefName: 'main',
              headSha: 'abc123'
            }
          ]
        }
      }
      throw new Error(`unexpected path ${path}`)
    })
    const api = createPebbleRuntimeApi({} as PreloadApi['runtime'])

    await expect(
      api.call({
        method: 'hostedReview.forBranch',
        params: { repo: 'repo-1', branch: 'feature/review' }
      })
    ).resolves.toMatchObject({
      ok: true,
      result: {
        provider: 'github',
        number: 42,
        title: 'Open PR',
        state: 'open',
        url: 'https://github.com/nebutra/pebble/pull/42',
        baseRefName: 'main',
        headSha: 'abc123'
      }
    })
  })

  it('falls back to GitLab MR lookup for hosted review branch matching', async () => {
    requestRuntimeJsonMock.mockImplementation(async (path: string) => {
      if (path.startsWith('/v1/providers/github/pulls?')) {
        throw new Error('gh unavailable')
      }
      if (
        path ===
        '/v1/providers/gitlab/merge-requests?projectId=repo-1&worktreeId=wt-1&perPage=24&state=opened&query=feature%2Freview'
      ) {
        return {
          items: [
            {
              number: 5,
              title: 'Open MR',
              state: 'opened',
              url: 'https://gitlab.com/nebutra/pebble/-/merge_requests/5',
              updatedAt: '2026-07-08T12:00:00.000Z',
              branchName: 'feature/review',
              baseRefName: 'main'
            }
          ]
        }
      }
      throw new Error(`unexpected path ${path}`)
    })
    const api = createPebbleRuntimeApi({} as PreloadApi['runtime'])

    await expect(
      api.call({
        method: 'hostedReview.forBranch',
        params: { repo: 'repo-1', worktree: 'wt-1', branch: 'feature/review' }
      })
    ).resolves.toMatchObject({
      ok: true,
      result: {
        provider: 'gitlab',
        number: 5,
        title: 'Open MR',
        state: 'open',
        url: 'https://gitlab.com/nebutra/pebble/-/merge_requests/5',
        baseRefName: 'main'
      }
    })
  })

  it('maps existing hosted review creation eligibility to open-existing-review UX', async () => {
    requestRuntimeJsonMock.mockResolvedValue({
      items: [
        {
          number: 7,
          title: 'Existing PR',
          state: 'OPEN',
          url: 'https://github.com/nebutra/pebble/pull/7',
          updatedAt: '2026-07-08T12:00:00.000Z',
          branchName: 'feature/review',
          baseRefName: 'main'
        }
      ]
    })
    const api = createPebbleRuntimeApi({} as PreloadApi['runtime'])

    await expect(
      api.call({
        method: 'hostedReview.getCreationEligibility',
        params: { repo: 'repo-1', branch: 'feature/review' }
      })
    ).resolves.toMatchObject({
      ok: true,
      result: {
        provider: 'github',
        review: { number: 7, url: 'https://github.com/nebutra/pebble/pull/7' },
        canCreate: false,
        blockedReason: 'existing_review',
        nextAction: 'open_existing_review'
      }
    })
  })

  it('maps hosted review creation eligibility to normal blocked-review UX', async () => {
    requestRuntimeJsonMock.mockImplementation(async (path: string) => {
      if (path.startsWith('/v1/providers/github/pulls?')) {
        return { items: [] }
      }
      if (path.startsWith('/v1/providers/gitlab/merge-requests?')) {
        return { items: [] }
      }
      if (path === '/v1/providers/review-capabilities?projectId=repo-1') {
        return { provider: 'unsupported', authenticated: false }
      }
      throw new Error(`unexpected path ${path}`)
    })
    const api = createPebbleRuntimeApi({} as PreloadApi['runtime'])

    await expect(
      api.call({
        method: 'hostedReview.getCreationEligibility',
        params: { repo: 'repo-1', branch: 'feature/review' }
      })
    ).resolves.toMatchObject({
      ok: true,
      result: {
        provider: 'unsupported',
        review: null,
        canCreate: false,
        blockedReason: 'unsupported_provider',
        nextAction: null
      }
    })
  })

  it('maps Go hosted review capabilities to creatable GitHub eligibility', async () => {
    requestRuntimeJsonMock.mockImplementation(async (path: string) => {
      if (path.startsWith('/v1/providers/github/pulls?')) {
        return { items: [] }
      }
      if (path.startsWith('/v1/providers/gitlab/merge-requests?')) {
        return { items: [] }
      }
      if (path === '/v1/providers/review-capabilities?projectId=repo-1') {
        return {
          provider: 'github',
          authenticated: true,
          currentBranch: 'feature/review',
          defaultBaseRef: 'main'
        }
      }
      throw new Error(`unexpected path ${path}`)
    })
    const api = createPebbleRuntimeApi({} as PreloadApi['runtime'])

    await expect(
      api.call({
        method: 'hostedReview.getCreationEligibility',
        params: {
          repo: 'repo-1',
          branch: 'refs/heads/feature/review',
          hasUpstream: true,
          ahead: 0,
          behind: 0
        }
      })
    ).resolves.toMatchObject({
      ok: true,
      result: {
        provider: 'github',
        canCreate: true,
        blockedReason: null,
        nextAction: null,
        defaultBaseRef: 'main',
        head: 'feature/review'
      }
    })
  })

  it('maps hosted review creation to the local Go provider route', async () => {
    requestRuntimeJsonMock.mockResolvedValue({
      ok: true,
      number: 42,
      url: 'https://github.com/nebutra/pebble/pull/42'
    })
    const api = createPebbleRuntimeApi({} as PreloadApi['runtime'])

    await expect(
      api.call({
        method: 'hostedReview.create',
        params: {
          repo: 'repo-1',
          provider: 'github',
          base: 'main',
          head: 'feature/review',
          body: 'Body',
          draft: true,
          title: 'Open PR'
        }
      })
    ).resolves.toMatchObject({
      ok: true,
      result: {
        ok: true,
        number: 42,
        url: 'https://github.com/nebutra/pebble/pull/42'
      }
    })
    expect(requestRuntimeJsonMock).toHaveBeenCalledWith('/v1/providers/reviews', {
      method: 'POST',
      timeoutMs: 60_000,
      body: {
        projectId: 'repo-1',
        provider: 'github',
        base: 'main',
        head: 'feature/review',
        title: 'Open PR',
        body: 'Body',
        draft: true,
        useTemplate: false
      }
    })
  })

  it('resolves hosted review creation path selectors before posting to Go', async () => {
    readWorktreesMock.mockResolvedValue([
      {
        id: 'wt-1',
        repoId: 'repo-1',
        path: '/repo/worktree',
        branch: 'feature/review'
      }
    ])
    requestRuntimeJsonMock.mockResolvedValue({
      ok: true,
      number: 43,
      url: 'https://gitlab.com/nebutra/pebble/-/merge_requests/43'
    })
    const api = createPebbleRuntimeApi({} as PreloadApi['runtime'])

    await expect(
      api.call({
        method: 'hostedReview.create',
        params: {
          repo: 'repo-1',
          worktree: 'path:/repo/worktree',
          provider: 'gitlab',
          base: 'main',
          head: 'feature/review',
          title: 'Open MR'
        }
      })
    ).resolves.toMatchObject({
      ok: true,
      result: {
        ok: true,
        number: 43
      }
    })
    expect(requestRuntimeJsonMock).toHaveBeenCalledWith('/v1/providers/reviews', {
      method: 'POST',
      timeoutMs: 60_000,
      body: {
        projectId: 'repo-1',
        worktreeId: 'wt-1',
        provider: 'gitlab',
        base: 'main',
        head: 'feature/review',
        title: 'Open MR',
        body: '',
        draft: false,
        useTemplate: false
      }
    })
  })

  it('maps mobile terminal display and viewport changes onto the native PTY fit state', async () => {
    const hasPty = vi.fn().mockResolvedValue(true)
    globalThis.window = {
      api: { pty: { hasPty } }
    } as unknown as Window & typeof globalThis
    requestRuntimeJsonMock.mockResolvedValue({ driver: { kind: 'desktop' } })
    const api = createPebbleRuntimeApi({} as PreloadApi['runtime'])

    await expect(
      api.call({
        method: 'terminal.setDisplayMode',
        params: {
          terminal: 'sess-1',
          mode: 'auto',
          client: { id: 'phone-1', type: 'mobile' },
          viewport: { cols: 72, rows: 24 }
        }
      })
    ).resolves.toMatchObject({ ok: true, result: { mode: 'auto' } })
    expect(requestRuntimeJsonMock).toHaveBeenCalledWith('/v1/sessions/sess-1/resize', {
      method: 'POST',
      body: { cols: 72, rows: 24, source: 'mobile', clientId: 'phone-1' },
      timeoutMs: 5000
    })

    await expect(
      api.call({ method: 'terminal.getDisplayMode', params: { terminal: 'sess-1' } })
    ).resolves.toMatchObject({
      ok: true,
      result: { mode: 'auto', isPhoneFitted: true }
    })

    await expect(
      api.call({
        method: 'terminal.updateViewport',
        params: {
          terminal: 'sess-1',
          client: { id: 'phone-1', type: 'mobile' },
          viewport: { cols: 80, rows: 30 }
        }
      })
    ).resolves.toMatchObject({ ok: true, result: { updated: true, applied: true } })
    expect(requestRuntimeJsonMock).toHaveBeenLastCalledWith('/v1/sessions/sess-1/resize', {
      method: 'POST',
      body: { cols: 80, rows: 30, source: 'mobile', clientId: 'phone-1' },
      timeoutMs: 5000
    })

    await expect(
      api.call({
        method: 'terminal.setDisplayMode',
        params: { terminal: 'sess-1', mode: 'desktop' }
      })
    ).resolves.toMatchObject({ ok: true, result: { mode: 'desktop' } })
    expect(requestRuntimeJsonMock).toHaveBeenCalledWith('/v1/sessions/sess-1/reclaim-desktop', {
      method: 'POST',
      timeoutMs: 5000
    })
  })

  it('rejects invalid terminal viewport geometry before resizing', async () => {
    const resize = vi.fn()
    globalThis.window = {
      api: { pty: { resize, hasPty: vi.fn().mockResolvedValue(true) } }
    } as unknown as Window & typeof globalThis
    const api = createPebbleRuntimeApi({} as PreloadApi['runtime'])

    await expect(
      api.call({
        method: 'terminal.updateViewport',
        params: {
          terminal: 'sess-1',
          client: { id: 'phone-1' },
          viewport: { cols: 10, rows: 2 }
        }
      })
    ).resolves.toMatchObject({ ok: false, error: { message: 'invalid_terminal_viewport' } })
    expect(resize).not.toHaveBeenCalled()
  })

  it('propagates base ref detail failures instead of returning fake empty details', async () => {
    const searchBaseRefs = vi.fn().mockResolvedValue(['main'])
    const searchBaseRefDetails = vi.fn().mockRejectedValue(new Error('base refs unavailable'))
    globalThis.window = {
      api: {
        repos: {
          searchBaseRefs,
          searchBaseRefDetails
        }
      }
    } as unknown as Window & typeof globalThis
    const api = createPebbleRuntimeApi({} as PreloadApi['runtime'])

    await expect(
      api.call({
        method: 'repo.searchRefs',
        params: { repo: 'repo-1', query: 'ma', limit: 8 }
      })
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'runtime_error',
        message: 'base refs unavailable'
      }
    })
    expect(searchBaseRefs).toHaveBeenCalledWith({
      repoId: 'repo-1',
      query: 'ma',
      limit: 8
    })
    expect(searchBaseRefDetails).toHaveBeenCalledWith({
      repoId: 'repo-1',
      query: 'ma',
      limit: 8
    })
  })
})
