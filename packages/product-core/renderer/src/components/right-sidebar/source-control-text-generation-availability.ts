export const TAURI_SOURCE_CONTROL_TEXT_GENERATION_UNAVAILABLE_REASON =
  'Source Control AI generation requires the native Tauri text-generation host.'

export function getSourceControlTextGenerationUnavailableReason(): string | null {
  // Tauri now provides a native local text-generation host. SSH relay parity is
  // still handled by the git API response so local buttons remain usable.
  return null
}
