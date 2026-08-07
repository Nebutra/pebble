import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { markLiveCodexSessionsForRestart } from './codex-session-restart'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '@/runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '@/runtime/runtime-rpc-client'
import type { ProjectExecutionRuntimeResolution } from '../../../shared/project-execution-runtime'
import type * as LocalPreflightContext from './local-preflight-context'

let projectRuntimeByWorktreeId: Record<string, ProjectExecutionRuntimeResolution> = {}

vi.mock('@/lib/local-preflight-context', async (importOriginal) => ({
  ...(await importOriginal<typeof LocalPreflightContext>()),
  getLocalProjectExecutionRuntimeContext: (_state: unknown, worktreeId?: string | null) =>
    worktreeId ? projectRuntimeByWorktreeId[worktreeId] : undefined
}))

function wslRuntime(distro: string): ProjectExecutionRuntimeResolution {
  return {
    status: 'resolved',
    runtime: {
      kind: 'wsl',
      hostPlatform: 'wsl',
      projectId: 'project-1',
      distro,
      reason: 'project-override',
      cacheKey: `wsl:${distro}`
    }
  }
}

const ACCOUNT_A = 'account-a@example.com'
const ACCOUNT_B = 'account-b@example.com'
const ACCOUNT_C = 'account-c@example.com'

