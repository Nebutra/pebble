const PRODUCTION_RUNTIME_URL = 'http://127.0.0.1:17777'

export type LocalRuntimeEndpoint = {
  url: string
  listen: string
  dataDir: string | null
}

export function resolveLocalRuntimeEndpoint(
  configuredUrl: string | undefined,
  configuredDataDir: string | undefined
): LocalRuntimeEndpoint {
  const rawUrl = configuredUrl?.trim() || PRODUCTION_RUNTIME_URL
  const url = new URL(rawUrl)
  if (url.protocol !== 'http:' || !isLoopbackHost(url.hostname)) {
    // Why: the desktop-owned runtime has local-machine authority and must never
    // become reachable from another host through a build-time override.
    throw new Error('Pebble runtime URL must use HTTP on a loopback host.')
  }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Pebble runtime URL must contain only a loopback origin.')
  }
  const port = url.port || '80'
  return {
    url: `http://${formatUrlHost(url.hostname)}:${port}`,
    listen: `${formatListenHost(url.hostname)}:${port}`,
    dataDir: configuredDataDir?.trim() || null
  }
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
}

function formatUrlHost(hostname: string): string {
  return hostname === '::1' ? '[::1]' : hostname
}

function formatListenHost(hostname: string): string {
  return hostname === '[::1]' || hostname === '::1' ? '[::1]' : hostname
}

export const LOCAL_RUNTIME_ENDPOINT = resolveLocalRuntimeEndpoint(
  import.meta.env.VITE_PEBBLE_RUNTIME_URL,
  import.meta.env.VITE_PEBBLE_RUNTIME_DATA_DIR
)
