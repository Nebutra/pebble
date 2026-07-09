import type { PreloadApi } from '../../../src/preload/api-types'

// Derived from the preflight API so the runtime route and renderer contract
// never drift; the Go runtime serves these exact JSON field names (see
// internal/hostprobe/capabilities.go TerminalCapabilities).
export type HostTerminalCapabilities = Awaited<
  ReturnType<PreloadApi['preflight']['detectRemoteWindowsTerminalCapabilities']>
>

const EMPTY_HOST_TERMINAL_CAPABILITIES: HostTerminalCapabilities = {
  wslAvailable: false,
  wslDistros: [],
  pwshAvailable: false,
  gitBashAvailable: false,
  hostPlatform: null
}

type RuntimeJsonFetcher = <T>(
  path: string,
  options: { method: 'GET'; timeoutMs?: number }
) => Promise<T>

// pwsh.exe/wsl.exe cold starts can be slow; give the probe room but still bound
// it so a wedged host cannot hang the terminal profile picker.
const HOST_TERMINAL_CAPABILITIES_TIMEOUT_MS = 8000

/**
 * Fetch the runtime host's WSL/pwsh/Git-Bash capabilities.
 *
 * The Go runtime probes whichever host it executes on — local or the SSH-remote
 * runtime — so its answer is exactly what the terminal profiles need. On any
 * failure we return the empty shape rather than falsely advertising shells that
 * are not installed.
 */
export async function readHostTerminalCapabilities(
  fetchRuntimeJson: RuntimeJsonFetcher
): Promise<HostTerminalCapabilities> {
  try {
    const caps = await fetchRuntimeJson<Partial<HostTerminalCapabilities>>(
      '/v1/host/terminal-capabilities',
      { method: 'GET', timeoutMs: HOST_TERMINAL_CAPABILITIES_TIMEOUT_MS }
    )
    return {
      wslAvailable: caps.wslAvailable ?? false,
      wslDistros: caps.wslDistros ?? [],
      pwshAvailable: caps.pwshAvailable ?? false,
      gitBashAvailable: caps.gitBashAvailable ?? false,
      hostPlatform: caps.hostPlatform ?? null
    }
  } catch {
    return EMPTY_HOST_TERMINAL_CAPABILITIES
  }
}
