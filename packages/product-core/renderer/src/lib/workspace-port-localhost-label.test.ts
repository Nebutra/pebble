import { describe, expect, it } from 'vitest'
import { localhostWorktreeLabelRouteForPort } from './workspace-port-localhost-label'
import type { Repo } from '../../../shared/types'
import type { WorkspacePort } from '../../../shared/workspace-ports'

describe('localhostWorktreeLabelRouteForPort', () => {
  it('preserves SSH ownership and the remote listener target', () => {
    const route = localhostWorktreeLabelRouteForPort({
      port: {
        id: 'remote:4173',
        bindHost: '0.0.0.0',
        connectHost: '127.0.0.1',
        port: 4173,
        protocol: 'http',
        kind: 'workspace',
        advertisedUrl: 'http://dev.example.test:4173/',
        owner: {
          worktreeId: 'repo-1::/srv/repo',
          repoId: 'repo-1',
          displayName: 'Feature',
          path: '/srv/repo',
          confidence: 'cwd'
        }
      } satisfies WorkspacePort,
      repo: {
        id: 'repo-1',
        path: '/srv/repo',
        displayName: 'Pebble',
        badgeColor: 'gray',
        addedAt: 1,
        connectionId: 'ssh-1'
      } satisfies Repo,
      settings: { localhostWorktreeLabelsEnabled: true }
    })

    expect(route).toMatchObject({
      targetUrl: 'http://dev.example.test:4173/',
      connectionId: 'ssh-1',
      remoteHost: '127.0.0.1',
      remotePort: 4173
    })
  })
})
