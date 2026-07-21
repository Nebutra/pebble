import { invoke } from '@tauri-apps/api/core'
import type { PreloadApi } from '../../../packages/product-core/shared/preload-api-types'
import { parseWslUncPath } from '../../../packages/product-core/shared/wsl-paths'

type ImportResult = Awaited<ReturnType<PreloadApi['fs']['importExternalPaths']>>
type StageResult = Awaited<ReturnType<PreloadApi['fs']['stageExternalPathsForRuntimeUpload']>>
type SaveResult = Awaited<ReturnType<PreloadApi['fs']['saveDownloadedFile']>>
type StartResult = Awaited<ReturnType<PreloadApi['fs']['startDownloadedFile']>>
type FinishResult = Awaited<ReturnType<PreloadApi['fs']['finishDownloadedFile']>>

export function createTauriExternalFileImportApi(base: PreloadApi['fs']): PreloadApi['fs'] {
  const importExternalPaths: PreloadApi['fs']['importExternalPaths'] = async (args) => {
    if (args.connectionId) {
      throw new Error('Legacy SSH file import requires the Pebble relay upload adapter.')
    }
    return invoke<ImportResult>('fs_import_external_paths', { input: args })
  }
  return {
    ...base,
    saveDownloadedFile: (input) => invoke<SaveResult>('fs_save_downloaded_file', { input }),
    startDownloadedFile: (input) => invoke<StartResult>('fs_start_downloaded_file', { input }),
    appendDownloadedFileChunk: (input) =>
      invoke<{ ok: true }>('fs_append_downloaded_file_chunk', { input }),
    finishDownloadedFile: (input) => invoke<FinishResult>('fs_finish_downloaded_file', { input }),
    cancelDownloadedFile: (input) => invoke<{ ok: true }>('fs_cancel_downloaded_file', { input }),
    authorizeExternalPath: async () => {
      // Why: path reads stay inside bounded Rust commands; Tauri has no Node
      // fs sandbox that needs Electron's in-memory authorization grant.
    },
    importExternalPaths,
    stageExternalPathsForRuntimeUpload: (args) =>
      invoke<StageResult>('fs_stage_external_paths', { input: args }),
    resolveDroppedPathsForAgent: async (args) => {
      if (args.connectionId) {
        const worktreePath = args.worktreePath.replace(/[\\/]+$/, '')
        const imported = await importExternalPaths({
          sourcePaths: args.paths,
          destDir: `${worktreePath}/.pebble/drops`,
          connectionId: args.connectionId,
          ensureDir: true
        })
        return toDroppedPathResult(imported)
      }
      return {
        resolvedPaths: resolveLocalDroppedPaths(args.paths, args.worktreePath),
        skipped: [],
        failed: []
      }
    }
  }
}

function toDroppedPathResult(
  imported: ImportResult
): Awaited<ReturnType<PreloadApi['fs']['resolveDroppedPathsForAgent']>> {
  const resolvedPaths: string[] = []
  const skipped: {
    sourcePath: string
    reason: 'missing' | 'symlink' | 'permission-denied' | 'unsupported'
  }[] = []
  const failed: { sourcePath: string; reason: string }[] = []
  for (const result of imported.results) {
    if (result.status === 'imported') {
      resolvedPaths.push(result.destPath)
    } else if (result.status === 'skipped') {
      skipped.push(result)
    } else {
      failed.push(result)
    }
  }
  return { resolvedPaths, skipped, failed }
}

function resolveLocalDroppedPaths(paths: string[], worktreePath: string): string[] {
  if (!navigator.userAgent.includes('Windows')) {
    return paths
  }
  const target = parseWslUncPath(worktreePath)
  if (!target) {
    return paths
  }
  return paths.map((path) => {
    const droppedWsl = parseWslUncPath(path)
    if (droppedWsl) {
      return droppedWsl.distro.localeCompare(target.distro, undefined, {
        sensitivity: 'accent'
      }) === 0
        ? droppedWsl.linuxPath
        : path
    }
    const drive = path.match(/^([A-Za-z]):[/\\](.*)$/)
    return drive ? `/mnt/${drive[1].toLowerCase()}/${drive[2].replace(/\\/g, '/')}` : path
  })
}
