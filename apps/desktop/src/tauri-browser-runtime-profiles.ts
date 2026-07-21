import { invoke } from '@tauri-apps/api/core'

import type {
  BrowserApi,
  DetectedBrowserInfo
} from '../../../packages/product-core/shared/browser-api-types'
import { PEBBLE_BROWSER_PARTITION } from '../../../packages/product-core/shared/constants'
import type { BrowserSessionProfile } from '../../../packages/product-core/shared/types'
import {
  createNativeProviderRegistrationInput,
  createRuntimeResourceGetCommand,
  createRuntimeResourceRequestCommand,
  getRuntimeResourceJson,
  registerNativeProvider,
  requestRuntimeResourceJson
} from './runtime-bridge'
import type { RuntimeResourceGetResult } from './runtime-command-shapes'
import { cancelNativeTauriBrowserDownload } from './tauri-browser-runtime-events'

type RuntimeBrowserProfile = {
  id: string
  name: string
  persistent?: boolean
}

type RuntimeBrowserDownload = {
  id: string
  status?: 'queued' | 'inProgress' | 'completed' | 'canceled' | 'failed'
}

const DEFAULT_PROFILE: BrowserSessionProfile = {
  id: 'default',
  scope: 'default',
  partition: PEBBLE_BROWSER_PARTITION,
  label: 'Default',
  source: null
}

export const TAURI_BROWSER_GUEST_UNAVAILABLE =
  'Full CDP inspection parity is still being migrated to the native Tauri browser adapter.'

let browserProviderRefreshStarted = false

export function getTauriNativeScreenshotCapabilities(userAgent: string): string[] {
  return userAgent.includes('Mac') || userAgent.includes('Windows') || userAgent.includes('Linux')
    ? ['native-screenshot']
    : []
}

export function getTauriNativeDownloadCapabilities(userAgent: string): string[] {
  return [
    'native-download-progress',
    ...(userAgent.includes('Mac') || userAgent.includes('Windows') || userAgent.includes('Linux')
      ? ['native-download-cancel']
      : [])
  ]
}

export async function listTauriBrowserSessionProfiles(): Promise<BrowserSessionProfile[]> {
  const profiles = await requestRuntimeJson<RuntimeBrowserProfile[]>('GET', '/v1/browser/profiles')
  return [DEFAULT_PROFILE, ...profiles.map((profile) => mapRuntimeProfile(profile, 'isolated'))]
}

export async function createTauriBrowserSessionProfile(
  args: Parameters<BrowserApi['sessionCreateProfile']>[0]
): Promise<BrowserSessionProfile | null> {
  if (args.scope === 'default') {
    return null
  }
  const profile = await requestRuntimeJson<RuntimeBrowserProfile>('POST', '/v1/browser/profiles', {
    name: args.label,
    persistent: true
  })
  return mapRuntimeProfile(profile, args.scope)
}

export async function deleteTauriBrowserSessionProfile(args: {
  profileId: string
}): Promise<boolean> {
  if (args.profileId === DEFAULT_PROFILE.id) {
    return false
  }
  await deleteTauriBrowserProfileStorage(args.profileId)
  await requestRuntimeJson<RuntimeBrowserProfile>(
    'DELETE',
    `/v1/browser/profiles/${encodeURIComponent(args.profileId)}`
  )
  return true
}

export async function deleteTauriBrowserProfileStorage(profileId: string): Promise<void> {
  const profileKey = browserProfilePartition(profileId).replace(/^persist:/, '')
  await invoke<boolean>('browser_profile_storage_delete', { profileKey })
}

export async function resolveTauriBrowserSessionPartition(args: {
  profileId: string | null
}): Promise<string | null> {
  if (!args.profileId || args.profileId === DEFAULT_PROFILE.id) {
    return PEBBLE_BROWSER_PARTITION
  }
  const profiles = await listTauriBrowserSessionProfiles()
  return (
    profiles.find((profile) => profile.id === args.profileId)?.partition ?? PEBBLE_BROWSER_PARTITION
  )
}

