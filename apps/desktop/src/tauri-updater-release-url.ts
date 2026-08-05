// URL and status-message formatting split out of tauri-updater-api.ts so the
// updater orchestration module stays focused on state transitions.
export function releaseUrlForVersion(version: string): string {
  return `https://github.com/nebutra/pebble/releases/tag/v${version}`
}

const NETWORK_ERROR_PATTERN =
  /error sending request|timed?\s*out|timeout|connection|connect|dns|network|tls|ssl|reset by peer|name resolution|proxy/i

/** Manual installer surface when in-app update cannot reach release hosts. */
export const PEBBLE_DOWNLOAD_PAGE_URL = 'https://pebble.nebutra.com/download'

export function describeTauriUpdaterUnavailable(
  pluginError: string,
  releaseMessage?: string
): string {
  const details = releaseMessage ? ` Release feed status: ${releaseMessage}` : ''
  const combined = `${pluginError} ${releaseMessage ?? ''}`
  const networkHint = NETWORK_ERROR_PATTERN.test(combined)
    ? ` Network to the update host may be blocked or slow — retry, enable system proxy/TUN, or install from ${PEBBLE_DOWNLOAD_PAGE_URL}.`
    : ''
  return `Signed Tauri updater is not ready: ${pluginError}.${details}${networkHint}`
}
