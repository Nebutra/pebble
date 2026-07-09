import { invoke } from '@tauri-apps/api/core'
import type { PreloadApi, ShellOpenLocalPathResult } from '../../../src/preload/api-types'

type RepoIconImageResult = {
  dataUrl: string
  fileName: string
}

const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico']
const AUDIO_EXTENSIONS = ['ogg', 'mp3', 'wav', 'm4a', 'aac', 'flac']

export function installTauriShellApi(): void {
  if (!hasTauriInternals()) {
    return
  }

  const base = window.api.shell
  window.api.shell = {
    ...base,
    openPath: async (path) => {
      await invoke<ShellOpenLocalPathResult>('shell_open_in_file_manager', { path })
    },
    openInFileManager: (path) =>
      invoke<ShellOpenLocalPathResult>('shell_open_in_file_manager', { path }),
    openInExternalEditor: (path, command) =>
      invoke<ShellOpenLocalPathResult>('shell_open_in_external_editor', {
        path,
        command: command ?? null
      }),
    openUrl: (url) => invoke<void>('shell_open_url', { url }),
    openFilePath: (path) => invoke<boolean>('shell_open_file_path', { path }),
    openFileUri: (uri) => invoke<void>('shell_open_file_uri', { uri }),
    pathExists: (path) => invoke<boolean>('shell_path_exists', { path }),
    pickAttachment: () => pickFile('All Files', []),
    pickImage: () => pickFile('Images', IMAGE_EXTENSIONS),
    pickRepoIconImage: () => invoke<RepoIconImageResult | null>('shell_pick_repo_icon_image'),
    pickAudio: () => pickFile('Audio', AUDIO_EXTENSIONS),
    pickDirectory: (args) =>
      invoke<string | null>('shell_pick_directory', { defaultPath: args.defaultPath ?? null }),
    copyFile: (args) =>
      invoke<void>('shell_copy_file', {
        srcPath: args.srcPath,
        destPath: args.destPath
      })
  } satisfies PreloadApi['shell']
}

function pickFile(filterName: string, extensions: string[]): Promise<string | null> {
  return invoke<string | null>('shell_pick_file', { filterName, extensions })
}

function hasTauriInternals(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}
