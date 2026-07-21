import { beforeEach, describe, expect, it, vi } from 'vitest'

const { emitOpenDiffMock, emitOpenFileMock, requestRuntimeJsonMock, runtimeEnvCallMock } =
  vi.hoisted(() => ({
    emitOpenDiffMock: vi.fn(),
    emitOpenFileMock: vi.fn(),
    requestRuntimeJsonMock: vi.fn(),
    runtimeEnvCallMock: vi.fn()
  }))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn()
}))

vi.mock('@tauri-apps/api/path', () => ({
  homeDir: vi.fn()
}))

vi.mock('./pebble-tauri-runtime-transport', () => ({
  requestRuntimeJson: requestRuntimeJsonMock
}))

vi.mock('./tauri-settings-event-api', () => ({
  emitTauriOpenDiffFromMobile: emitOpenDiffMock,
  emitTauriOpenFileFromMobile: emitOpenFileMock
}))

import { callTauriFileRuntimeRpc } from './tauri-file-runtime-rpc'

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('window', {
    api: {
      runtimeEnvironments: {
        call: runtimeEnvCallMock
      }
    }
  })
  requestRuntimeJsonMock.mockImplementation(async (path: string, options?: { method?: string }) => {
    if (path === '/v1/worktrees' && options?.method === 'GET') {
      return [{ id: 'wt-1', projectId: 'repo-1', path: '/repo' }]
    }
    if (path === '/v1/projects' && options?.method === 'GET') {
      return [{ id: 'repo-1', locationKind: 'local' }]
    }
    if (path === '/v1/source-control?workspaceId=wt-1' && options?.method === 'GET') {
      return [{ repositoryId: 'repo-1', workspaceId: 'wt-1' }]
    }
    if (path === '/v1/files/list' && options?.method === 'POST') {
      return {
        files: [
          { relativePath: 'docs/readme.md' },
          { relativePath: 'src/main.ts' },
          { relativePath: 'image.png' }
        ]
      }
    }
    throw new Error(`unexpected runtime request ${path}`)
  })
})

