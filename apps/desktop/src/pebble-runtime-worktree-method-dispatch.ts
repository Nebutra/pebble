import type { RuntimeRpcResponse } from '../../../packages/product-core/shared/runtime-rpc-envelope'
import { okRuntimeRpc } from './pebble-runtime-rpc-response'
import {
  createRuntimeWorktreeResult,
  getRuntimeRepoId,
  persistRuntimeWorktreeSortOrder,
  readRuntimeWorktreeLineage,
  readWorktrees,
  removeRuntimeWorktree,
  setRuntimeWorktreeMeta,
  toCreateWorktreeArgs
} from './pebble-tauri-workspace-runtime-api'
import { requireRepoId, toConnectionParams, toOrderedIds } from './pebble-runtime-repo-method-args'
import {
  activateTauriWorktree,
  toForceDeleteBranchArgs,
  toWorktreePrefetchArgs,
  toWorktreeResolveMrArgs,
  toWorktreeResolvePrArgs
} from './pebble-runtime-worktree-method-args'

export async function dispatchWorktreeRuntimeMethod(
  method: string,
  params?: unknown
): Promise<RuntimeRpcResponse<unknown> | null> {
  switch (method) {
    case 'worktree.list':
      return okRuntimeRpc({
        worktrees: await readWorktrees(getRuntimeRepoId(params))
      })
    case 'worktree.activate':
      return okRuntimeRpc(await activateTauriWorktree(params))
    case 'worktree.detectedList':
      return okRuntimeRpc(
        await window.api.worktrees.listDetected({
          repoId: requireRepoId(params)
        })
      )
    case 'worktree.lineageList':
      return okRuntimeRpc(await readRuntimeWorktreeLineage())
    case 'worktree.create':
      return okRuntimeRpc(await createRuntimeWorktreeResult(toCreateWorktreeArgs(params)))
    case 'worktree.prefetchCreateBase':
      await window.api.worktrees.prefetchCreateBase(toWorktreePrefetchArgs(params))
      return okRuntimeRpc(null)
    case 'worktree.resolvePrBase':
      return okRuntimeRpc(await window.api.worktrees.resolvePrBase(toWorktreeResolvePrArgs(params)))
    case 'worktree.resolveMrBase':
      return okRuntimeRpc(await window.api.worktrees.resolveMrBase(toWorktreeResolveMrArgs(params)))
    case 'worktree.set':
      return okRuntimeRpc({ worktree: await setRuntimeWorktreeMeta(params) })
    case 'worktree.persistSortOrder':
      await persistRuntimeWorktreeSortOrder(toOrderedIds(params))
      return okRuntimeRpc({ status: 'applied' })
    case 'worktree.rm':
    case 'worktree.remove':
      return okRuntimeRpc({
        preservedBranch: await removeRuntimeWorktree(params)
      })
    case 'worktree.forceDeleteBranch':
      return okRuntimeRpc(
        await window.api.worktrees.forceDeletePreservedBranch(toForceDeleteBranchArgs(params))
      )
    case 'preflight.check':
      return okRuntimeRpc(await window.api.preflight.check())
    case 'preflight.detectAgents':
      return okRuntimeRpc(await window.api.preflight.detectAgents())
    case 'preflight.refreshAgents':
      return okRuntimeRpc(await window.api.preflight.refreshAgents())
    case 'preflight.detectRemoteAgents':
      return okRuntimeRpc(await window.api.preflight.detectRemoteAgents(toConnectionParams(params)))
    case 'preflight.detectRemoteWindowsTerminalCapabilities':
      return okRuntimeRpc(
        await window.api.preflight.detectRemoteWindowsTerminalCapabilities(
          toConnectionParams(params)
        )
      )
    default:
      return null
  }
}
