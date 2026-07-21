import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PreloadApi } from '../../../packages/product-core/shared/preload-api-types'

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

import { createTauriExternalFileImportApi } from './tauri-external-file-import-api'

function baseApi(): PreloadApi['fs'] {
  return { importExternalPaths: vi.fn() } as unknown as PreloadApi['fs']
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('navigator', { userAgent: 'Macintosh' })
})

describe('createTauriExternalFileImportApi', () => {
  it('imports local paths and stages paired-runtime uploads through Rust', async () => {
    invokeMock
      .mockResolvedValueOnce({ results: [{ sourcePath: '/tmp/a', status: 'imported' }] })
      .mockResolvedValueOnce({ sources: [{ sourcePath: '/tmp/a', status: 'staged' }] })
    const api = createTauriExternalFileImportApi(baseApi())

    await api.importExternalPaths({ sourcePaths: ['/tmp/a'], destDir: '/repo/assets' })
    await api.stageExternalPathsForRuntimeUpload({ sourcePaths: ['/tmp/a'] })

    expect(invokeMock).toHaveBeenNthCalledWith(1, 'fs_import_external_paths', {
      input: { sourcePaths: ['/tmp/a'], destDir: '/repo/assets' }
    })
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'fs_stage_external_paths', {
      input: { sourcePaths: ['/tmp/a'] }
    })
  })

  it('keeps local terminal drops zero-copy', async () => {
    const api = createTauriExternalFileImportApi(baseApi())
    await expect(
      api.resolveDroppedPathsForAgent({ paths: ['/tmp/a'], worktreePath: '/repo' })
    ).resolves.toEqual({ resolvedPaths: ['/tmp/a'], skipped: [], failed: [] })
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('routes streamed downloads through native file sessions', async () => {
    invokeMock
      .mockResolvedValueOnce({
        canceled: false,
        transferId: 'transfer-1',
        destinationPath: '/tmp/a'
      })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ canceled: false, destinationPath: '/tmp/a' })
      .mockResolvedValueOnce({ ok: true })
    const api = createTauriExternalFileImportApi(baseApi())

    await expect(api.startDownloadedFile({ suggestedName: 'a.txt' })).resolves.toMatchObject({
      transferId: 'transfer-1'
    })
    await api.appendDownloadedFileChunk({ transferId: 'transfer-1', contentBase64: 'YQ==' })
    await api.finishDownloadedFile({ transferId: 'transfer-1' })
    await api.cancelDownloadedFile({ transferId: 'transfer-1' })

    expect(invokeMock.mock.calls.map(([command]) => command)).toEqual([
      'fs_start_downloaded_file',
      'fs_append_downloaded_file_chunk',
      'fs_finish_downloaded_file',
      'fs_cancel_downloaded_file'
    ])
  })

  it('maps Windows paths into a target WSL distro', async () => {
    vi.stubGlobal('navigator', { userAgent: 'Windows' })
    const api = createTauriExternalFileImportApi(baseApi())
    await expect(
      api.resolveDroppedPathsForAgent({
        paths: ['C:\\Users\\me\\note.txt', '\\\\wsl.localhost\\Ubuntu\\home\\me\\a.txt'],
        worktreePath: '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo'
      })
    ).resolves.toEqual({
      resolvedPaths: ['/mnt/c/Users/me/note.txt', '/home/me/a.txt'],
      skipped: [],
      failed: []
    })
  })
})
