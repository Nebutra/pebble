import { invoke } from '@tauri-apps/api/core'
import type { Worktree } from '../../../packages/product-core/shared/types'
import {
  normalizeRuntimeWorktreeId,
  readObject,
  readRequiredString,
  readString
} from './tauri-browser-rpc-values'

export async function saveBrowserCapture(params: unknown): Promise<{ path: string }> {
  const input = readObject(params)
  const capture = readObject(input.capture)
  const path = readRequiredString(input.path, 'browser capture path')
  const dataBase64 = readRequiredString(capture.data, 'browser capture data')
  const kind = readString(capture.format) ?? (path.toLowerCase().endsWith('.pdf') ? 'pdf' : 'png')
  return saveCaptureBytes(path, dataBase64, kind, readString(input.worktree))
}

export async function readBrowserCapture(
  params: unknown
): Promise<{ path: string; dataBase64: string }> {
  const input = readObject(params)
  const path = readRequiredString(input.path, 'browser capture path')
  const kind = readRequiredString(input.kind, 'browser capture kind')
  const baseDir = await resolveCaptureBaseDirectory(readString(input.worktree))
  return invoke('browser_capture_read', { input: { path, baseDir, kind } })
}

export async function saveBrowserHar(params: unknown): Promise<{ path: string }> {
  const input = readObject(params)
  const path = readRequiredString(input.path, 'browser HAR path')
  const bytes = new TextEncoder().encode(JSON.stringify(readObject(input.har), null, 2))
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return saveCaptureBytes(path, btoa(binary), 'har', readString(input.worktree))
}

async function saveCaptureBytes(
  path: string,
  dataBase64: string,
  kind: string,
  worktree: string | null
): Promise<{ path: string }> {
  const baseDir = await resolveCaptureBaseDirectory(worktree)
  const savedPath = await invoke<string>('browser_capture_save', {
    input: { path, baseDir, dataBase64, kind }
  })
  return { path: savedPath }
}

async function resolveCaptureBaseDirectory(worktree: string | null): Promise<string | undefined> {
  const worktreeId = normalizeRuntimeWorktreeId(worktree)
  if (!worktreeId) {
    return undefined
  }
  const worktrees = (await window.api.worktrees.listAll()) as (Worktree & { path: string })[]
  return worktrees.find((candidate) => candidate.id === worktreeId)?.path
}