describe('callTauriFileRuntimeRpc', () => {
  it('commits uploads through the atomic Go runtime route without a follow-up delete', async () => {
    requestRuntimeJsonMock.mockImplementation(
      async (path: string, options?: { method?: string; body?: unknown }) => {
        if (path === '/v1/worktrees' && options?.method === 'GET') {
          return [{ id: 'wt-1', projectId: 'repo-1', path: '/repo' }]
        }
        if (path === '/v1/projects' && options?.method === 'GET') {
          return [{ id: 'repo-1', locationKind: 'local' }]
        }
        if (path === '/v1/source-control?workspaceId=wt-1' && options?.method === 'GET') {
          return [{ repositoryId: 'repo-1', workspaceId: 'wt-1' }]
        }
        if (path === '/v1/files/commit-upload' && options?.method === 'POST') {
          return { ok: true }
        }
        throw new Error(`unexpected runtime request ${path}`)
      }
    )

    await expect(
      callTauriFileRuntimeRpc('files.commitUpload', {
        worktree: 'id:wt-1',
        tempRelativePath: '.capture.tmp',
        finalRelativePath: 'recordings/capture.webm'
      })
    ).resolves.toEqual({ handled: true, result: { ok: true } })

    expect(requestRuntimeJsonMock).toHaveBeenLastCalledWith('/v1/files/commit-upload', {
      method: 'POST',
      body: {
        projectId: 'repo-1',
        worktreeId: 'wt-1',
        sourcePath: '.capture.tmp',
        destinationPath: 'recordings/capture.webm'
      }
    })
    expect(requestRuntimeJsonMock).not.toHaveBeenCalledWith('/v1/files/delete', expect.anything())
  })

  it('maps files.list to mobile-compatible file entries from the Go runtime', async () => {
    await expect(callTauriFileRuntimeRpc('files.list', { worktree: 'id:wt-1' })).resolves.toEqual({
      handled: true,
      result: {
        worktree: 'wt-1',
        rootPath: '/repo',
        files: [
          { relativePath: 'docs/readme.md', basename: 'readme.md', kind: 'text' },
          { relativePath: 'image.png', basename: 'image.png', kind: 'binary' },
          { relativePath: 'src/main.ts', basename: 'main.ts', kind: 'text' }
        ],
        totalCount: 3,
        truncated: false
      }
    })
  })

  it('maps files.open to the renderer mobile file-open event', async () => {
    await expect(
      callTauriFileRuntimeRpc('files.open', {
        worktree: 'id:wt-1',
        relativePath: 'docs/readme.md'
      })
    ).resolves.toEqual({
      handled: true,
      result: {
        worktree: 'wt-1',
        relativePath: 'docs/readme.md',
        kind: 'markdown',
        opened: true
      }
    })

    expect(emitOpenFileMock).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      filePath: '/repo/docs/readme.md',
      relativePath: 'docs/readme.md'
    })
  })

  it('keeps Electron-compatible mobile image open classification', async () => {
    await expect(
      callTauriFileRuntimeRpc('files.open', {
        worktree: 'id:wt-1',
        relativePath: 'assets/logo.png'
      })
    ).resolves.toEqual({
      handled: true,
      result: {
        worktree: 'wt-1',
        relativePath: 'assets/logo.png',
        kind: 'image',
        opened: true
      }
    })

    await expect(
      callTauriFileRuntimeRpc('files.open', {
        worktree: 'id:wt-1',
        relativePath: 'assets/logo.svg'
      })
    ).resolves.toEqual({
      handled: true,
      result: {
        worktree: 'wt-1',
        relativePath: 'assets/logo.svg',
        kind: 'text',
        opened: true
      }
    })
  })

  it('maps files.openDiff to the renderer mobile diff-open event', async () => {
    await expect(
      callTauriFileRuntimeRpc('files.openDiff', {
        worktree: 'id:wt-1',
        relativePath: 'src/main.ts',
        staged: true
      })
    ).resolves.toEqual({
      handled: true,
      result: {
        worktree: 'wt-1',
        relativePath: 'src/main.ts',
        kind: 'text',
        opened: true
      }
    })

    expect(emitOpenDiffMock).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      filePath: '/repo/src/main.ts',
      relativePath: 'src/main.ts',
      staged: true
    })
  })

  it('proxies SSH files.list to the paired runtime environment', async () => {
    requestRuntimeJsonMock.mockImplementation(
      async (path: string, options?: { method?: string }) => {
        if (path === '/v1/worktrees' && options?.method === 'GET') {
          return [{ id: 'wt-ssh', projectId: 'repo-ssh', path: '/home/me/repo' }]
        }
        if (path === '/v1/projects' && options?.method === 'GET') {
          return [{ id: 'repo-ssh', locationKind: 'ssh', hostId: 'conn-1' }]
        }
        throw new Error(`unexpected runtime request ${path}`)
      }
    )
    runtimeEnvCallMock.mockResolvedValue({
      ok: true,
      result: {
        worktree: 'wt-ssh',
        rootPath: '/home/me/repo',
        files: [{ relativePath: 'remote.ts', basename: 'remote.ts', kind: 'text' }],
        totalCount: 1,
        truncated: false
      }
    })

    await expect(callTauriFileRuntimeRpc('files.list', { worktree: 'id:wt-ssh' })).resolves.toEqual(
      {
        handled: true,
        result: {
          worktree: 'wt-ssh',
          rootPath: '/home/me/repo',
          files: [{ relativePath: 'remote.ts', basename: 'remote.ts', kind: 'text' }],
          totalCount: 1,
          truncated: false
        }
      }
    )

    expect(runtimeEnvCallMock).toHaveBeenCalledWith({
      selector: 'conn-1',
      method: 'files.list',
      params: { worktree: 'id:wt-ssh' },
      timeoutMs: 10_000
    })
  })

  it('falls back to local Go relay routes when an SSH host is not a paired runtime', async () => {
    requestRuntimeJsonMock.mockImplementation(
      async (path: string, options?: { method?: string }) => {
        if (path === '/v1/worktrees' && options?.method === 'GET') {
          return [{ id: 'wt-ssh', projectId: 'repo-ssh', path: '/home/me/repo' }]
        }
        if (path === '/v1/projects' && options?.method === 'GET') {
          return [{ id: 'repo-ssh', locationKind: 'ssh', hostId: 'ssh-target-1' }]
        }
        if (path === '/v1/source-control?workspaceId=wt-ssh' && options?.method === 'GET') {
          return [{ repositoryId: 'repo-ssh', workspaceId: 'wt-ssh' }]
        }
        if (path.startsWith('/v1/files/stat?') && options?.method === 'GET') {
          return { size: 12, isDirectory: false }
        }
        if (path.startsWith('/v1/files/read?') && options?.method === 'GET') {
          return { content: 'remote relay', size: 12 }
        }
        throw new Error(`unexpected runtime request ${path}`)
      }
    )
    runtimeEnvCallMock.mockRejectedValue(new Error('runtime environment not found'))

    await expect(
      callTauriFileRuntimeRpc('files.read', {
        worktree: 'id:wt-ssh',
        relativePath: 'README.md'
      })
    ).resolves.toEqual({
      handled: true,
      result: {
        worktree: 'wt-ssh',
        relativePath: 'README.md',
        content: 'remote relay',
        truncated: false,
        byteLength: 12
      }
    })
    expect(runtimeEnvCallMock).toHaveBeenCalledTimes(1)
    expect(requestRuntimeJsonMock).toHaveBeenCalledWith(
      expect.stringContaining('/v1/files/read?'),
      { method: 'GET', timeoutMs: 3000 }
    )
  })

  it('uses live Go relay routes for legacy SSH directory and chunk reads', async () => {
    requestRuntimeJsonMock.mockImplementation(
      async (path: string, options?: { method?: string }) => {
        if (path === '/v1/worktrees' && options?.method === 'GET') {
          return [{ id: 'wt-ssh', projectId: 'repo-ssh', path: '/home/me/repo' }]
        }
        if (path === '/v1/projects' && options?.method === 'GET') {
          return [{ id: 'repo-ssh', locationKind: 'ssh', hostId: 'ssh-target-1' }]
        }
        if (path === '/v1/source-control?workspaceId=wt-ssh' && options?.method === 'GET') {
          return [{ repositoryId: 'repo-ssh', workspaceId: 'wt-ssh' }]
        }
        if (path.startsWith('/v1/files/tree?') && options?.method === 'GET') {
          return [{ name: 'main.ts', kind: 'file' }]
        }
        if (path === '/v1/files/read-chunk' && options?.method === 'POST') {
          return { contentBase64: 'AQID', bytesRead: 3, eof: false }
        }
        if (path === '/v1/files/list' && options?.method === 'POST') {
          return {
            files: [{ relativePath: 'src/main.ts' }],
            totalCount: 1,
            truncated: false
          }
        }
        throw new Error(`unexpected runtime request ${path}`)
      }
    )
    runtimeEnvCallMock.mockRejectedValue(new Error('runtime environment not found'))

    await expect(
      callTauriFileRuntimeRpc('files.readDir', {
        worktree: 'id:wt-ssh',
        relativePath: 'src'
      })
    ).resolves.toEqual({
      handled: true,
      result: [{ name: 'main.ts', isDirectory: false, isSymlink: false }]
    })
    await expect(
      callTauriFileRuntimeRpc('files.readChunk', {
        worktree: 'id:wt-ssh',
        relativePath: 'data.bin',
        offset: 1,
        length: 3
      })
    ).resolves.toEqual({
      handled: true,
      result: { contentBase64: 'AQID', bytesRead: 3, eof: false }
    })
    await expect(
      callTauriFileRuntimeRpc('files.listAll', {
        worktree: 'id:wt-ssh',
        excludePaths: ['node_modules']
      })
    ).resolves.toEqual({
      handled: true,
      result: {
        files: [{ relativePath: 'src/main.ts' }],
        totalCount: 1,
        truncated: false
      }
    })
    expect(runtimeEnvCallMock).toHaveBeenCalledTimes(3)
  })

  it('composes legacy SSH image previews from live stat and chunk relay routes', async () => {
    requestRuntimeJsonMock.mockImplementation(
      async (path: string, options?: { method?: string }) => {
        if (path === '/v1/worktrees' && options?.method === 'GET') {
          return [{ id: 'wt-ssh', projectId: 'repo-ssh', path: '/home/me/repo' }]
        }
        if (path === '/v1/projects' && options?.method === 'GET') {
          return [{ id: 'repo-ssh', locationKind: 'ssh', hostId: 'ssh-target-1' }]
        }
        if (path === '/v1/source-control?workspaceId=wt-ssh' && options?.method === 'GET') {
          return [{ repositoryId: 'repo-ssh', workspaceId: 'wt-ssh' }]
        }
        if (path.startsWith('/v1/files/stat?') && options?.method === 'GET') {
          return { size: 4, isDirectory: false, mtime: 1 }
        }
        if (path === '/v1/files/read-chunk' && options?.method === 'POST') {
          return { contentBase64: 'iVBORw==', bytesRead: 4, eof: true }
        }
        throw new Error(`unexpected runtime request ${path}`)
      }
    )
    runtimeEnvCallMock.mockRejectedValue(new Error('runtime environment not found'))

    await expect(
      callTauriFileRuntimeRpc('files.readPreview', {
        worktree: 'id:wt-ssh',
        relativePath: 'image.png'
      })
    ).resolves.toEqual({
      handled: true,
      result: {
        content: 'iVBORw==',
        isBinary: true,
        isImage: true,
        mimeType: 'image/png'
      }
    })
  })

  it('routes legacy SSH mutations through the local Go relay API', async () => {
    requestRuntimeJsonMock.mockImplementation(
      async (path: string, options?: { method?: string }) => {
        if (path === '/v1/worktrees' && options?.method === 'GET') {
          return [{ id: 'wt-ssh', projectId: 'repo-ssh', path: '/home/me/repo' }]
        }
        if (path === '/v1/projects' && options?.method === 'GET') {
          return [{ id: 'repo-ssh', locationKind: 'ssh', hostId: 'ssh-target-1' }]
        }
        if (path === '/v1/source-control?workspaceId=wt-ssh' && options?.method === 'GET') {
          return [{ repositoryId: 'repo-ssh', workspaceId: 'wt-ssh' }]
        }
        if (path === '/v1/files/write' && options?.method === 'POST') {
          return { content: 'remote', size: 6 }
        }
        throw new Error(`unexpected runtime request ${path}`)
      }
    )
    runtimeEnvCallMock.mockRejectedValue(new Error('runtime environment not found'))

    await expect(
      callTauriFileRuntimeRpc('files.write', {
        worktree: 'id:wt-ssh',
        relativePath: 'src/new.ts',
        content: 'remote'
      })
    ).resolves.toEqual({ handled: true, result: { ok: true } })
    expect(requestRuntimeJsonMock).toHaveBeenCalledWith('/v1/files/write', {
      method: 'POST',
      timeoutMs: 5000,
      body: {
        projectId: 'repo-ssh',
        worktreeId: 'wt-ssh',
        path: 'src/new.ts',
        content: 'remote',
        createDirs: true
      }
    })
  })

  it('routes legacy SSH search through the shared Go search implementation', async () => {
    requestRuntimeJsonMock.mockImplementation(
      async (path: string, options?: { method?: string }) => {
        if (path === '/v1/worktrees' && options?.method === 'GET') {
          return [{ id: 'wt-ssh', projectId: 'repo-ssh', path: '/home/me/repo' }]
        }
        if (path === '/v1/projects' && options?.method === 'GET') {
          return [{ id: 'repo-ssh', locationKind: 'ssh', hostId: 'ssh-target-1' }]
        }
        if (path === '/v1/source-control?workspaceId=wt-ssh' && options?.method === 'GET') {
          return [{ repositoryId: 'repo-ssh', workspaceId: 'wt-ssh' }]
        }
        if (path === '/v1/files/search' && options?.method === 'POST') {
          return { files: [], totalMatches: 0, truncated: false }
        }
        throw new Error(`unexpected runtime request ${path}`)
      }
    )
    runtimeEnvCallMock.mockRejectedValue(new Error('runtime environment not found'))

    await expect(
      callTauriFileRuntimeRpc('files.search', {
        worktree: 'id:wt-ssh',
        query: 'needle'
      })
    ).resolves.toEqual({
      handled: true,
      result: { files: [], totalMatches: 0, truncated: false }
    })
  })

  it('grants legacy SSH terminal artifacts only after recent PTY output provenance', async () => {
    requestRuntimeJsonMock.mockImplementation(
      async (path: string, options?: { method?: string }) => {
        if (path === '/v1/worktrees' && options?.method === 'GET') {
          return [{ id: 'wt-ssh', projectId: 'repo-ssh', path: '/home/me/repo' }]
        }
        if (path === '/v1/projects' && options?.method === 'GET') {
          return [{ id: 'repo-ssh', locationKind: 'ssh', hostId: 'ssh-target-1' }]
        }
        if (path === '/v1/sessions' && options?.method === 'GET') {
          return [{ id: 'sess-ssh', worktreeId: 'wt-ssh', cwd: '/home/me/repo' }]
        }
        if (path === '/v1/sessions/sess-ssh/tail?limit=2000' && options?.method === 'GET') {
          return { chunks: [{ content: 'created /tmp/report.md\n' }] }
        }
        if (path === '/v1/files/terminal-artifact/grant' && options?.method === 'POST') {
          return { absolutePath: '/tmp/report.md', isDirectory: false, grantId: 'grant-ssh' }
        }
        if (path === '/v1/files/terminal-artifact/read' && options?.method === 'POST') {
          return {
            worktree: 'wt-ssh',
            relativePath: '/tmp/report.md',
            content: 'report',
            truncated: false,
            byteLength: 6
          }
        }
        if (path === '/v1/files/terminal-artifact/preview' && options?.method === 'POST') {
          return { content: 'aW1hZ2U=', isBinary: true, isImage: true, mimeType: 'image/png' }
        }
        if (path === '/v1/files/terminal-artifact/write' && options?.method === 'POST') {
          return { ok: true }
        }
        throw new Error(`unexpected runtime request ${path}`)
      }
    )
    runtimeEnvCallMock.mockRejectedValue(new Error('runtime environment not found'))

    const resolution = await callTauriFileRuntimeRpc('files.resolveTerminalPath', {
      worktree: 'id:wt-ssh',
      terminal: 'sess-ssh',
      pathText: '/tmp/report.md'
    })
    expect(resolution).toEqual({
      handled: true,
      result: {
        worktree: 'wt-ssh',
        relativePath: null,
        absolutePath: '/tmp/report.md',
        exists: true,
        isDirectory: false,
        openTarget: {
          kind: 'absolute-file',
          provider: 'ssh',
          absolutePath: '/tmp/report.md',
          grantId: 'grant-ssh'
        }
      }
    })
    await expect(
      callTauriFileRuntimeRpc('files.readTerminalArtifact', {
        worktree: 'id:wt-ssh',
        grantId: 'grant-ssh',
        absolutePath: '/tmp/report.md'
      })
    ).resolves.toEqual({
      handled: true,
      result: {
        worktree: 'wt-ssh',
        relativePath: '/tmp/report.md',
        content: 'report',
        truncated: false,
        byteLength: 6
      }
    })
    await expect(
      callTauriFileRuntimeRpc('files.readTerminalArtifactPreview', {
        worktree: 'id:wt-ssh',
        grantId: 'grant-ssh',
        absolutePath: '/tmp/report.md'
      })
    ).resolves.toEqual({
      handled: true,
      result: { content: 'aW1hZ2U=', isBinary: true, isImage: true, mimeType: 'image/png' }
    })
    await expect(
      callTauriFileRuntimeRpc('files.writeTerminalArtifact', {
        worktree: 'id:wt-ssh',
        grantId: 'grant-ssh',
        absolutePath: '/tmp/report.md',
        content: 'updated'
      })
    ).resolves.toEqual({ handled: true, result: { ok: true } })
    expect(requestRuntimeJsonMock).toHaveBeenCalledWith('/v1/files/terminal-artifact/write', {
      method: 'POST',
      timeoutMs: 60_000,
      body: {
        worktreeId: 'wt-ssh',
        grantId: 'grant-ssh',
        absolutePath: '/tmp/report.md',
        content: 'updated'
      }
    })
  })

  it('does not hide paired runtime failures for SSH file methods without a relay route', async () => {
    requestRuntimeJsonMock.mockImplementation(
      async (path: string, options?: { method?: string }) => {
        if (path === '/v1/worktrees' && options?.method === 'GET') {
          return [{ id: 'wt-ssh', projectId: 'repo-ssh', path: '/home/me/repo' }]
        }
        if (path === '/v1/projects' && options?.method === 'GET') {
          return [{ id: 'repo-ssh', locationKind: 'ssh', hostId: 'ssh-target-1' }]
        }
        if (path === '/v1/source-control?workspaceId=wt-ssh' && options?.method === 'GET') {
          return [{ repositoryId: 'repo-ssh', workspaceId: 'wt-ssh' }]
        }
        throw new Error(`unexpected runtime request ${path}`)
      }
    )
    runtimeEnvCallMock.mockRejectedValue(new Error('runtime environment not found'))

    await expect(
      callTauriFileRuntimeRpc('files.listMarkdownDocuments', {
        worktree: 'id:wt-ssh',
        excludePaths: []
      })
    ).rejects.toThrow('runtime environment not found')
  })
})
