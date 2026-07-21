// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DeveloperPermissionRequestResult } from '../../../../shared/developer-permissions-types'
import type { GlobalSettings } from '../../../../shared/types'
import { getDefaultVoiceSettings } from '../../../../shared/constants'
import { handleVoiceDictationToggle, VoicePane } from './VoicePane'

type TauriVoicePaneTestWindow = Window & {
  __TAURI_INTERNALS__?: unknown
  __PEBBLE_LOCAL_SPEECH_SUPPORTED__?: boolean
}

const { useAppStoreMock, useShortcutLabelMock } = vi.hoisted(() => ({
  useAppStoreMock: vi.fn(),
  useShortcutLabelMock: vi.fn()
}))

vi.mock('@/store', () => ({ useAppStore: useAppStoreMock }))

vi.mock('@/hooks/useShortcutLabel', () => ({
  useShortcutLabel: useShortcutLabelMock
}))

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    message: vi.fn(),
    success: vi.fn()
  }
}))

const deniedMicrophoneResult: DeveloperPermissionRequestResult = {
  id: 'microphone',
  status: 'denied',
  openedSystemSettings: false
}

function makeSettings(voiceEnabled: boolean, sttModel?: string): GlobalSettings {
  return {
    voice: {
      ...getDefaultVoiceSettings(),
      enabled: voiceEnabled,
      ...(sttModel ? { sttModel } : {})
    }
  } as GlobalSettings
}

function installWindowApi(
  requestMicrophonePermission: () => Promise<DeveloperPermissionRequestResult>,
  openAiApiKeyConfigured = false
) {
  Object.assign(window, {
    api: {
      developerPermissions: {
        request: vi.fn(requestMicrophonePermission)
      },
      speech: {
        getCatalog: vi.fn(async () => []),
        getOpenAiApiKeyStatus: vi.fn(async () => ({ configured: openAiApiKeyConfigured })),
        saveOpenAiApiKey: vi.fn(async () => ({ configured: true })),
        clearOpenAiApiKey: vi.fn(async () => ({ configured: false })),
        onDownloadProgress: vi.fn(() => () => {}),
        downloadModel: vi.fn()
      }
    }
  })
}

async function renderVoicePane(args: {
  voiceEnabled: boolean
  markFeatureTipsSeen: (ids: string[]) => void
  updateSettings: (updates: Partial<GlobalSettings>) => void
  requestMicrophonePermission?: () => Promise<DeveloperPermissionRequestResult>
  recordFeatureInteraction?: (id: string) => void
  sttModel?: string
  openAiApiKeyConfigured?: boolean
}): Promise<{
  button: HTMLButtonElement
  root: Root
  container: HTMLDivElement
  refreshModelStates: ReturnType<typeof vi.fn>
}> {
  const refreshModelStates = vi.fn(async () => {})
  useAppStoreMock.mockImplementation((selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      modelStates: [],
      refreshModelStates,
      markFeatureTipsSeen: args.markFeatureTipsSeen,
      recordFeatureInteraction: args.recordFeatureInteraction ?? vi.fn()
    })
  )
  useShortcutLabelMock.mockReturnValue('Ctrl+Shift+Y')
  installWindowApi(
    args.requestMicrophonePermission ?? vi.fn(async () => deniedMicrophoneResult),
    args.openAiApiKeyConfigured
  )

  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(
      <VoicePane
        settings={makeSettings(args.voiceEnabled, args.sttModel)}
        updateSettings={args.updateSettings}
      />
    )
  })

  const button = container.querySelector<HTMLButtonElement>('button[role="switch"]')
  if (!button) {
    throw new Error('Voice Dictation switch was not rendered')
  }

  return { button, root, container, refreshModelStates }
}

async function clickSwitch(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await act(async () => {
    await Promise.resolve()
  })
}

