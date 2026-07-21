import { describe, expect, it, vi } from 'vitest'
import type { PreloadApi } from '../../../packages/product-core/shared/preload-api-types'
import { createTauriE2EApi, installTauriE2EApi } from './tauri-e2e-api'

describe('Tauri e2e preload API', () => {
  it('returns the Electron config contract in e2e mode', () => {
    const api = createTauriE2EApi({ MODE: 'e2e' })

    expect(api?.getConfig()).toEqual({
      enabled: true,
      headless: false,
      exposeStore: true,
      userDataDir: null
    })
  })

  it('supports the explicit store-exposure signal used by Tauri gates', () => {
    const api = {
      e2e: { getConfig: vi.fn() }
    } as unknown as PreloadApi

    installTauriE2EApi(api, { VITE_EXPOSE_STORE: 'true' })

    expect(api.e2e.getConfig()).toEqual({
      enabled: true,
      headless: false,
      exposeStore: true,
      userDataDir: null
    })
  })

  it('removes the web fallback namespace from production builds', () => {
    const api = {
      e2e: { getConfig: vi.fn() }
    } as unknown as PreloadApi

    installTauriE2EApi(api, { MODE: 'production' })

    expect('e2e' in api).toBe(false)
  })
})
