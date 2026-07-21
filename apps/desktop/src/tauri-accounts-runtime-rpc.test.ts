import { beforeEach, describe, expect, it, vi } from 'vitest'

import { callTauriAccountsRuntimeRpc } from './tauri-accounts-runtime-rpc'

describe('callTauriAccountsRuntimeRpc', () => {
  const refresh = vi.fn()
  const selectClaude = vi.fn()
  const selectCodex = vi.fn()
  const listClaude = vi.fn()
  const listCodex = vi.fn()
  const removeClaude = vi.fn()
  const removeCodex = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    ;(globalThis as { window: Window }).window = {
      api: {
        rateLimits: { refresh },
        claudeAccounts: {
          list: listClaude,
          select: selectClaude,
          remove: removeClaude
        },
        codexAccounts: {
          list: listCodex,
          select: selectCodex,
          remove: removeCodex
        }
      }
    } as unknown as Window
  })

  it('returns real native rate limits with the truthful empty managed-account stores', async () => {
    refresh.mockResolvedValue({
      claude: { status: 'ready' },
      codex: { status: 'ready' }
    })
    listClaude.mockResolvedValue({
      accounts: [],
      activeAccountId: null,
      activeAccountIdsByRuntime: { host: null, wsl: {} }
    })
    listCodex.mockResolvedValue({
      accounts: [],
      activeAccountId: null,
      activeAccountIdsByRuntime: { host: null, wsl: {} }
    })

    await expect(callTauriAccountsRuntimeRpc('accounts.list', null)).resolves.toEqual({
      handled: true,
      result: {
        claude: {
          accounts: [],
          activeAccountId: null,
          activeAccountIdsByRuntime: { host: null, wsl: {} }
        },
        codex: {
          accounts: [],
          activeAccountId: null,
          activeAccountIdsByRuntime: { host: null, wsl: {} }
        },
        rateLimits: { claude: { status: 'ready' }, codex: { status: 'ready' } }
      }
    })
  })

  it('routes Claude and Codex deselection through their native account APIs', async () => {
    selectClaude.mockResolvedValue({ accounts: [], activeAccountId: null })
    selectCodex.mockResolvedValue({ accounts: [], activeAccountId: null })

    await callTauriAccountsRuntimeRpc('accounts.selectClaude', {
      accountId: null
    })
    await callTauriAccountsRuntimeRpc('accounts.selectCodex', {
      accountId: null
    })

    expect(selectClaude).toHaveBeenCalledWith({ accountId: null })
    expect(selectCodex).toHaveBeenCalledWith({ accountId: null })
  })

  it('preserves the WSL account selection target for remote clients', async () => {
    selectClaude.mockResolvedValue({ accounts: [], activeAccountId: null })

    await callTauriAccountsRuntimeRpc('accounts.selectClaude', {
      accountId: 'claude-wsl',
      runtime: 'wsl',
      wslDistro: ' Ubuntu '
    })

    expect(selectClaude).toHaveBeenCalledWith({
      accountId: 'claude-wsl',
      runtime: 'wsl',
      wslDistro: 'Ubuntu'
    })
  })

  it('preserves account ids so the native API can reject unknown managed accounts', async () => {
    selectClaude.mockRejectedValue(new Error('That Claude rate limit account no longer exists.'))

    await expect(
      callTauriAccountsRuntimeRpc('accounts.selectClaude', {
        accountId: 'managed-1'
      })
    ).rejects.toThrow('That Claude rate limit account no longer exists.')
    expect(selectClaude).toHaveBeenCalledWith({ accountId: 'managed-1' })
  })

  it('routes account removal through the canonical native account APIs', async () => {
    removeClaude.mockRejectedValue(new Error('That Claude rate limit account no longer exists.'))
    removeCodex.mockResolvedValue({ accounts: [], activeAccountId: null })

    await expect(
      callTauriAccountsRuntimeRpc('accounts.removeClaude', {
        accountId: 'claude-1'
      })
    ).rejects.toThrow('That Claude rate limit account no longer exists.')
    await callTauriAccountsRuntimeRpc('accounts.removeCodex', {
      accountId: 'codex-1'
    })

    expect(removeClaude).toHaveBeenCalledWith({ accountId: 'claude-1' })
    expect(removeCodex).toHaveBeenCalledWith({ accountId: 'codex-1' })
  })

  it('rejects malformed selection parameters and leaves streaming methods unmapped', async () => {
    await expect(callTauriAccountsRuntimeRpc('accounts.selectCodex', {})).rejects.toThrow(
      'Missing accountId'
    )
    await expect(
      callTauriAccountsRuntimeRpc('accounts.selectCodex', {
        accountId: null,
        runtime: 'container'
      })
    ).rejects.toThrow('Invalid account runtime')
    await expect(
      callTauriAccountsRuntimeRpc('accounts.removeCodex', { accountId: null })
    ).rejects.toThrow('Missing accountId')
    await expect(callTauriAccountsRuntimeRpc('accounts.subscribe', null)).resolves.toEqual({
      handled: false
    })
  })
})
