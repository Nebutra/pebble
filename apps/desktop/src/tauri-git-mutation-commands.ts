import { requestRuntimeJson } from './pebble-tauri-runtime-transport'
import { readObject, readString, readStringList, readRequiredString } from './tauri-git-rpc-value-readers'
import { readSourceControlProjection } from './tauri-git-source-control-projection'

export async function mutateGit(operation: string, params: unknown): Promise<unknown> {
  const input = readObject(params)
  const pushTarget = readObject(input.pushTarget)
  const projection = await readSourceControlProjection(params)
  return requestRuntimeJson('/v1/source-control/mutate', {
    method: 'POST',
    timeoutMs: operation === 'commit' ? 30_000 : 10_000,
    body: {
      projectId: projection.repositoryId,
      ...(projection.workspaceId !== projection.repositoryId
        ? { worktreeId: projection.workspaceId }
        : {}),
      operation,
      filePath: readString(input.filePath) ?? '',
      filePaths: readStringList(input.filePaths),
      message: readString(input.message) ?? '',
      remoteName: readString(pushTarget.remoteName) ?? '',
      branchName: readString(pushTarget.branchName) ?? '',
      publish: input.publish === true,
      forceWithLease: input.forceWithLease === true,
      baseRef: readString(input.baseRef) ?? ''
    }
  })
}

export async function checkoutBranch(params: unknown): Promise<unknown> {
  const input = readObject(params)
  const branch = readRequiredString(input.branch, 'checkout branch')
  if (branch.startsWith('-')) {
    throw new Error('invalid_branch_name')
  }
  const projection = await readSourceControlProjection(params)
  return requestRuntimeJson('/v1/source-control/checkout', {
    method: 'POST',
    timeoutMs: 10_000,
    body: {
      projectId: projection.repositoryId,
      ...(projection.workspaceId !== projection.repositoryId
        ? { worktreeId: projection.workspaceId }
        : {}),
      branch
    }
  })
}

export async function readLocalBranches(params: unknown): Promise<unknown> {
  const projection = await readSourceControlProjection(params)
  return requestRuntimeJson('/v1/source-control/local-branches', {
    method: 'POST',
    timeoutMs: 5000,
    body: {
      projectId: projection.repositoryId,
      ...(projection.workspaceId !== projection.repositoryId
        ? { worktreeId: projection.workspaceId }
        : {})
    }
  })
}

export async function syncFork(params: unknown): Promise<unknown> {
  const input = readObject(params)
  const expectedUpstream = readObject(input.expectedUpstream)
  const projection = await readSourceControlProjection(params)
  return requestRuntimeJson('/v1/source-control/fork-sync', {
    method: 'POST',
    timeoutMs: 60_000,
    body: {
      projectId: projection.repositoryId,
      ...(projection.workspaceId !== projection.repositoryId
        ? { worktreeId: projection.workspaceId }
        : {}),
      expectedUpstream: {
        owner: readRequiredString(expectedUpstream.owner, 'expected upstream owner'),
        repo: readRequiredString(expectedUpstream.repo, 'expected upstream repo')
      }
    }
  })
}
