import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceSessionState } from '../../../packages/product-core/shared/types'

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

import { installTauriSessionPersistenceApi } from './tauri-session-persistence-api'

describe('installTauriSessionPersistenceApi', () => {
  const localSession = { activeWorktreeId: 'local-wt' } as WorkspaceSessionState
  const remoteSession = { activeWorktreeId: 'remote-wt' } as WorkspaceSessionState
  const baseGet = vi.fn(() => Promise.resolve(localSession))
  const baseSet = vi.fn(() => Promise.resolve())
  const basePatch = vi.fn(() => Promise.resolve())
  const baseSetSync = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    const storage = new Map<string, string>()
    globalThis.window = {
      __TAURI_INTERNALS__: {},
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value)
      },
      api: {
        session: {
          get: baseGet,
          set: baseSet,
          patch: basePatch,
          setSync: baseSetSync,
          readTerminalScrollback: () => null
        }
      }
    } as unknown as Window & typeof globalThis
  })

  it('reads and patches remote host sessions through native storage', async () => {
    invokeMock.mockResolvedValueOnce(JSON.stringify(remoteSession)).mockResolvedValueOnce(undefined)
    installTauriSessionPersistenceApi()

    await expect(window.api.session.get('ssh:builder')).resolves.toEqual(remoteSession)
    await window.api.session.patch({ activeWorktreeId: 'remote-next' }, 'ssh:builder')
    expect(invokeMock).toHaveBeenLastCalledWith('write_host_workspace_session', {
      hostId: 'ssh:builder',
      contents: JSON.stringify({ activeWorktreeId: 'remote-next' })
    })
    expect(baseGet).not.toHaveBeenCalled()
  })

  it('keeps local sessions on the fixed named-document backend', async () => {
    installTauriSessionPersistenceApi()
    const sessionWithScrollback = {
      ...localSession,
      terminalLayoutsByTabId: {
        'tab-1': {
          root: { type: 'leaf', leafId: 'leaf-1' },
          activeLeafId: 'leaf-1',
          expandedLeafId: null,
          buffersByLeafId: { 'leaf-1': 'restored output' }
        }
      }
    } as WorkspaceSessionState
    window.api.session.setSync(sessionWithScrollback)
    await expect(window.api.session.get()).resolves.toMatchObject(sessionWithScrollback)
    expect(baseGet).not.toHaveBeenCalled()
    expect(baseSetSync).not.toHaveBeenCalled()
    expect(invokeMock).not.toHaveBeenCalled()
  })
})
