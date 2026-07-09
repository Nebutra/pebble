import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { PreloadApi } from '../../../src/preload/api-types'
import type { NestedRepoScanResult } from '../../../src/shared/types'
import { requestRuntimeJson } from './pebble-tauri-runtime-transport'
import { createPebbleProjectGroupsApi } from './tauri-folder-workspace-api'

vi.mock('./pebble-tauri-runtime-transport', () => ({
  requestRuntimeJson: vi.fn()
}))

vi.mock('./pebble-tauri-workspace-runtime-records', () => ({
  mapRuntimeProjectToRepo: vi.fn((project) => project)
}))

const requestRuntimeJsonMock = vi.mocked(requestRuntimeJson)

const nestedScan: NestedRepoScanResult = {
  selectedPath: '/platform',
  selectedPathKind: 'non_git_folder',
  repos: [{ path: '/platform/api', displayName: 'api', depth: 1 }],
  truncated: false,
  timedOut: false,
  stopped: false,
  durationMs: 12,
  maxDepth: 3,
  maxRepos: 100,
  timeoutMs: null
}

describe('createPebbleProjectGroupsApi', () => {
  beforeEach(() => {
    requestRuntimeJsonMock.mockReset()
  })

  it('emits final nested scan progress and uses a bounded scan timeout', async () => {
    requestRuntimeJsonMock.mockResolvedValue(nestedScan)
    const api = createPebbleProjectGroupsApi({} as PreloadApi['projectGroups'])
    const progress = vi.fn()
    const unsubscribe = api.onNestedScanProgress(progress)

    await expect(api.scanNested({ path: '/platform', scanId: 'scan-1' })).resolves.toEqual(
      nestedScan
    )
    unsubscribe()

    expect(progress).toHaveBeenCalledTimes(1)
    expect(progress).toHaveBeenCalledWith({ scanId: 'scan-1', scan: nestedScan })
    expect(requestRuntimeJsonMock).toHaveBeenCalledWith('/v1/project-groups/scan-nested', {
      method: 'POST',
      body: { path: '/platform', options: undefined },
      timeoutMs: 20_000
    })
  })

  it('marks an active nested scan stopped when canceled before the runtime returns', async () => {
    let resolveScan: (scan: NestedRepoScanResult) => void = () => {}
    requestRuntimeJsonMock.mockReturnValue(
      new Promise<NestedRepoScanResult>((resolve) => {
        resolveScan = resolve
      })
    )
    const api = createPebbleProjectGroupsApi({} as PreloadApi['projectGroups'])
    const scanPromise = api.scanNested({ path: '/platform', scanId: 'scan-2' })

    await expect(api.cancelNestedScan({ scanId: 'scan-2' })).resolves.toBe(true)
    resolveScan(nestedScan)

    await expect(scanPromise).resolves.toEqual({
      ...nestedScan,
      repos: [],
      stopped: true
    })
    await expect(api.cancelNestedScan({ scanId: 'scan-2' })).resolves.toBe(false)
  })

  it('uses a longer bounded timeout for nested repo import', async () => {
    requestRuntimeJsonMock.mockResolvedValue({ groups: [], projects: [] })
    const api = createPebbleProjectGroupsApi({} as PreloadApi['projectGroups'])

    await api.importNested({
      parentPath: '/platform',
      groupName: 'Platform',
      projectPaths: ['/platform/api'],
      mode: 'group'
    })

    expect(requestRuntimeJsonMock).toHaveBeenCalledWith('/v1/project-groups/import-nested', {
      method: 'POST',
      body: {
        parentPath: '/platform',
        groupName: 'Platform',
        projectPaths: ['/platform/api'],
        mode: 'group'
      },
      timeoutMs: 30_000
    })
  })
})
