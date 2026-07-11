import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PreloadApi } from '../../../src/preload/api-types'
import { SPEECH_MODEL_CATALOG } from '../../../src/main/speech/model-catalog'

const { invokeMock, listenMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listenMock: vi.fn()
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: listenMock
}))

type SpeechApiModule = typeof import('./tauri-speech-api')

const eventHandlers = new Map<string, (event: { payload: unknown }) => void>()

async function loadSpeechApi(): Promise<PreloadApi['speech'] & SpeechApiModule> {
  // Why: the bridge keeps module-level listener state; a fresh module per test
  // keeps the Tauri listen() registrations observable.
  const module = (await import('./tauri-speech-api')) as SpeechApiModule
  return Object.assign(module.createPebbleSpeechApi({} as PreloadApi['speech']), module)
}

beforeEach(() => {
  vi.resetModules()
  invokeMock.mockReset().mockResolvedValue(undefined)
  listenMock.mockReset().mockImplementation((event: string, handler: never) => {
    eventHandlers.set(event, handler)
    return Promise.resolve(() => {})
  })
  eventHandlers.clear()
})

describe('createPebbleSpeechApi', () => {
  it('returns the canonical catalog and probes native model states', async () => {
    const api = await loadSpeechApi()
    invokeMock.mockResolvedValue([{ id: 'whisper-tiny', status: 'not-downloaded' }])

    await expect(api.getCatalog()).resolves.toEqual(SPEECH_MODEL_CATALOG)
    await expect(api.getModelStates()).resolves.toEqual([
      { id: 'whisper-tiny', status: 'not-downloaded' }
    ])
    expect(invokeMock).toHaveBeenCalledWith('speech_get_model_states', {
      models: SPEECH_MODEL_CATALOG.map((manifest) => ({
        id: manifest.id,
        provider: manifest.provider,
        files: manifest.files ?? []
      }))
    })
  })

  it('routes OpenAI key management to native commands', async () => {
    const api = await loadSpeechApi()
    invokeMock.mockResolvedValue({ configured: true })

    await expect(api.getOpenAiApiKeyStatus()).resolves.toEqual({ configured: true })
    await expect(api.saveOpenAiApiKey('sk-test')).resolves.toEqual({ configured: true })
    await api.clearOpenAiApiKey()

    expect(invokeMock).toHaveBeenCalledWith('speech_get_openai_key_status')
    expect(invokeMock).toHaveBeenCalledWith('speech_save_openai_key', { apiKey: 'sk-test' })
    expect(invokeMock).toHaveBeenCalledWith('speech_clear_openai_key')
  })

  it('passes the catalog manifest to native model downloads', async () => {
    const api = await loadSpeechApi()
    const manifest = SPEECH_MODEL_CATALOG.find((m) => m.id === 'whisper-tiny')!

    await api.downloadModel('whisper-tiny')
    expect(invokeMock).toHaveBeenCalledWith('speech_download_model', {
      input: {
        id: manifest.id,
        downloadUrl: manifest.downloadUrl,
        archiveSha256: manifest.archiveSha256,
        sizeBytes: manifest.sizeBytes,
        files: manifest.files
      }
    })

    await api.cancelDownload('whisper-tiny')
    expect(invokeMock).toHaveBeenCalledWith('speech_cancel_download', { modelId: 'whisper-tiny' })
    await api.deleteModel('whisper-tiny')
    expect(invokeMock).toHaveBeenCalledWith('speech_delete_model', { modelId: 'whisper-tiny' })
  })

  it('rejects downloads for unknown and cloud models without invoking', async () => {
    const api = await loadSpeechApi()

    await expect(api.downloadModel('nope')).rejects.toThrow('Unknown model: nope')
    await expect(api.downloadModel('openai-gpt-4o-transcribe')).rejects.toThrow(
      'Model does not support downloads'
    )
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('starts cloud dictation natively without probing local capability', async () => {
    const api = await loadSpeechApi()

    await api.startDictation('openai-gpt-4o-mini-transcribe', undefined, 'session-1')
    expect(invokeMock).toHaveBeenCalledWith('speech_start_dictation', {
      modelId: 'openai-gpt-4o-mini-transcribe',
      sessionId: 'session-1'
    })
    expect(invokeMock).not.toHaveBeenCalledWith('speech_local_inference_supported')
  })

  it('routes local models natively when the Rust build carries the engine', async () => {
    const api = await loadSpeechApi()
    invokeMock.mockImplementation((command: string) =>
      Promise.resolve(command === 'speech_local_inference_supported' ? true : undefined)
    )
    const manifest = SPEECH_MODEL_CATALOG.find((m) => m.id === 'whisper-tiny')!

    await api.startDictation('whisper-tiny', [], 'session-2')
    expect(invokeMock).toHaveBeenCalledWith('speech_start_dictation', {
      modelId: 'whisper-tiny',
      sessionId: 'session-2',
      localModel: {
        modelType: manifest.type,
        streaming: manifest.streaming,
        sampleRate: manifest.sampleRate,
        files: manifest.files
      }
    })
  })

  it('keeps the typed local-inference gap when the engine is absent or unprobeable', async () => {
    const api = await loadSpeechApi()
    invokeMock.mockImplementation((command: string) =>
      command === 'speech_local_inference_supported'
        ? Promise.resolve(false)
        : Promise.resolve(undefined)
    )
    await expect(api.startDictation('whisper-tiny', [], 'session-2')).rejects.toThrow(
      'Local speech models are not available in the Tauri shell yet'
    )
    expect(invokeMock).not.toHaveBeenCalledWith('speech_start_dictation', expect.anything())

    // Older Rust binaries without the probe command must fail closed too.
    vi.resetModules()
    const staleApi = await loadSpeechApi()
    invokeMock.mockImplementation((command: string) =>
      command === 'speech_local_inference_supported'
        ? Promise.reject(new Error('unknown command'))
        : Promise.resolve(undefined)
    )
    await expect(staleApi.startDictation('whisper-tiny', [], 'session-3')).rejects.toThrow(
      'Local speech models are not available in the Tauri shell yet'
    )
  })

  it('feeds audio as base64 little-endian float32 and stops with a default session', async () => {
    const api = await loadSpeechApi()
    const samples = new Float32Array([0, 0.5, -1])

    await api.feedAudio(samples, 48_000, 'session-1')
    expect(invokeMock).toHaveBeenCalledWith('speech_feed_audio', {
      sessionId: 'session-1',
      samplesBase64: api.encodeFloat32SamplesBase64(samples),
      sampleRate: 48_000
    })

    const decoded = Uint8Array.from(atob(api.encodeFloat32SamplesBase64(samples)), (c) =>
      c.charCodeAt(0)
    )
    expect(new Float32Array(decoded.buffer)).toEqual(samples)

    await api.stopDictation()
    expect(invokeMock).toHaveBeenCalledWith('speech_stop_dictation', { sessionId: 'desktop' })
  })

  it('dispatches native speech events to subscribers until unsubscribed', async () => {
    const api = await loadSpeechApi()
    const onPartial = vi.fn()
    const onFinal = vi.fn()
    const onProgress = vi.fn()
    const onStopped = vi.fn()

    const unsubscribeFinal = api.onFinalTranscript(onFinal)
    api.onPartialTranscript(onPartial)
    api.onDownloadProgress(onProgress)
    api.onStopped(onStopped)
    await Promise.resolve()

    eventHandlers.get('pebble:speech-partial-transcript')?.({
      payload: { text: 'hel', sessionId: 'session-1' }
    })
    eventHandlers.get('pebble:speech-final-transcript')?.({
      payload: { text: 'hello', sessionId: 'session-1' }
    })
    eventHandlers.get('pebble:speech-download-progress')?.({
      payload: { modelId: 'whisper-tiny', progress: 0.5 }
    })
    eventHandlers.get('pebble:speech-stopped')?.({ payload: { sessionId: 'session-1' } })

    expect(onPartial).toHaveBeenCalledWith({ text: 'hel', sessionId: 'session-1' })
    expect(onFinal).toHaveBeenCalledWith({ text: 'hello', sessionId: 'session-1' })
    expect(onProgress).toHaveBeenCalledWith({ modelId: 'whisper-tiny', progress: 0.5 })
    expect(onStopped).toHaveBeenCalledWith({ sessionId: 'session-1' })

    unsubscribeFinal()
    eventHandlers.get('pebble:speech-final-transcript')?.({
      payload: { text: 'again', sessionId: 'session-1' }
    })
    expect(onFinal).toHaveBeenCalledTimes(1)
  })
})
