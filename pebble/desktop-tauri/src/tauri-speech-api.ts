import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

import type { PreloadApi } from '../../../src/preload/api-types'
import type {
  SpeechErrorEvent,
  SpeechLifecycleEvent,
  SpeechModelManifest,
  SpeechModelState,
  SpeechTranscriptEvent
} from '../../../src/shared/speech-types'
import { SPEECH_MODEL_CATALOG, getCatalogModel } from '../../../src/main/speech/model-catalog'

// Why: the shortcut bridge applies the model-level provider check separately;
// this flag means at least one native dictation path is operational.
export const TAURI_SPEECH_AVAILABLE = true

export function isTauriSpeechModelAvailable(modelId: string): boolean {
  return getCatalogModel(modelId)?.provider === 'openai'
}

// Honest gap: cloud (OpenAI) dictation, key storage, and model downloads are
// native; local sherpa-onnx/whisper inference is not ported to the Tauri shell.
const TAURI_LOCAL_INFERENCE_UNAVAILABLE =
  'Local speech models are not available in the Tauri shell yet. Choose an OpenAI model.'

const DOWNLOAD_PROGRESS_EVENT = 'pebble:speech-download-progress'
const READY_EVENT = 'pebble:speech-ready'
const FINAL_TRANSCRIPT_EVENT = 'pebble:speech-final-transcript'
const STOPPED_EVENT = 'pebble:speech-stopped'
const ERROR_EVENT = 'pebble:speech-error'

const DEFAULT_SESSION_ID = 'desktop'

type SpeechListenerMap = {
  partial: SpeechTranscriptEvent
  final: SpeechTranscriptEvent
  downloadProgress: { modelId: string; progress: number }
  ready: SpeechLifecycleEvent
  stopped: SpeechLifecycleEvent
  error: SpeechErrorEvent
}

const speechListeners = {
  partial: new Set<(event: SpeechTranscriptEvent) => void>(),
  final: new Set<(event: SpeechTranscriptEvent) => void>(),
  downloadProgress: new Set<(event: { modelId: string; progress: number }) => void>(),
  ready: new Set<(event: SpeechLifecycleEvent) => void>(),
  stopped: new Set<(event: SpeechLifecycleEvent) => void>(),
  error: new Set<(event: SpeechErrorEvent) => void>()
}

let tauriSpeechEventsAttached = false

function ensureTauriSpeechEventListeners(): void {
  if (tauriSpeechEventsAttached) {
    return
  }
  tauriSpeechEventsAttached = true
  void listen<SpeechListenerMap['downloadProgress']>(DOWNLOAD_PROGRESS_EVENT, (event) =>
    emitSpeechEvent('downloadProgress', event.payload)
  )
  void listen<SpeechLifecycleEvent>(READY_EVENT, (event) => emitSpeechEvent('ready', event.payload))
  void listen<SpeechTranscriptEvent>(FINAL_TRANSCRIPT_EVENT, (event) =>
    emitSpeechEvent('final', event.payload)
  )
  void listen<SpeechLifecycleEvent>(STOPPED_EVENT, (event) =>
    emitSpeechEvent('stopped', event.payload)
  )
  void listen<SpeechErrorEvent>(ERROR_EVENT, (event) => emitSpeechEvent('error', event.payload))
}

function toModelStateProbes(): { id: string; provider: string; files: string[] }[] {
  return SPEECH_MODEL_CATALOG.map((manifest) => ({
    id: manifest.id,
    provider: manifest.provider,
    files: manifest.files ?? []
  }))
}

function requireDownloadableManifest(modelId: string): SpeechModelManifest {
  const manifest = getCatalogModel(modelId)
  if (!manifest) {
    throw new Error(`Unknown model: ${modelId}`)
  }
  if (
    manifest.provider !== 'local' ||
    !manifest.downloadUrl ||
    !manifest.archiveSha256 ||
    !manifest.files
  ) {
    throw new Error(`Model does not support downloads: ${modelId}`)
  }
  return manifest
}

