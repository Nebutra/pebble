import { requestRuntimeJson } from './pebble-tauri-runtime-transport'
import { readRepos, readWorktrees } from './pebble-tauri-workspace-runtime-api'

type HugeFolderSelector = {
  projectId: string
  worktreeId?: string
}

export async function findTauriHugeFoldersToIgnore(worktreePath: string): Promise<string[]> {
  return requestRuntimeJson('/v1/source-control/huge-folders', {
    method: 'POST',
    timeoutMs: 5_000,
    body: await resolveHugeFolderSelector(worktreePath)
  })
}

export async function appendTauriHugeFolderToGitignore(
  worktreePath: string,
  folderName: string
): Promise<boolean> {
  return requestRuntimeJson('/v1/source-control/append-gitignore', {
    method: 'POST',
    timeoutMs: 5_000,
    body: { ...(await resolveHugeFolderSelector(worktreePath)), folderName }
  })
}

async function resolveHugeFolderSelector(worktreePath: string): Promise<HugeFolderSelector> {
  const normalized = worktreePath.trim()
  const worktree = (await readWorktrees()).find((entry) => entry.path === normalized)
  if (worktree) {
    return { projectId: worktree.repoId, worktreeId: worktree.id }
  }
  const project = (await readRepos()).find((entry) => entry.path === normalized)
  if (project) {
    return { projectId: project.id }
  }
  throw new Error(`Source-control workspace is not registered: ${worktreePath}`)
}
