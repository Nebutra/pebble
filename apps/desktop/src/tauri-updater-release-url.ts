// URL and status-message formatting split out of tauri-updater-api.ts so the
// updater orchestration module stays focused on state transitions.
export function releaseUrlForVersion(version: string): string {
  return `https://github.com/nebutra/pebble/releases/tag/v${version}`
}

export function describeTauriUpdaterUnavailable(
  pluginError: string,
  releaseMessage?: string
): string {
  const details = releaseMessage ? ` Release feed status: ${releaseMessage}` : ''
  return `Signed Tauri updater is not ready: ${pluginError}.${details}`
}
