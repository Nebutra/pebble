// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from 'vitest'

import {
  clearPersistentSettingsBackends,
  readPersistentSettingsRaw,
  writePersistentSettingsRaw
} from '@/web/persistent-settings-backend'
import { callTauriSettingsRuntimeRpc } from './tauri-settings-runtime-rpc'

const SETTINGS_KEY = 'pebble.web.settings.v1'

describe('callTauriSettingsRuntimeRpc', () => {
  beforeEach(() => {
    clearPersistentSettingsBackends()
    window.localStorage.clear()
  })

  it('returns the Electron-compatible client settings defaults', async () => {
    const response = await callTauriSettingsRuntimeRpc('settings.get', null)

    expect(response).toMatchObject({
      handled: true,
      result: {
        settings: {
          agentStatusHooksEnabled: true,
          defaultTaskSource: 'github',
          defaultTaskViewPreset: 'all',
          minimaxGroupId: '',
          minimaxUsageModels: 'general'
        }
      }
    })
  })

  it('merges validated partial updates without dropping unrelated native settings', async () => {
    writePersistentSettingsRaw(
      SETTINGS_KEY,
      JSON.stringify({ theme: 'dark', compactWorktreeCards: false, minimaxGroupId: 'old' })
    )

    const response = await callTauriSettingsRuntimeRpc('settings.update', {
      compactWorktreeCards: true,
      minimaxGroupId: 'group-1'
    })

    expect(response).toMatchObject({
      handled: true,
      result: { settings: { compactWorktreeCards: true, minimaxGroupId: 'group-1' } }
    })
    expect(JSON.parse(readPersistentSettingsRaw(SETTINGS_KEY) ?? '{}')).toMatchObject({
      theme: 'dark',
      compactWorktreeCards: true,
      minimaxGroupId: 'group-1'
    })
  })

  it('rejects unknown fields and invalid known-field types before persistence', async () => {
    await expect(
      callTauriSettingsRuntimeRpc('settings.update', { shellCommand: 'rm -rf ~' })
    ).rejects.toThrow('Unknown settings field: shellCommand')
    await expect(
      callTauriSettingsRuntimeRpc('settings.update', { compactWorktreeCards: 'yes' })
    ).rejects.toThrow('Invalid settings field: compactWorktreeCards')
    expect(readPersistentSettingsRaw(SETTINGS_KEY)).toBeNull()
  })

  it('leaves unrelated methods for the next runtime adapter', async () => {
    await expect(callTauriSettingsRuntimeRpc('ui.get', null)).resolves.toEqual({ handled: false })
  })
})
