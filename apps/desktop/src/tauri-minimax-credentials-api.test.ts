import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }))

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

import { createPebbleMiniMaxCredentialsApi } from './tauri-minimax-credentials-api'

describe('createPebbleMiniMaxCredentialsApi', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    globalThis.window = { __TAURI_INTERNALS__: {} } as unknown as Window & typeof globalThis
  })

  it('routes status, save, and clear through native credential commands', async () => {
    invokeMock.mockResolvedValue({ configured: true })
    const api = createPebbleMiniMaxCredentialsApi({
      getStatus: vi.fn(),
      saveCookie: vi.fn(),
      clearCookie: vi.fn()
    })

    await api.getStatus()
    await api.saveCookie('_token=secret')
    await api.clearCookie()

    expect(invokeMock.mock.calls).toEqual([
      ['minimax_credentials_get_status'],
      ['minimax_credentials_save_cookie', { cookie: '_token=secret' }],
      ['minimax_credentials_clear_cookie']
    ])
  })
})
