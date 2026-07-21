import { invoke } from '@tauri-apps/api/core'
import type { PreloadApi } from '../../../packages/product-core/shared/preload-api-types'
import type {
  LinearCollectionResult,
  LinearWorkspaceSelection
} from '../../../packages/product-core/shared/types'

// Workspace resolution and GraphQL request plumbing shared by every Linear API
// method; split out of tauri-linear-api.ts to keep that module focused on the
// preload surface.
export type LinearStatus = Awaited<ReturnType<PreloadApi['linear']['status']>>

export async function status(): Promise<LinearStatus> {
  return invoke('linear_status')
}

export function limit(value: number | undefined, fallback = 20): number {
  return Math.min(50, Math.max(1, Number.isFinite(value) ? Number(value) : fallback))
}

export async function workspaceIds(selection?: LinearWorkspaceSelection): Promise<string[]> {
  const connection = await status()
  const selected = selection ?? connection.selectedWorkspaceId ?? connection.activeWorkspaceId
  if (selected === 'all') {
    return (connection.workspaces ?? []).map((workspace) => workspace.id)
  }
  return selected ? [selected] : []
}

export async function request(
  workspaceId: string,
  query: string,
  variables?: unknown
): Promise<Record<string, unknown>> {
  return invoke('linear_request', { input: { workspaceId, query, variables } })
}

export async function collect<T>(
  selection: LinearWorkspaceSelection | undefined,
  run: (workspaceId: string) => Promise<T[]>
): Promise<LinearCollectionResult<T>> {
  const connection = await status()
  const ids = await workspaceIds(selection)
  const workspaces = new Map(
    (connection.workspaces ?? []).map((workspace) => [workspace.id, workspace])
  )
  const results = await Promise.all(
    ids.map(async (workspaceId) => {
      try {
        return { values: await run(workspaceId), error: undefined }
      } catch (error) {
        return {
          values: [],
          error: {
            workspaceId,
            workspaceName: workspaces.get(workspaceId)?.organizationName ?? workspaceId,
            type:
              error instanceof Error && /credential|auth|401|403/i.test(error.message)
                ? ('auth' as const)
                : ('unknown' as const),
            message: error instanceof Error ? error.message : String(error)
          }
        }
      }
    })
  )
  return {
    items: results.flatMap((result) => result.values),
    errors: results.flatMap((result) => (result.error ? [result.error] : []))
  }
}

export async function oneWorkspace(workspaceId?: string): Promise<string> {
  const ids = await workspaceIds(workspaceId)
  if (!ids[0]) {
    throw new Error('Not connected to Linear.')
  }
  return ids[0]
}

export function issueFilter(filter?: 'assigned' | 'created' | 'all' | 'completed') {
  return filter === 'completed' ? { completedAt: { null: false } } : { completedAt: { null: true } }
}