export function encodeFloat32SamplesBase64(samples: Float32Array): string {
  // Why: Tauri invoke serializes typed arrays as plain JSON number arrays;
  // base64 of the raw little-endian bytes is far smaller per mic chunk.
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength)
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  return btoa(binary)
}

export function createPebbleSpeechApi(base: PreloadApi['speech']): PreloadApi['speech'] {
  return {
    ...base,
    getCatalog: () => Promise.resolve(SPEECH_MODEL_CATALOG),
    getModelStates: () =>
      invoke<SpeechModelState[]>('speech_get_model_states', { models: toModelStateProbes() }),
    getOpenAiApiKeyStatus: () => invoke<{ configured: boolean }>('speech_get_openai_key_status'),
    saveOpenAiApiKey: (apiKey) =>
      invoke<{ configured: boolean }>('speech_save_openai_key', { apiKey }),
    clearOpenAiApiKey: () => invoke<{ configured: boolean }>('speech_clear_openai_key'),
    downloadModel: (modelId) => {
      let manifest: SpeechModelManifest
      try {
        manifest = requireDownloadableManifest(modelId)
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)))
      }
      ensureTauriSpeechEventListeners()
      return invoke('speech_download_model', {
        input: {
          id: manifest.id,
          downloadUrl: manifest.downloadUrl,
          archiveSha256: manifest.archiveSha256,
          sizeBytes: manifest.sizeBytes ?? 0,
          files: manifest.files
        }
      })
    },
    cancelDownload: (modelId) => invoke('speech_cancel_download', { modelId }),
    deleteModel: (modelId) => invoke('speech_delete_model', { modelId }),
    // Why: hotwords only apply to local sherpa-onnx decoding, which is not
    // ported; the cloud path ignores them, matching Electron's OpenAI branch.
    startDictation: (modelId, _hotwords, sessionId) => {
      const manifest = getCatalogModel(modelId)
      if (manifest && manifest.provider !== 'openai') {
        return Promise.reject(new Error(TAURI_LOCAL_INFERENCE_UNAVAILABLE))
      }
      ensureTauriSpeechEventListeners()
      return invoke('speech_start_dictation', { modelId, sessionId })
    },
    feedAudio: (samples, sampleRate, sessionId = DEFAULT_SESSION_ID) =>
      invoke('speech_feed_audio', {
        sessionId,
        samplesBase64: encodeFloat32SamplesBase64(samples),
        sampleRate
      }),
    stopDictation: (sessionId = DEFAULT_SESSION_ID) => {
      ensureTauriSpeechEventListeners()
      return invoke('speech_stop_dictation', { sessionId })
    },
    onPartialTranscript: (callback) => subscribeSpeechEvent('partial', callback),
    onFinalTranscript: (callback) => subscribeSpeechEvent('final', callback),
    onDownloadProgress: (callback) => subscribeSpeechEvent('downloadProgress', callback),
    onReady: (callback) => subscribeSpeechEvent('ready', callback),
    onStopped: (callback) => subscribeSpeechEvent('stopped', callback),
    onError: (callback) => subscribeSpeechEvent('error', callback)
  }
}

function subscribeSpeechEvent<K extends keyof SpeechListenerMap>(
  event: K,
  callback: (data: SpeechListenerMap[K]) => void
): () => void {
  ensureTauriSpeechEventListeners()
  const listeners = speechListeners[event] as Set<(data: SpeechListenerMap[K]) => void>
  listeners.add(callback)
  return () => {
    listeners.delete(callback)
  }
}

function emitSpeechEvent<K extends keyof SpeechListenerMap>(
  event: K,
  payload: SpeechListenerMap[K]
): void {
  const listeners = speechListeners[event] as Set<(data: SpeechListenerMap[K]) => void>
  for (const listener of listeners) {
    listener(payload)
  }
}
