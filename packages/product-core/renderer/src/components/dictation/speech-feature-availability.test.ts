// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import {
  getVoiceDictationUnavailableReason,
  TAURI_VOICE_DICTATION_UNAVAILABLE_REASON
} from './speech-feature-availability'

type TauriSpeechTestWindow = Window & {
  __TAURI_INTERNALS__?: unknown
  __PEBBLE_LOCAL_SPEECH_SUPPORTED__?: boolean
}

describe('speech feature availability', () => {
  afterEach(() => {
    delete (window as TauriSpeechTestWindow).__TAURI_INTERNALS__
    delete (window as TauriSpeechTestWindow).__PEBBLE_LOCAL_SPEECH_SUPPORTED__
  })

  it('leaves Electron voice dictation available', () => {
    expect(getVoiceDictationUnavailableReason()).toBeNull()
  })

  it('keeps Tauri OpenAI dictation available', () => {
    ;(window as TauriSpeechTestWindow).__TAURI_INTERNALS__ = {}

    expect(getVoiceDictationUnavailableReason('openai-gpt-4o-mini-transcribe')).toBeNull()
  })

  it('allows a local model while native capability is unresolved', () => {
    ;(window as TauriSpeechTestWindow).__TAURI_INTERNALS__ = {}

    expect(getVoiceDictationUnavailableReason('whisper-tiny')).toBeNull()
  })

  it('blocks a local model after native capability is definitively absent', () => {
    ;(window as TauriSpeechTestWindow).__TAURI_INTERNALS__ = {}
    ;(window as TauriSpeechTestWindow).__PEBBLE_LOCAL_SPEECH_SUPPORTED__ = false

    expect(getVoiceDictationUnavailableReason('whisper-tiny')).toBe(
      TAURI_VOICE_DICTATION_UNAVAILABLE_REASON
    )
  })
})
