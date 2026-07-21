// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  clearPersistentSettingsBackends,
  readPersistentSettingsRaw,
  writePersistentSettingsRaw
} from '@/web/persistent-settings-backend'
import { callTauriUiRuntimeRpc } from './tauri-ui-runtime-rpc'

const UI_KEY = 'pebble.web.ui.v1'

describe('callTauriUiRuntimeRpc', () => {
  beforeEach(() => {
    clearPersistentSettingsBackends()
    window.localStorage.clear()
    vi.restoreAllMocks()
  })

  it('returns canonical UI defaults when no native document exists', async () => {
    await expect(callTauriUiRuntimeRpc('ui.get', null)).resolves.toMatchObject({
      handled: true,
      result: { ui: { sidebarWidth: 280, rightSidebarOpen: true, featureInteractions: {} } }
    })
  })

  it('strictly parses and merges UI updates while preserving unrelated state', async () => {
    writePersistentSettingsRaw(UI_KEY, JSON.stringify({ sidebarWidth: 300, petVisible: true }))

    const response = await callTauriUiRuntimeRpc('ui.set', {
      rightSidebarOpen: false,
      browserDefaultSearchEngine: 'kagi'
    })

    expect(response).toMatchObject({
      handled: true,
      result: {
        ui: {
          sidebarWidth: 300,
          petVisible: true,
          rightSidebarOpen: false,
          browserDefaultSearchEngine: 'kagi'
        }
      }
    })
  })

  it('rejects unknown keys and invalid enum values through the shared Electron schema', async () => {
    await expect(callTauriUiRuntimeRpc('ui.set', { inventedPanel: true })).rejects.toThrow()
    await expect(
      callTauriUiRuntimeRpc('ui.set', { rightSidebarTab: 'not-a-tab' })
    ).rejects.toThrow()
    expect(readPersistentSettingsRaw(UI_KEY)).toBeNull()
  })

  it('records feature interactions without resetting the first timestamp', async () => {
    vi.spyOn(Date, 'now').mockReturnValueOnce(1000).mockReturnValueOnce(2000)

    await callTauriUiRuntimeRpc('ui.recordFeatureInteraction', 'browser')
    const second = await callTauriUiRuntimeRpc('ui.recordFeatureInteraction', 'browser')

    expect(second).toMatchObject({
      handled: true,
      result: {
        ui: {
          featureInteractions: {
            browser: { firstInteractedAt: 1000, interactionCount: 2 }
          }
        }
      }
    })
  })

  it('rejects unknown feature interaction ids', async () => {
    await expect(
      callTauriUiRuntimeRpc('ui.recordFeatureInteraction', 'invented-feature')
    ).rejects.toThrow('Unknown feature interaction id')
  })
})
