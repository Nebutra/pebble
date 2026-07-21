import { invoke } from '@tauri-apps/api/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPebbleLinearApi } from './tauri-linear-api'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
const nativeInvoke = vi.mocked(invoke)

const workspace = {
  id: 'workspace-1',
  name: 'Taylor',
  displayName: 'Taylor',
  email: 'taylor@example.com',
  organizationName: 'Pebble',
  organizationUrlKey: 'pebble'
}

describe('createPebbleLinearApi', () => {
  beforeEach(() => nativeInvoke.mockReset())

  it('uses the native credential boundary for connection setup', async () => {
    nativeInvoke.mockResolvedValue({ ok: true, viewer: workspace })

    await createPebbleLinearApi().connect({ apiKey: ' lin_api_key ' })

    expect(nativeInvoke).toHaveBeenCalledWith('linear_connect', {
      input: { apiKey: 'lin_api_key' }
    })
  })

  it('maps native GraphQL issue records into the renderer contract', async () => {
    nativeInvoke
      .mockResolvedValueOnce({
        connected: true,
        viewer: workspace,
        workspaces: [workspace],
        activeWorkspaceId: workspace.id
      })
      .mockResolvedValueOnce({
        connected: true,
        viewer: workspace,
        workspaces: [workspace],
        activeWorkspaceId: workspace.id
      })
      .mockResolvedValueOnce({
        searchIssues: {
          nodes: [
            {
              id: 'issue-1',
              identifier: 'PEB-1',
              title: 'Native Linear',
              url: 'https://linear.app/pebble/issue/PEB-1',
              updatedAt: '2026-01-01T00:00:00Z',
              priority: 2,
              state: { name: 'Doing', type: 'started', color: '#000' },
              team: { id: 'team-1', name: 'Pebble', key: 'PEB' },
              labels: { nodes: [] }
            }
          ]
        }
      })

    await expect(createPebbleLinearApi().searchIssues({ query: 'native' })).resolves.toMatchObject([
      { id: 'issue-1', identifier: 'PEB-1', title: 'Native Linear', team: { key: 'PEB' } }
    ])
    expect(nativeInvoke).toHaveBeenLastCalledWith('linear_request', {
      input: expect.objectContaining({
        workspaceId: workspace.id,
        variables: { term: 'native', first: 20 }
      })
    })
  })

  it('surfaces provider failures instead of using a Web paired fallback', async () => {
    nativeInvoke
      .mockResolvedValueOnce({
        connected: true,
        workspaces: [workspace],
        activeWorkspaceId: workspace.id
      })
      .mockResolvedValueOnce({
        connected: true,
        workspaces: [workspace],
        activeWorkspaceId: workspace.id
      })
      .mockRejectedValueOnce(new Error('Linear provider error: invalid token'))

    await expect(createPebbleLinearApi().searchIssues({ query: 'native' })).rejects.toThrow(
      'Linear provider error: invalid token'
    )
  })
})
