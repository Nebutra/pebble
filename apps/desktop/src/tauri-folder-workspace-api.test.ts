import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { PreloadApi } from '../../../packages/product-core/shared/preload-api-types'
import type {
  FolderWorkspace,
  NestedRepoScanResult
} from '../../../packages/product-core/shared/types'
import { requestRuntimeJson } from './pebble-tauri-runtime-transport'
import {
  callTauriFolderWorkspaceRuntimeRpc,
  createPebbleFolderWorkspacesApi,
  createPebbleProjectGroupsApi
} from './tauri-folder-workspace-api'

vi.mock('./pebble-tauri-runtime-transport', () => ({
  requestRuntimeJson: vi.fn()
}))

vi.mock('./pebble-tauri-workspace-runtime-records', () => ({
  mapRuntimeProjectToRepo: vi.fn((project) => project)
}))

vi.mock('./tauri-runtime-event-push', () => ({
  subscribeRuntimeEventPush: vi.fn(async () => ({
    pushActive: false,
    supported: false,
    unsubscribe: () => {}
  }))
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

const folderWorkspace: FolderWorkspace = {
  id: 'fw-1',
  projectGroupId: 'group-1',
  name: 'Platform',
  folderPath: '/platform',
  createdAt: 1,
  updatedAt: 2,
  sortOrder: 3,
  isArchived: false,
  isUnread: false,
  isPinned: false,
  linkedTask: null,
  comment: '',
  workspaceStatus: '',
  createdWithAgent: undefined,
  pendingFirstAgentMessageRename: false,
  firstAgentMessageRenameError: null,
  lastActivityAt: 4
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
      // scanId flows to the runtime so it can stream scan-progress events.
      body: { path: '/platform', scanId: 'scan-1', options: undefined },
      timeoutMs: 20_000
    })
  })

  it('marks an active nested scan stopped when canceled before the runtime returns', async () => {
    let resolveScan: (scan: NestedRepoScanResult) => void = () => {}
    requestRuntimeJsonMock.mockImplementation((path: string) => {
      if (path === '/v1/project-groups/scan-nested/cancel') {
        return Promise.resolve({ canceled: true })
      }
      return new Promise<NestedRepoScanResult>((resolve) => {
        resolveScan = resolve
      })
    })
    const api = createPebbleProjectGroupsApi({} as PreloadApi['projectGroups'])
    const scanPromise = api.scanNested({ path: '/platform', scanId: 'scan-2' })

    await expect(api.cancelNestedScan({ scanId: 'scan-2' })).resolves.toBe(true)
    expect(requestRuntimeJsonMock).toHaveBeenCalledWith('/v1/project-groups/scan-nested/cancel', {
      method: 'POST',
      body: { scanId: 'scan-2' },
      timeoutMs: 5000
    })
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

  it('falls back to the relay-posted scan cache for relay-only connections', async () => {
    const call = vi.fn().mockResolvedValue({
      ok: false,
      error: { code: 'not_found', message: 'no runtime environment for selector' }
    })
    vi.stubGlobal('window', { api: { runtimeEnvironments: { call } } })
    requestRuntimeJsonMock.mockResolvedValue({ scan: nestedScan })
    const api = createPebbleProjectGroupsApi({} as PreloadApi['projectGroups'])

    await expect(
      api.scanNested({ path: '/srv/platform', connectionId: 'host-1' })
    ).resolves.toEqual(nestedScan)

    expect(call).toHaveBeenCalledTimes(1)
    expect(requestRuntimeJsonMock).toHaveBeenCalledWith(
      '/v1/project-groups/remote-nested-scans?hostId=host-1&path=%2Fsrv%2Fplatform',
      { method: 'GET', timeoutMs: 5000 }
    )
    vi.unstubAllGlobals()
  })

  it('surfaces a typed gap when neither runtime environment nor relay scan exists', async () => {
    const call = vi.fn().mockResolvedValue({
      ok: false,
      error: { code: 'not_found', message: 'no runtime environment for selector' }
    })
    vi.stubGlobal('window', { api: { runtimeEnvironments: { call } } })
    requestRuntimeJsonMock.mockRejectedValue(new Error('404'))
    const api = createPebbleProjectGroupsApi({} as PreloadApi['projectGroups'])

    await expect(api.scanNested({ path: '/srv/platform', connectionId: 'host-1' })).rejects.toThrow(
      /relay_nested_scan_unavailable/
    )
    vi.unstubAllGlobals()
  })

  it('preserves paired-runtime transport failures instead of reading relay cache', async () => {
    const call = vi.fn().mockRejectedValue(new Error('rpc transport down'))
    vi.stubGlobal('window', { api: { runtimeEnvironments: { call } } })
    const api = createPebbleProjectGroupsApi({} as PreloadApi['projectGroups'])

    await expect(api.scanNested({ path: '/srv/platform', connectionId: 'host-1' })).rejects.toThrow(
      'rpc transport down'
    )
    expect(requestRuntimeJsonMock).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('imports relay-only nested repos through the remote import route', async () => {
    const call = vi.fn().mockResolvedValue({
      ok: false,
      error: { code: 'not_found', message: 'no runtime environment for selector' }
    })
    vi.stubGlobal('window', { api: { runtimeEnvironments: { call } } })
    requestRuntimeJsonMock.mockResolvedValue({ projects: [], importedCount: 0 })
    const api = createPebbleProjectGroupsApi({} as PreloadApi['projectGroups'])

    await api.importNested({
      parentPath: '/srv/platform',
      groupName: 'Platform',
      projectPaths: ['/srv/platform/api'],
      scanId: 'scan-remote-1',
      mode: 'group',
      connectionId: 'host-1'
    })

    expect(requestRuntimeJsonMock).toHaveBeenCalledWith('/v1/project-groups/import-remote-nested', {
      method: 'POST',
      body: {
        parentPath: '/srv/platform',
        groupName: 'Platform',
        projectPaths: ['/srv/platform/api'],
        scanId: 'scan-remote-1',
        mode: 'group',
        hostId: 'host-1'
      },
      timeoutMs: 30_000
    })
    vi.unstubAllGlobals()
  })

  it('correlates paired-runtime imports with the completed scan id', async () => {
    const call = vi.fn().mockResolvedValue({
      ok: true,
      result: { projects: [], importedCount: 0 }
    })
    vi.stubGlobal('window', { api: { runtimeEnvironments: { call } } })
    const api = createPebbleProjectGroupsApi({} as PreloadApi['projectGroups'])

    await api.importNested({
      parentPath: '/srv/platform',
      groupName: 'Platform',
      projectPaths: ['/srv/platform/api'],
      scanId: 'scan-paired-1',
      mode: 'group',
      connectionId: 'host-1'
    })

    expect(call).toHaveBeenCalledWith({
      selector: 'host-1',
      method: 'projectGroup.importNested',
      params: {
        parentPath: '/srv/platform',
        groupName: 'Platform',
        projectPaths: ['/srv/platform/api'],
        scanId: 'scan-paired-1',
        mode: 'group'
      },
      timeoutMs: 30_000
    })
    expect(requestRuntimeJsonMock).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('does not hide paired-runtime import failures behind relay cache fallback', async () => {
    const call = vi.fn().mockResolvedValue({
      ok: false,
      error: { code: 'permission_denied', message: 'remote import is not allowed' }
    })
    vi.stubGlobal('window', { api: { runtimeEnvironments: { call } } })
    const api = createPebbleProjectGroupsApi({} as PreloadApi['projectGroups'])

    await expect(
      api.importNested({
        parentPath: '/srv/platform',
        groupName: 'Platform',
        projectPaths: ['/srv/platform/api'],
        scanId: 'scan-remote-1',
        mode: 'group',
        connectionId: 'host-1'
      })
    ).rejects.toThrow('remote import is not allowed')
    expect(requestRuntimeJsonMock).not.toHaveBeenCalledWith(
      '/v1/project-groups/import-remote-nested',
      expect.anything()
    )
    vi.unstubAllGlobals()
  })

  it('does not replace paired-runtime scan errors with stale relay snapshots', async () => {
    const call = vi.fn().mockResolvedValue({
      ok: false,
      error: { code: 'invalid_params', message: 'scan root is outside the workspace' }
    })
    vi.stubGlobal('window', { api: { runtimeEnvironments: { call } } })
    const api = createPebbleProjectGroupsApi({} as PreloadApi['projectGroups'])

    await expect(api.scanNested({ path: '/etc', connectionId: 'host-1' })).rejects.toThrow(
      'scan root is outside the workspace'
    )
    expect(requestRuntimeJsonMock).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('forwards runtime scan-progress push events for active scans', async () => {
    const { subscribeRuntimeEventPush } = await import('./tauri-runtime-event-push')
    const pushMock = vi.mocked(subscribeRuntimeEventPush)
    let resolveScan: (scan: NestedRepoScanResult) => void = () => {}
    requestRuntimeJsonMock.mockReturnValue(
      new Promise<NestedRepoScanResult>((resolve) => {
        resolveScan = resolve
      })
    )
    const api = createPebbleProjectGroupsApi({} as PreloadApi['projectGroups'])
    const progress = vi.fn()
    const unsubscribe = api.onNestedScanProgress(progress)
    const scanPromise = api.scanNested({ path: '/platform', scanId: 'scan-9' })
    await Promise.resolve()

    const pushHandler = pushMock.mock.calls.at(-1)?.[0]
    expect(pushHandler).toBeDefined()
    const partial = { ...nestedScan, repos: [] }
    pushHandler?.({
      id: null,
      topic: 'project-group.scan-progress',
      data: JSON.stringify({
        topic: 'project-group.scan-progress',
        payload: { scanId: 'scan-9', scan: partial }
      })
    })
    expect(progress).toHaveBeenCalledWith({ scanId: 'scan-9', scan: partial })

    // Snapshots for scans this window does not own are dropped.
    pushHandler?.({
      id: null,
      topic: 'project-group.scan-progress',
      data: JSON.stringify({
        topic: 'project-group.scan-progress',
        payload: { scanId: 'scan-other', scan: partial }
      })
    })
    expect(progress).toHaveBeenCalledTimes(1)

    resolveScan(nestedScan)
    await scanPromise
    unsubscribe()
  })
})

describe('createPebbleFolderWorkspacesApi', () => {
  beforeEach(() => {
    requestRuntimeJsonMock.mockReset()
  })

  it('routes folder workspace CRUD and path-status calls through Go runtime storage', async () => {
    requestRuntimeJsonMock
      .mockResolvedValueOnce([folderWorkspace])
      .mockResolvedValueOnce({ ok: true, reason: null })
      .mockResolvedValueOnce(folderWorkspace)
      .mockResolvedValueOnce({ ...folderWorkspace, name: 'Platform Ops' })
      .mockResolvedValueOnce({ deleted: true })
    const api = createPebbleFolderWorkspacesApi({} as PreloadApi['folderWorkspaces'])

    await expect(api.list()).resolves.toEqual([folderWorkspace])
    await expect(
      api.getPathStatus({ scope: 'path', path: '/platform', connectionId: null })
    ).resolves.toEqual({
      ok: true,
      reason: null
    })
    await expect(
      api.create({ projectGroupId: 'group-1', name: 'Platform', folderPath: '/platform' })
    ).resolves.toEqual(folderWorkspace)
    await expect(
      api.update({ folderWorkspaceId: 'fw-1', updates: { name: 'Platform Ops' } })
    ).resolves.toMatchObject({ name: 'Platform Ops' })
    await expect(api.delete({ folderWorkspaceId: 'fw-1' })).resolves.toBe(true)

    expect(requestRuntimeJsonMock.mock.calls).toEqual([
      ['/v1/folder-workspaces', { method: 'GET' }],
      [
        '/v1/folder-workspaces/path-status',
        { method: 'POST', body: { scope: 'path', path: '/platform', connectionId: null } }
      ],
      [
        '/v1/folder-workspaces',
        {
          method: 'POST',
          body: { projectGroupId: 'group-1', name: 'Platform', folderPath: '/platform' }
        }
      ],
      [
        '/v1/folder-workspaces/fw-1',
        { method: 'PATCH', body: { updates: { name: 'Platform Ops' } } }
      ],
      ['/v1/folder-workspaces/fw-1', { method: 'DELETE' }]
    ])
  })

  it('handles folder workspace runtime RPC methods with renderer-compatible envelopes', async () => {
    const folderWorkspacesApi = createPebbleFolderWorkspacesApi(
      {} as PreloadApi['folderWorkspaces']
    )
    vi.stubGlobal('window', {
      api: {
        folderWorkspaces: folderWorkspacesApi
      }
    })
    requestRuntimeJsonMock
      .mockResolvedValueOnce(folderWorkspace)
      .mockResolvedValueOnce({ ...folderWorkspace, name: 'Platform Ops' })
      .mockResolvedValueOnce({ deleted: true })

    await expect(
      callTauriFolderWorkspaceRuntimeRpc('folderWorkspace.create', {
        projectGroupId: 'group-1',
        name: 'Platform',
        folderPath: '/platform'
      })
    ).resolves.toEqual({ handled: true, result: { folderWorkspace } })
    await expect(
      callTauriFolderWorkspaceRuntimeRpc('folderWorkspace.update', {
        folderWorkspaceId: 'fw-1',
        updates: { name: 'Platform Ops' }
      })
    ).resolves.toEqual({
      handled: true,
      result: { folderWorkspace: { ...folderWorkspace, name: 'Platform Ops' } }
    })
    await expect(
      callTauriFolderWorkspaceRuntimeRpc('folderWorkspace.delete', {
        folderWorkspaceId: 'fw-1'
      })
    ).resolves.toEqual({ handled: true, result: { deleted: true } })
  })
})
