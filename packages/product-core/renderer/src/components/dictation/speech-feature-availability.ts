import { isPebbleTauriShell } from '@/lib/tauri-shell-detection'

export const TAURI_VOICE_DICTATION_UNAVAILABLE_REASON =
  'This Pebble build does not include local speech models. Choose an OpenAI model.'

export function getVoiceDictationUnavailableReason(modelId?: string | null): string | null {
  const shellWindow = window as Window & { __PEBBLE_LOCAL_SPEECH_SUPPORTED__?: boolean }
  if (
    isPebbleTauriShell() &&
    modelId &&
    !modelId.startsWith('openai-') &&
    shellWindow.__PEBBLE_LOCAL_SPEECH_SUPPORTED__ === false
  ) {
    // Why: an unresolved probe is allowed to reach startDictation, which awaits
    // native capability. Only a definitive negative should disable capture.
    return TAURI_VOICE_DICTATION_UNAVAILABLE_REASON
  }
  return null
}
