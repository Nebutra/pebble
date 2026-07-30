import type { RuntimeRpcResponse } from '../../../packages/product-core/shared/runtime-rpc-envelope'
import { PRODUCT_NAME } from './product-brand'
import { failRuntimeRpc, okRuntimeRpc } from './pebble-runtime-rpc-response'
import { readOrCreateRuntimeStatus } from './pebble-runtime-status-snapshot'
import { persistRuntimeProjectSortOrder, readRepos } from './pebble-tauri-workspace-runtime-api'
import {
  callTauriFolderWorkspaceRuntimeRpc,
  callTauriProjectGroupRuntimeRpc
} from './tauri-folder-workspace-api'
import {
  requireRepoId,
  toOrderedIds,
  toRepoAddArgs,
  toRepoCloneArgs,
  toRepoCreateArgs,
  toRepoUpdateArgs
} from './pebble-runtime-repo-method-args'
import { searchRuntimeRepoRefs } from './pebble-runtime-repo-ref-search'
import {
  inspectRuntimeRepoSetupScriptImports,
  readRuntimeRepoHooksCheck,
  readRuntimeRepoIssueCommand,
  writeRuntimeRepoIssueCommand
} from './pebble-runtime-repo-config-methods'

export async function dispatchProjectRuntimeMethod(
  method: string,
  params?: unknown
): Promise<RuntimeRpcResponse<unknown> | null> {
  switch (method) {
    case 'status.get':
      return okRuntimeRpc(await readOrCreateRuntimeStatus())
    case 'repo.list':
      return okRuntimeRpc({ repos: await readRepos() })
    case 'repo.add':
      return okRuntimeRpc(await window.api.repos.add(toRepoAddArgs(params)))
    case 'repo.create':
      return okRuntimeRpc(await window.api.repos.create(toRepoCreateArgs(params)))
    case 'repo.clone':
      return okRuntimeRpc({
        repo: await window.api.repos.clone(toRepoCloneArgs(params))
      })
    case 'repo.gitAvailable':
      return okRuntimeRpc({
        available: await window.api.repos.isGitAvailable()
      })
    case 'repo.update':
      return okRuntimeRpc({
        repo: await window.api.repos.update(toRepoUpdateArgs(params))
      })
    case 'repo.rm':
      await window.api.repos.remove({ repoId: requireRepoId(params) })
      return okRuntimeRpc({ removed: true })
    case 'repo.reorder':
      return okRuntimeRpc(await persistRuntimeProjectSortOrder(toOrderedIds(params)))
    case 'repo.baseRefDefault':
      return okRuntimeRpc(
        await window.api.repos.getBaseRefDefault({
          repoId: requireRepoId(params)
        })
      )
    case 'repo.searchRefs':
      return okRuntimeRpc(await searchRuntimeRepoRefs(params))
    case 'repo.hooksCheck':
      return okRuntimeRpc(await readRuntimeRepoHooksCheck(params))
    case 'repo.setupScriptImports':
      return okRuntimeRpc(await inspectRuntimeRepoSetupScriptImports(params))
    case 'repo.issueCommandRead':
      return okRuntimeRpc(await readRuntimeRepoIssueCommand(params))
    case 'repo.issueCommandWrite':
      return okRuntimeRpc(await writeRuntimeRepoIssueCommand(params))
    case 'projectGroup.list':
    case 'projectGroup.create':
    case 'projectGroup.update':
    case 'projectGroup.delete':
    case 'projectGroup.moveProject': {
      const projectGroupResult = await callTauriProjectGroupRuntimeRpc(method, params)
      if (projectGroupResult.handled) {
        return okRuntimeRpc(projectGroupResult.result)
      }
      return failRuntimeRpc(
        'method_not_available',
        `${PRODUCT_NAME} runtime method is not mapped: ${method}`
      )
    }
    case 'projectGroup.scanNested':
    case 'projectGroup.importNested': {
      const projectGroupResult = await callTauriProjectGroupRuntimeRpc(method, params)
      if (projectGroupResult.handled) {
        return okRuntimeRpc(projectGroupResult.result)
      }
      return failRuntimeRpc(
        'method_not_available',
        `${PRODUCT_NAME} runtime method is not mapped: ${method}`
      )
    }
    case 'folderWorkspace.list':
    case 'folderWorkspace.create':
    case 'folderWorkspace.update':
    case 'folderWorkspace.delete':
    case 'folderWorkspace.getPathStatus': {
      const folderWorkspaceResult = await callTauriFolderWorkspaceRuntimeRpc(method, params)
      if (folderWorkspaceResult.handled) {
        return okRuntimeRpc(folderWorkspaceResult.result)
      }
      return failRuntimeRpc(
        'method_not_available',
        `${PRODUCT_NAME} runtime method is not mapped: ${method}`
      )
    }
    default:
      return null
  }
}