export async function cancelTauriBrowserDownload(args: { downloadId: string }): Promise<boolean> {
  const nativeCanceled = await cancelNativeTauriBrowserDownload(args.downloadId)
  if (nativeCanceled === false) {
    return false
  }
  await requestRuntimeJson<RuntimeBrowserDownload>(
    'PATCH',
    `/v1/browser/downloads/${encodeURIComponent(args.downloadId)}`,
    { status: 'canceled' }
  )
  return true
}

export function detectTauriBrowserSessionBrowsers(): Promise<DetectedBrowserInfo[]> {
  return invoke<DetectedBrowserInfo[]>('browser_detect_installed_browsers')
}

export function ensureTauriBrowserProviderRefresh(): void {
  if (browserProviderRefreshStarted) {
    return
  }
  browserProviderRefreshStarted = true
  void registerBrowserProvider()
  window.setInterval(() => void registerBrowserProvider(), 60_000)
}

async function registerBrowserProvider(): Promise<void> {
  await registerNativeProvider(
    createNativeProviderRegistrationInput({
      id: 'browser:tauri-desktop-runtime',
      subsystem: 'browser',
      name: 'Pebble Tauri browser runtime bridge',
      status: 'degraded',
      capabilities: [
        'runtime-browser-profiles',
        'runtime-browser-events',
        'native-webview',
        'native-profile-isolation',
        'native-element-grab',
        'native-annotation-selection',
        'native-find-in-page',
        'native-annotation-overlay',
        'native-cookie-clear',
        'native-cookie-file-import',
        'native-firefox-cookie-import',
        'native-safari-cookie-import',
        'native-chromium-cookie-import',
        'document-media-emulation',
        'native-device-viewport',
        'document-device-emulation',
        'native-request-user-agent',
        'native-top-level-interception',
        'document-fetch-xhr-headers',
        'document-fetch-xhr-offline',
        'document-fetch-xhr-basic-auth',
        'native-download-start-finish',
        ...getTauriNativeDownloadCapabilities(navigator.userAgent),
        ...getTauriNativeScreenshotCapabilities(navigator.userAgent)
      ],
      message: TAURI_BROWSER_GUEST_UNAVAILABLE
    })
  ).catch(() => undefined)
}

function mapRuntimeProfile(
  profile: RuntimeBrowserProfile,
  scope: BrowserSessionProfile['scope']
): BrowserSessionProfile {
  return {
    id: profile.id,
    scope,
    partition: browserProfilePartition(profile.id),
    label: profile.name || 'Browser Profile',
    source: null
  }
}

function browserProfilePartition(profileId: string): string {
  return `persist:pebble-browser-session-${profileId.replace(/[^a-zA-Z0-9_-]/g, '-')}`
}

async function requestRuntimeJson<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
  timeoutMs = 1500
): Promise<T> {
  const result =
    method === 'GET'
      ? await getRuntimeResourceJson(createRuntimeResourceGetCommand({ path, timeoutMs }))
      : await requestRuntimeResourceJson(
          createRuntimeResourceRequestCommand({
            method,
            path,
            bodyJson: body === undefined ? null : JSON.stringify(body),
            timeoutMs
          })
        )
  return parseRuntimeResourceResult<T>(result)
}

function parseRuntimeResourceResult<T>(result: RuntimeResourceGetResult): T {
  if (result.transport !== 'connected') {
    throw new Error(result.error ?? `Runtime transport failed: ${result.transport}`)
  }
  if (result.httpStatus !== null && (result.httpStatus < 200 || result.httpStatus > 299)) {
    throw new Error(result.body ?? `Runtime request failed with HTTP ${result.httpStatus}`)
  }
  return result.body ? (JSON.parse(result.body) as T) : ({} as T)
}