describe('VoicePane dictation switch', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    delete (window as TauriVoicePaneTestWindow).__TAURI_INTERNALS__
    delete (window as TauriVoicePaneTestWindow).__PEBBLE_LOCAL_SPEECH_SUPPORTED__
    document.body.innerHTML = ''
  })

  beforeEach(() => {
    useAppStoreMock.mockReset()
    useShortcutLabelMock.mockReset()
  })

  it('clicking the switch marks the voice tip seen before disabling voice settings', async () => {
    const calls: string[] = []
    const requestMicrophonePermission = vi.fn()
    const updateVoiceSettings = vi.fn((updates: { enabled?: boolean }) => {
      calls.push(`settings:${String(updates.enabled)}`)
    })

    await handleVoiceDictationToggle({
      voiceEnabled: true,
      markFeatureTipsSeen: (ids) => calls.push(`seen:${ids.join(',')}`),
      updateVoiceSettings,
      requestMicrophonePermission
    })

    expect(calls).toEqual(['seen:voice-dictation', 'settings:false'])
    expect(updateVoiceSettings).toHaveBeenCalledWith({ enabled: false })
    expect(requestMicrophonePermission).not.toHaveBeenCalled()
  })

  it('clicking the switch marks the voice tip seen before the disable settings update', async () => {
    const calls: string[] = []
    const updateSettings = vi.fn((updates: Partial<GlobalSettings>) => {
      calls.push(`settings:${String(updates.voice?.enabled)}`)
    })
    const { button, root } = await renderVoicePane({
      voiceEnabled: true,
      markFeatureTipsSeen: (ids) => calls.push(`seen:${ids.join(',')}`),
      updateSettings,
      requestMicrophonePermission: vi.fn(async () => deniedMicrophoneResult)
    })

    await clickSwitch(button)
    root.unmount()

    expect(calls).toEqual(['seen:voice-dictation', 'settings:false'])
    expect(updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        voice: expect.objectContaining({ enabled: false })
      })
    )
    expect(window.api.developerPermissions.request).not.toHaveBeenCalled()
  })

  it('clicking the switch marks the voice tip seen before requesting microphone permission', async () => {
    const calls: string[] = []
    const updateSettings = vi.fn((updates: Partial<GlobalSettings>) => {
      calls.push(`settings:${String(updates.voice?.enabled)}`)
    })
    const { button, root } = await renderVoicePane({
      voiceEnabled: false,
      markFeatureTipsSeen: (ids) => calls.push(`seen:${ids.join(',')}`),
      updateSettings,
      requestMicrophonePermission: async () => {
        calls.push('permission-request')
        return deniedMicrophoneResult
      }
    })

    await clickSwitch(button)
    root.unmount()

    expect(calls).toEqual(['seen:voice-dictation', 'permission-request'])
    expect(updateSettings).not.toHaveBeenCalled()
  })

  it('marks the voice tip seen before requesting microphone permission when enabling is denied', async () => {
    const calls: string[] = []
    const updateVoiceSettings = vi.fn((updates: { enabled?: boolean }) => {
      calls.push(`settings:${String(updates.enabled)}`)
    })

    await handleVoiceDictationToggle({
      voiceEnabled: false,
      markFeatureTipsSeen: (ids) => calls.push(`seen:${ids.join(',')}`),
      updateVoiceSettings,
      requestMicrophonePermission: async () => {
        calls.push('permission-request')
        return deniedMicrophoneResult
      },
      setPermissionPending: (pending) => calls.push(`pending:${String(pending)}`),
      notifyPermissionRequired: () => calls.push('permission-required')
    })

    expect(calls).toEqual([
      'seen:voice-dictation',
      'pending:true',
      'permission-request',
      'permission-required',
      'pending:false'
    ])
    expect(updateVoiceSettings).not.toHaveBeenCalled()
  })

  it('does not record voice feature interaction from the settings switch', async () => {
    const recordFeatureInteraction = vi.fn()
    const { button, root } = await renderVoicePane({
      voiceEnabled: true,
      markFeatureTipsSeen: vi.fn(),
      updateSettings: vi.fn(),
      recordFeatureInteraction
    })

    await clickSwitch(button)
    root.unmount()

    expect(recordFeatureInteraction).not.toHaveBeenCalled()
  })

  it('leaves the initial model-state refresh to the Voice section owner', async () => {
    const updateSettings = vi.fn()
    const { refreshModelStates, root } = await renderVoicePane({
      voiceEnabled: false,
      markFeatureTipsSeen: vi.fn(),
      updateSettings
    })

    await act(async () => {
      root.render(<VoicePane settings={makeSettings(true)} updateSettings={updateSettings} />)
      await Promise.resolve()
    })

    expect(refreshModelStates).not.toHaveBeenCalled()
    expect(window.api.speech.getCatalog).toHaveBeenCalledTimes(1)
    expect(window.api.speech.getOpenAiApiKeyStatus).toHaveBeenCalledTimes(1)
    root.unmount()
  })

  it('refreshes model state once when authoritative API-key status changes', async () => {
    const updateSettings = vi.fn()
    const { refreshModelStates, root } = await renderVoicePane({
      voiceEnabled: false,
      markFeatureTipsSeen: vi.fn(),
      updateSettings,
      openAiApiKeyConfigured: true
    })

    expect(updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        voice: expect.objectContaining({ openAiApiKeyConfigured: true })
      })
    )
    expect(refreshModelStates).toHaveBeenCalledTimes(1)
    root.unmount()
  })

  it('keeps OpenAI dictation available in Tauri', async () => {
    ;(window as TauriVoicePaneTestWindow).__TAURI_INTERNALS__ = {}
    const updateSettings = vi.fn()
    const { button, root } = await renderVoicePane({
      voiceEnabled: false,
      markFeatureTipsSeen: vi.fn(),
      updateSettings,
      sttModel: 'openai-gpt-4o-mini-transcribe'
    })

    expect(button.disabled).toBe(false)
    root.unmount()
  })

  it('blocks local speech models only after native capability reports unavailable', async () => {
    ;(window as TauriVoicePaneTestWindow).__TAURI_INTERNALS__ = {}
    ;(window as TauriVoicePaneTestWindow).__PEBBLE_LOCAL_SPEECH_SUPPORTED__ = false
    const updateSettings = vi.fn()
    const { button, root, container } = await renderVoicePane({
      voiceEnabled: false,
      markFeatureTipsSeen: vi.fn(),
      updateSettings,
      sttModel: 'whisper-tiny'
    })

    expect(button.disabled).toBe(true)
    expect(container.textContent).toContain(
      'This Pebble build does not include local speech models. Choose an OpenAI model.'
    )

    await clickSwitch(button)
    root.unmount()

    expect(updateSettings).not.toHaveBeenCalled()
    expect(window.api.developerPermissions.request).not.toHaveBeenCalled()
  })
})
