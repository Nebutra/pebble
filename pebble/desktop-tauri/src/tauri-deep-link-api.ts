import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'

const DEEP_LINK_EVENT = 'pebble:deep-link'
const DEFAULT_RUNTIME_NAME = 'Pebble Server'
const handledDeepLinks = new Set<string>()

export function installTauriDeepLinkApi(): void {
  if (!hasTauriInternals()) {
    return
  }

  void invoke<string[]>('deep_link_initial_urls')
    .then((urls) => {
      for (const url of urls) {
        void handlePebbleDeepLink(url)
      }
    })
    .catch(() => undefined)

  void listen<string>(DEEP_LINK_EVENT, (event) => {
    void handlePebbleDeepLink(event.payload)
  })
}

async function handlePebbleDeepLink(url: string): Promise<void> {
  const normalized = url.trim()
  if (!normalized || handledDeepLinks.has(normalized)) {
    return
  }
  if (!isPairingDeepLink(normalized)) {
    toast.error(translate('tauri.deepLink.unsupported', 'This Pebble link is not supported yet.'))
    return
  }

  handledDeepLinks.add(normalized)
  try {
    const name = await createUniqueRuntimeName(normalized)
    const result = await window.api.runtimeEnvironments.addFromPairingCode({
      name,
      pairingCode: normalized
    })
    const environments = await window.api.runtimeEnvironments.list()
    const state = useAppStore.getState()
    state.setRuntimeEnvironments(environments)
    await state.refreshRuntimeEnvironmentStatus(result.environment.id)
    toast.success(translate('tauri.deepLink.runtimeAdded', 'Remote server added.'))
  } catch (error) {
    handledDeepLinks.delete(normalized)
    toast.error(error instanceof Error ? error.message : String(error))
  }
}

function isPairingDeepLink(value: string): boolean {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'pebble:' && parsed.hostname === 'pair'
  } catch {
    return false
  }
}

async function createUniqueRuntimeName(pairingUrl: string): Promise<string> {
  const baseName = getRuntimeNameFromPairingUrl(pairingUrl)
  const environments = await window.api.runtimeEnvironments.list()
  const existingNames = new Set(environments.map((environment) => environment.name))
  if (!existingNames.has(baseName)) {
    return baseName
  }
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${baseName} ${suffix}`
    if (!existingNames.has(candidate)) {
      return candidate
    }
  }
  return `${baseName} ${Date.now()}`
}

function getRuntimeNameFromPairingUrl(pairingUrl: string): string {
  const endpoint = parsePairingEndpoint(pairingUrl)
  if (!endpoint) {
    return DEFAULT_RUNTIME_NAME
  }
  try {
    const url = new URL(endpoint)
    return url.hostname ? `Pebble ${url.hostname}` : DEFAULT_RUNTIME_NAME
  } catch {
    return DEFAULT_RUNTIME_NAME
  }
}

function parsePairingEndpoint(pairingUrl: string): string | null {
  const code = extractPairingCode(pairingUrl)
  if (!code) {
    return null
  }
  try {
    const json = new TextDecoder().decode(base64UrlToBytes(code))
    const parsed = JSON.parse(json) as { endpoint?: unknown }
    return typeof parsed.endpoint === 'string' && parsed.endpoint.trim() ? parsed.endpoint : null
  } catch {
    return null
  }
}

function extractPairingCode(pairingUrl: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(pairingUrl)
  } catch {
    return null
  }
  if (parsed.protocol !== 'pebble:' || parsed.hostname !== 'pair') {
    return null
  }
  const queryCode = parsed.searchParams.get('code')
  if (queryCode?.trim()) {
    return queryCode.trim()
  }
  return parsed.hash ? parsed.hash.slice(1).trim() || null : null
}

function base64UrlToBytes(value: string): Uint8Array {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
  const binary = globalThis.atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

function hasTauriInternals(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}
