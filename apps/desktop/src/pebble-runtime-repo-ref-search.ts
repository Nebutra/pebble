import { requireRepoId } from './pebble-runtime-repo-method-args'
import {
  readRuntimeNumber,
  readRuntimeObject,
  readRuntimeString
} from './pebble-runtime-param-coercion'

export async function searchRuntimeRepoRefs(params: unknown): Promise<{
  refs: string[]
  refDetails: { refName: string; localBranchName: string }[]
  truncated: boolean
}> {
  const input = readRuntimeObject(params)
  const repoId = requireRepoId(params)
  const query = readRuntimeString(input.query) ?? ''
  const limit = readRuntimeNumber(input.limit)
  const [refs, refDetails] = await Promise.all([
    window.api.repos.searchBaseRefs({ repoId, query, limit }),
    window.api.repos.searchBaseRefDetails({ repoId, query, limit })
  ])
  return { refs, refDetails, truncated: false }
}
