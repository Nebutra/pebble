import { invoke } from '@tauri-apps/api/core'

export async function pickNativeDirectory(): Promise<string | null> {
  if (!hasTauriInternals()) {
    return null
  }
  return invoke<string | null>('pick_directory')
}

export async function pickNativeDirectories(): Promise<string[]> {
  if (!hasTauriInternals()) {
    return []
  }
  return invoke<string[]>('pick_directories')
}

function hasTauriInternals(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}
