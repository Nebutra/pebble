import { describe, expect, it, vi } from 'vitest'
import type { PreloadApi } from '../../../src/preload/api-types'
import { createPebbleRuntimeApi } from './pebble-tauri-runtime-control-api'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn()
}))

describe('createPebbleRuntimeApi', () => {
  it('maps hosted review lookup to an explicit unsupported local Tauri result', async () => {
    const api = createPebbleRuntimeApi({} as PreloadApi['runtime'])

    await expect(
      api.call({
        method: 'hostedReview.forBranch',
        params: { repo: 'repo-1', branch: 'feature/review' }
      })
    ).resolves.toMatchObject({
      ok: true,
      result: null
    })
  })

  it('maps hosted review creation eligibility to normal blocked-review UX', async () => {
    const api = createPebbleRuntimeApi({} as PreloadApi['runtime'])

    await expect(
      api.call({
        method: 'hostedReview.getCreationEligibility',
        params: { repo: 'repo-1', branch: 'feature/review' }
      })
    ).resolves.toMatchObject({
      ok: true,
      result: {
        provider: 'unsupported',
        review: null,
        canCreate: false,
        blockedReason: 'unsupported_provider',
        nextAction: null
      }
    })
  })

  it('maps hosted review creation to a typed unsupported result', async () => {
    const api = createPebbleRuntimeApi({} as PreloadApi['runtime'])

    await expect(
      api.call({
        method: 'hostedReview.create',
        params: {
          repo: 'repo-1',
          provider: 'github',
          base: 'main',
          title: 'Open PR'
        }
      })
    ).resolves.toMatchObject({
      ok: true,
      result: {
        ok: false,
        code: 'unsupported_provider'
      }
    })
  })
})
