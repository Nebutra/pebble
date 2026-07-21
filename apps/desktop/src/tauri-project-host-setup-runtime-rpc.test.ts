import { describe, expect, it, vi } from 'vitest'
import type { PreloadApi } from '../../../packages/product-core/shared/preload-api-types'
import { callTauriProjectHostSetupRuntimeRpc } from './tauri-project-host-setup-runtime-rpc'

function makeProjectsApi(): PreloadApi['projects'] {
  return {
    list: vi.fn().mockResolvedValue([{ id: 'project-1' }]),
    update: vi.fn().mockResolvedValue({ id: 'project-1' }),
    listHostSetups: vi.fn().mockResolvedValue([{ id: 'setup-1' }]),
    createHostSetup: vi
      .fn()
      .mockResolvedValue({ project: { id: 'project-1' }, setup: { id: 'setup-1' } }),
    setupExistingFolder: vi.fn().mockResolvedValue({
      project: { id: 'project-1' },
      setup: { id: 'setup-1' },
      repo: { id: 'repo-1' }
    }),
    updateHostSetup: vi
      .fn()
      .mockResolvedValue({ project: { id: 'project-1' }, setup: { id: 'setup-1' } }),
    deleteHostSetup: vi
      .fn()
      .mockResolvedValue({ project: { id: 'project-1' }, setup: { id: 'setup-1' } })
  } as unknown as PreloadApi['projects']
}

describe('callTauriProjectHostSetupRuntimeRpc', () => {
  it('lists canonical projects and independent host setups through the native API', async () => {
    const projects = makeProjectsApi()

    await expect(
      callTauriProjectHostSetupRuntimeRpc('project.list', undefined, projects)
    ).resolves.toEqual({
      handled: true,
      result: { projects: [{ id: 'project-1' }] }
    })
    await expect(
      callTauriProjectHostSetupRuntimeRpc('projectHostSetup.list', undefined, projects)
    ).resolves.toEqual({ handled: true, result: { setups: [{ id: 'setup-1' }] } })
  })

  it('maps the complete host setup mutation lifecycle', async () => {
    const projects = makeProjectsApi()

    await callTauriProjectHostSetupRuntimeRpc(
      'projectHostSetup.create',
      { projectId: ' project-1 ', hostId: ' local ' },
      projects
    )
    await callTauriProjectHostSetupRuntimeRpc(
      'projectHostSetup.setupExistingFolder',
      { projectId: 'project-1', hostId: 'local', path: ' /repo ' },
      projects
    )
    await callTauriProjectHostSetupRuntimeRpc(
      'projectHostSetup.update',
      { setupId: ' setup-1 ', updates: { displayName: 'Pebble' } },
      projects
    )
    await callTauriProjectHostSetupRuntimeRpc(
      'projectHostSetup.delete',
      { setupId: ' setup-1 ' },
      projects
    )

    expect(projects.createHostSetup).toHaveBeenCalledWith({
      projectId: 'project-1',
      hostId: 'local'
    })
    expect(projects.setupExistingFolder).toHaveBeenCalledWith({
      projectId: 'project-1',
      hostId: 'local',
      path: '/repo'
    })
    expect(projects.updateHostSetup).toHaveBeenCalledWith({
      setupId: 'setup-1',
      updates: { displayName: 'Pebble' }
    })
    expect(projects.deleteHostSetup).toHaveBeenCalledWith({ setupId: 'setup-1' })
  })

  it('maps validated project runtime preference updates', async () => {
    const projects = makeProjectsApi()

    await expect(
      callTauriProjectHostSetupRuntimeRpc(
        'project.update',
        {
          projectId: ' project-1 ',
          updates: { localWindowsRuntimePreference: { kind: 'wsl', distro: ' Ubuntu ' } }
        },
        projects
      )
    ).resolves.toEqual({ handled: true, result: { project: { id: 'project-1' } } })
    expect(projects.update).toHaveBeenCalledWith({
      projectId: 'project-1',
      updates: { localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' } }
    })
  })

  it('rejects invalid project runtime preferences', async () => {
    const projects = makeProjectsApi()

    await expect(
      callTauriProjectHostSetupRuntimeRpc(
        'project.update',
        {
          projectId: 'project-1',
          updates: { localWindowsRuntimePreference: { kind: 'wsl' } }
        },
        projects
      )
    ).rejects.toThrow('localWindowsRuntimePreference.distro must be a non-empty string')
    expect(projects.update).not.toHaveBeenCalled()
  })

  it('rejects malformed remote mutation parameters before calling native APIs', async () => {
    const projects = makeProjectsApi()

    await expect(
      callTauriProjectHostSetupRuntimeRpc(
        'projectHostSetup.setupExistingFolder',
        { projectId: 'project-1', hostId: 'local' },
        projects
      )
    ).rejects.toThrow('path must be a non-empty string')
    expect(projects.setupExistingFolder).not.toHaveBeenCalled()
  })
})
