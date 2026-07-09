import type { PreloadApi } from '../../../src/preload/api-types'
import type {
  SpeechErrorEvent,
  SpeechLifecycleEvent,
  SpeechModelState,
  SpeechTranscriptEvent
} from '../../../src/shared/speech-types'
import { SPEECH_MODEL_CATALOG } from '../../../src/main/speech/model-catalog'

const TAURI_SPEECH_UNAVAILABLE = 'Voice dictation is not migrated to the Tauri shell yet.'

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

function getUnavailableModelStates(): SpeechModelState[] {
  return SPEECH_MODEL_CATALOG.map((manifest) => ({
    id: manifest.id,
    status: 'error',
    error: TAURI_SPEECH_UNAVAILABLE
  }))
}

export function createPebbleSpeechApi(base: PreloadApi['speech']): PreloadApi['speech'] {
  return {
    ...base,
    getCatalog: () => Promise.resolve(SPEECH_MODEL_CATALOG),
    getModelStates: () => Promise.resolve(getUnavailableModelStates()),
    getOpenAiApiKeyStatus: () => Promise.resolve({ configured: false }),
    saveOpenAiApiKey: () => Promise.reject(new Error(TAURI_SPEECH_UNAVAILABLE)),
    clearOpenAiApiKey: () => Promise.resolve({ configured: false }),
    downloadModel: () => Promise.reject(new Error(TAURI_SPEECH_UNAVAILABLE)),
    cancelDownload: () => Promise.resolve(),
    deleteModel: () => Promise.resolve(),
    startDictation: () => Promise.reject(new Error(TAURI_SPEECH_UNAVAILABLE)),
    feedAudio: () => Promise.reject(new Error(TAURI_SPEECH_UNAVAILABLE)),
    stopDictation: (sessionId = 'desktop') => {
      emitSpeechEvent('stopped', { sessionId })
      return Promise.resolve()
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