describe('markLiveCodexSessionsForRestart', () => {
  const originalWindow = (globalThis as { window?: typeof window }).window
  const runtimeEnvironmentCall = vi.fn()
  const runtimeEnvironmentTransportCall = vi.fn()

  beforeEach(() => {
    clearRuntimeCompatibilityCacheForTests()
    projectRuntimeByWorktreeId = {}
    runtimeEnvironmentCall.mockReset()
    runtimeEnvironmentTransportCall.mockReset()
    runtimeEnvironmentTransportCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
      return createCompatibleRuntimeStatusResponseIfNeeded(args) ?? runtimeEnvironmentCall(args)
    })
    useAppStore.setState({
      tabsByWorktree: {
        wt1: [
          {
            id: 'tab-1',
            ptyId: 'pty-1',
            worktreeId: 'wt1',
            title: 'pebble-1',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      ptyIdsByTabId: {
        'tab-1': ['pty-1']
      },
      pendingCodexPaneRestartIds: {},
      codexRestartNoticeByPtyId: {},
      markCodexRestartNotices: useAppStore.getState().markCodexRestartNotices
    })

    ;(globalThis as { window: typeof window }).window = {
      ...originalWindow,
      api: {
        ...originalWindow?.api,
        pty: {
          ...originalWindow?.api?.pty,
          getForegroundProcess: vi.fn(),
          hasChildProcesses: vi.fn().mockResolvedValue(false)
        },
        runtimeEnvironments: {
          ...originalWindow?.api?.runtimeEnvironments,
          call: runtimeEnvironmentTransportCall
        }
      }
    } as unknown as typeof window
  })

  afterEach(() => {
    if (originalWindow) {
      ;(globalThis as { window: typeof window }).window = originalWindow
    } else {
      delete (globalThis as { window?: typeof window }).window
    }
  })

  it('marks a live Codex PTY for restart', async () => {
    vi.mocked(window.api.pty.getForegroundProcess).mockResolvedValue('codex')

    await markLiveCodexSessionsForRestart({
      route: { runtime: 'host' },
      previousAccountLabel: ACCOUNT_A,
      nextAccountLabel: ACCOUNT_B
    })

    expect(window.api.pty.getForegroundProcess).toHaveBeenCalledWith('pty-1')
    expect(useAppStore.getState().codexRestartNoticeByPtyId['pty-1']).toEqual({
      previousAccountLabel: ACCOUNT_A,
      nextAccountLabel: ACCOUNT_B
    })
  })

  it('marks every live Codex split pane and ignores non-Codex panes', async () => {
    useAppStore.setState({
      tabsByWorktree: {
        wt1: [
          {
            id: 'tab-1',
            ptyId: 'pty-1',
            worktreeId: 'wt1',
            title: 'pebble-1',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          },
          {
            id: 'tab-2',
            ptyId: 'pty-3',
            worktreeId: 'wt1',
            title: 'pebble-2',
            customTitle: null,
            color: null,
            sortOrder: 1,
            createdAt: 2
          }
        ]
      },
      ptyIdsByTabId: {
        'tab-1': ['pty-1', 'pty-2'],
        'tab-2': ['pty-3']
      }
    })
    vi.mocked(window.api.pty.getForegroundProcess).mockImplementation((ptyId) => {
      if (ptyId === 'pty-1') {
        return Promise.resolve('codex')
      }
      if (ptyId === 'pty-3') {
        return Promise.resolve('codex-aarch64-ap')
      }
      return Promise.resolve('zsh')
    })

    await markLiveCodexSessionsForRestart({
      route: { runtime: 'host' },
      previousAccountLabel: ACCOUNT_A,
      nextAccountLabel: ACCOUNT_B
    })

    expect(useAppStore.getState().codexRestartNoticeByPtyId).toEqual({
      'pty-1': {
        previousAccountLabel: ACCOUNT_A,
        nextAccountLabel: ACCOUNT_B
      },
      'pty-3': {
        previousAccountLabel: ACCOUNT_A,
        nextAccountLabel: ACCOUNT_B
      }
    })
  })

  it('does not mark non-codex foreground processes', async () => {
    vi.mocked(window.api.pty.getForegroundProcess).mockResolvedValue('zsh')

    await markLiveCodexSessionsForRestart({
      route: { runtime: 'host' },
      previousAccountLabel: ACCOUNT_A,
      nextAccountLabel: ACCOUNT_B
    })

    expect(useAppStore.getState().codexRestartNoticeByPtyId).toEqual({})
  })

  it('treats codex.exe as codex for Windows PTYs', async () => {
    vi.mocked(window.api.pty.getForegroundProcess).mockResolvedValue('codex.exe')

    await markLiveCodexSessionsForRestart({
      route: { runtime: 'host' },
      previousAccountLabel: ACCOUNT_A,
      nextAccountLabel: ACCOUNT_B
    })

    expect(useAppStore.getState().codexRestartNoticeByPtyId['pty-1']).toEqual({
      previousAccountLabel: ACCOUNT_A,
      nextAccountLabel: ACCOUNT_B
    })
  })

  it('treats codex-prefixed packaged binaries as codex', async () => {
    vi.mocked(window.api.pty.getForegroundProcess).mockResolvedValue('codex-aarch64-ap')

    await markLiveCodexSessionsForRestart({
      route: { runtime: 'host' },
      previousAccountLabel: ACCOUNT_A,
      nextAccountLabel: ACCOUNT_B
    })

    expect(useAppStore.getState().codexRestartNoticeByPtyId['pty-1']).toEqual({
      previousAccountLabel: ACCOUNT_A,
      nextAccountLabel: ACCOUNT_B
    })
  })

  it('clears stale restart notices when the selected account switches back to the live pane account', async () => {
    vi.mocked(window.api.pty.getForegroundProcess).mockResolvedValue('codex')

    await markLiveCodexSessionsForRestart({
      route: { runtime: 'host' },
      previousAccountLabel: ACCOUNT_A,
      nextAccountLabel: ACCOUNT_B
    })
    useAppStore.getState().queueCodexPaneRestarts(['pty-1'])

    await markLiveCodexSessionsForRestart({
      route: { runtime: 'host' },
      previousAccountLabel: ACCOUNT_B,
      nextAccountLabel: ACCOUNT_A
    })

    expect(useAppStore.getState().codexRestartNoticeByPtyId).toEqual({})
    expect(useAppStore.getState().pendingCodexPaneRestartIds).toEqual({})
  })

  it('preserves the pane original account across repeated switches until restart', async () => {
    vi.mocked(window.api.pty.getForegroundProcess).mockResolvedValue('codex')

    await markLiveCodexSessionsForRestart({
      route: { runtime: 'host' },
      previousAccountLabel: ACCOUNT_A,
      nextAccountLabel: ACCOUNT_B
    })

    await markLiveCodexSessionsForRestart({
      route: { runtime: 'host' },
      previousAccountLabel: ACCOUNT_B,
      nextAccountLabel: ACCOUNT_C
    })

    expect(useAppStore.getState().codexRestartNoticeByPtyId['pty-1']).toEqual({
      previousAccountLabel: ACCOUNT_A,
      nextAccountLabel: ACCOUNT_C
    })
  })

  it('inspects remote runtime PTYs through the active runtime environment', async () => {
    useAppStore.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
      tabsByWorktree: {
        wt1: [
          {
            id: 'tab-1',
            ptyId: 'remote:term-1',
            worktreeId: 'wt1',
            title: 'pebble-1',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      ptyIdsByTabId: {
        'tab-1': ['remote:term-1']
      }
    })
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-1',
      ok: true,
      result: {
        process: { foregroundProcess: 'codex', hasChildProcesses: true }
      },
      _meta: { runtimeId: 'remote-runtime' }
    })

    await markLiveCodexSessionsForRestart({
      route: { runtime: 'host' },
      previousAccountLabel: ACCOUNT_A,
      nextAccountLabel: ACCOUNT_B
    })

    expect(window.api.pty.getForegroundProcess).not.toHaveBeenCalled()
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'terminal.inspectProcess',
      params: { terminal: 'term-1' },
      timeoutMs: 15_000
    })
    expect(useAppStore.getState().codexRestartNoticeByPtyId['remote:term-1']).toEqual({
      previousAccountLabel: ACCOUNT_A,
      nextAccountLabel: ACCOUNT_B
    })
  })

  describe('CODEX_HOME route scoping', () => {
    beforeEach(() => {
      projectRuntimeByWorktreeId = { wt2: wslRuntime('Ubuntu') }
      useAppStore.setState({
        tabsByWorktree: {
          wt1: [
            {
              id: 'tab-1',
              ptyId: 'pty-1',
              worktreeId: 'wt1',
              title: 'pebble-host',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            }
          ],
          wt2: [
            {
              id: 'tab-2',
              ptyId: 'pty-2',
              worktreeId: 'wt2',
              title: 'pebble-wsl',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 2
            }
          ]
        },
        ptyIdsByTabId: { 'tab-1': ['pty-1'], 'tab-2': ['pty-2'] }
      })
      vi.mocked(window.api.pty.getForegroundProcess).mockResolvedValue('codex')
    })

    it('marks only the panes launched against the switched route', async () => {
      await markLiveCodexSessionsForRestart({
        route: { runtime: 'wsl', wslDistro: 'Ubuntu' },
        previousAccountLabel: ACCOUNT_A,
        nextAccountLabel: ACCOUNT_B
      })

      const notices = useAppStore.getState().codexRestartNoticeByPtyId
      expect(notices['pty-2']).toEqual({
        previousAccountLabel: ACCOUNT_A,
        nextAccountLabel: ACCOUNT_B
      })
      expect(notices['pty-1']).toBeUndefined()
    })

    it('keeps a pending restart when another route switches to the same account label', async () => {
      await markLiveCodexSessionsForRestart({
        route: { runtime: 'host' },
        previousAccountLabel: ACCOUNT_A,
        nextAccountLabel: ACCOUNT_B
      })
      useAppStore.setState({ pendingCodexPaneRestartIds: { 'pty-1': true } })

      // Why: host and WSL panes can share an account label while pointing at
      // different managed homes. A WSL switch back to that label must not read
      // as "the host pane is home again" and cancel its real pending restart.
      await markLiveCodexSessionsForRestart({
        route: { runtime: 'wsl', wslDistro: 'Ubuntu' },
        previousAccountLabel: ACCOUNT_C,
        nextAccountLabel: ACCOUNT_A
      })

      expect(useAppStore.getState().codexRestartNoticeByPtyId['pty-1']).toEqual({
        previousAccountLabel: ACCOUNT_A,
        nextAccountLabel: ACCOUNT_B
      })
      expect(useAppStore.getState().pendingCodexPaneRestartIds['pty-1']).toBe(true)
    })

    it('separates WSL distros that each select their own account', async () => {
      projectRuntimeByWorktreeId = { wt2: wslRuntime('Debian') }

      await markLiveCodexSessionsForRestart({
        route: { runtime: 'wsl', wslDistro: 'Ubuntu' },
        previousAccountLabel: ACCOUNT_A,
        nextAccountLabel: ACCOUNT_B
      })

      expect(useAppStore.getState().codexRestartNoticeByPtyId['pty-2']).toBeUndefined()
    })
  })
})
