import { beforeEach, describe, expect, it, vi } from 'vitest'

const { requestRuntimeJsonMock } = vi.hoisted(() => ({
  requestRuntimeJsonMock: vi.fn()
}))

vi.mock('./pebble-runtime-http-bridge', () => ({
  requestRuntimeJson: requestRuntimeJsonMock
}))

import { queueAccountsSnapshotSync } from './tauri-accounts-snapshot-sync'

describe('queueAccountsSnapshotSync', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    globalThis.window = {
      api: {
        claudeAccounts: {
          list: vi.fn().mockResolvedValue({ accounts: [], activeAccountId: null })
        },
        codexAccounts: {
          list: vi.fn().mockResolvedValue({ accounts: [], activeAccountId: null })
        },
        rateLimits: { get: vi.fn() }
      }
    } as unknown as Window & typeof globalThis
  })

  it('publishes real account stores and quota through the Go runtime', async () => {
    const rateLimits = { claude: { status: 'ready' }, codex: null } as never

    await queueAccountsSnapshotSync(rateLimits)

    expect(requestRuntimeJsonMock).toHaveBeenCalledWith(
      '/v1/accounts/snapshot',
      expect.objectContaining({
        method: 'PUT',
        body: {
          claude: { accounts: [], activeAccountId: null },
          codex: { accounts: [], activeAccountId: null },
          rateLimits
        }
      })
    )
  })
})
