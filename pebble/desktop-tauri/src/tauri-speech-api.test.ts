import { describe, expect, it, vi } from 'vitest'
import type { PreloadApi } from '../../../src/preload/api-types'
import { SPEECH_MODEL_CATALOG } from '../../../src/main/speech/model-catalog'
import { createPebbleSpeechApi } from './tauri-speech-api'

describe('createPebbleSpeechApi', () => {
  it('returns the canonical catalog with explicit unavailable model states', async () => {
    const api = createPebbleSpeechApi({} as PreloadApi['speech'])

    await expect(api.getCatalog()).resolves.toEqual(SPEECH_MODEL_CATALOG)
    await expect(api.getModelStates()).resolves.toEqual(
      SPEECH_MODEL_CATALOG.map((manifest) => ({
        id: manifest.id,
        status: 'error',
        error: 'Voice dictation is not migrated to the Tauri shell yet.'
      }))
    )
    await expect(api.getOpenAiApiKeyStatus()).resolves.toEqual({ configured: false })
  })

  it('registers speech listeners and emits stop lifecycle events', async () => {
    const api = createPebbleSpeechApi({} as PreloadApi['speech'])
    const stopped = vi.fn()

    const unsubscribe = api.onStopped(stopped)
    await api.stopDictation('session-1')
    unsubscribe()
    await api.stopDictation('session-2')

    expect(stopped).toHaveBeenCalledTimes(1)
    expect(stopped).toHaveBeenCalledWith({ sessionId: 'session-1' })
  })

  it('fails mutating dictation actions explicitly until the Tauri speech adapter exists', async () => {
    const api = createPebbleSpeechApi({} as PreloadApi['speech'])

    await expect(api.startDictation('model', [], 'session')).rejects.toThrow(
      'Voice dictation is not migrated'
    )
    await expect(api.downloadModel('model')).rejects.toThrow('Voice dictation is not migrated')
    await expect(api.stopDictation('session')).resolves.toBeUndefined()
  })
})
