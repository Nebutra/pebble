import { describe, expect, it } from 'vitest'
import { resolveAgentBackgroundLaunchHost } from './agent-background-session-launch-host'

function makeFolderHostState(args: {
  connectionId: string | null
  folderPath: string
  repos?: {
    id: string
    connectionId: string | null
    path: string
    projectGroupId: string
  }[]
}) {
  return {
    folderWorkspaces: [
      {
        id: 'folder-1',
        projectGroupId: 'group-1',
        folderPath: args.folderPath,
        connectionId: args.connectionId
      }
    ],
    projectGroups: [
      {
        id: 'group-1',
        parentGroupId: null,
        connectionId: args.connectionId
      }
    ],
    repos: args.repos ?? []
  }
}

describe('resolveAgentBackgroundLaunchHost', () => {
  it('keeps an authoritative local folder owner local', () => {
    const host = resolveAgentBackgroundLaunchHost({
      store: makeFolderHostState({ connectionId: null, folderPath: '/project' }) as never,
      worktreeId: 'folder:folder-1',
      worktreePath: '/project',
      repo: null
    })

    expect(host).toMatchObject({
      connectionId: null,
      isRemote: false,
      expectedConnectionId: null
    })
  })

  it('routes an SSH folder workspace to its own host instead of the client', () => {
    // Why: a folder workspace carries a synthetic repoId with no repo row, so the
    // pre-fix repo lookup returned null and the agent launched locally on the
    // client while the workspace's files lived on the SSH host.
    const host = resolveAgentBackgroundLaunchHost({
      store: makeFolderHostState({
        connectionId: 'ssh-1',
        folderPath: '/home/me/project'
      }) as never,
      worktreeId: 'folder:folder-1',
      worktreePath: '/home/me/project',
      repo: null
    })

    expect(host).toMatchObject({
      connectionId: 'ssh-1',
      isRemote: true,
      platform: 'linux',
      expectedConnectionId: 'ssh-1'
    })
  })

  it('fails closed when folder ownership is ambiguous', () => {
    const store = makeFolderHostState({
      connectionId: 'ssh-1',
      folderPath: '/project',
      repos: [
        {
          id: 'repo-local',
          connectionId: null,
          path: '/project/repo',
          projectGroupId: 'group-1'
        }
      ]
    })

    expect(() =>
      resolveAgentBackgroundLaunchHost({
        store: store as never,
        worktreeId: 'folder:folder-1',
        worktreePath: '/project',
        repo: null
      })
    ).toThrow('unavailable or ambiguous')
  })

  it('uses Linux startup quoting for a local WSL folder', () => {
    const folderPath = '\\\\wsl.localhost\\Ubuntu\\home\\me\\project'
    const host = resolveAgentBackgroundLaunchHost({
      store: makeFolderHostState({ connectionId: null, folderPath }) as never,
      worktreeId: 'folder:folder-1',
      worktreePath: folderPath,
      repo: null
    })

    expect(host.platform).toBe('linux')
  })
})
