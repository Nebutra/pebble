import { invoke } from '@tauri-apps/api/core'

import type { PreloadApi } from '../../../packages/product-core/shared/preload-api-types'
import { buildNotificationOptions } from '../../../packages/product-core/shared/notification-options'
import type {
  NotificationDispatchRequest,
  NotificationDispatchResult,
  NotificationPermissionStatusResult
} from '../../../packages/product-core/shared/types'
import { hasTauriInternals } from './pebble-runtime-http-bridge'
import { requestRuntimeJson } from './pebble-tauri-runtime-transport'
import beepSoundUrl from '../../../resources/notification-sounds/beep.mp3?url'
import blipSoundUrl from '../../../resources/notification-sounds/blip.mp3?url'
import blopSoundUrl from '../../../resources/notification-sounds/blop.mp3?url'
import bongSoundUrl from '../../../resources/notification-sounds/bong.mp3?url'
import clackSoundUrl from '../../../resources/notification-sounds/clack.mp3?url'
import dingSoundUrl from '../../../resources/notification-sounds/ding.mp3?url'
import sonarSoundUrl from '../../../resources/notification-sounds/sonar.mp3?url'
import thumpSoundUrl from '../../../resources/notification-sounds/thump.mp3?url'
import twoToneSoundUrl from '../../../resources/notification-sounds/two-tone.mp3?url'

type NotificationsApi = NonNullable<Partial<PreloadApi>['notifications']>

type NativeShowResult = { delivered: boolean; reason?: string }
type NativePermissionResult = { granted: boolean; state: string }
type NativeSoundData = { dataBase64: string; mimeType: string }

const BUILT_IN_SOUND_URLS = new Map<string, string>([
  ['two-tone', twoToneSoundUrl],
  ['bong', bongSoundUrl],
  ['thump', thumpSoundUrl],
  ['blip', blipSoundUrl],
  ['sonar', sonarSoundUrl],
  ['blop', blopSoundUrl],
  ['ding', dingSoundUrl],
  ['clack', clackSoundUrl],
  ['beep', beepSoundUrl]
])
let activeSound: HTMLAudioElement | null = null
let activeSoundObjectUrl: string | null = null

function hostPlatform(): NodeJS.Platform {
  const userAgent = navigator.userAgent.toLowerCase()
  if (userAgent.includes('windows')) {
    return 'win32'
  }
  if (userAgent.includes('mac')) {
    return 'darwin'
  }
  return 'linux'
}

// Map a native show failure onto the renderer's NotificationDispatchResult
// reason vocabulary. `permission-not-granted` and any raw plugin error both
// surface as `not-displayed` so the caller knows the toast did not appear.
function dispatchReasonFrom(result: NativeShowResult): NotificationDispatchResult {
  if (result.delivered) {
    return { delivered: true }
  }
  return { delivered: false, reason: 'not-displayed' }
}

async function dispatch(args: NotificationDispatchRequest): Promise<NotificationDispatchResult> {
  if (!hasTauriInternals()) {
    return { delivered: false, reason: 'not-supported' }
  }
  // Reuse the Electron notification builder so title/body match the desktop app.
  const options = buildNotificationOptions(args)
  if (args.source !== 'test') {
    // Why: mobile notification delivery is runtime-owned; publish the exact
    // desktop title/body after the shared Electron formatter applies context.
    void requestRuntimeJson('/v1/notifications/dispatch', {
      method: 'POST',
      body: {
        type: 'notification',
        source: args.source,
        title: options.title,
        body: options.body,
        ...(args.worktreeId ? { worktreeId: args.worktreeId } : {}),
        ...(args.notificationId ? { notificationId: args.notificationId } : {})
      }
    }).catch(() => undefined)
  }
  const result = await invoke<NativeShowResult>('show_native_notification', {
    input: { title: options.title, body: options.body }
  }).catch(() => ({ delivered: false, reason: 'invoke-failed' }) satisfies NativeShowResult)
  return dispatchReasonFrom(result)
}

async function dismiss(ids: string[]) {
  const uniqueIds = [...new Set(ids.map((id) => id.trim()).filter(Boolean))]
  await Promise.all(
    uniqueIds.map((notificationId) =>
      requestRuntimeJson('/v1/notifications/dispatch', {
        method: 'POST',
        body: { type: 'dismiss', notificationId }
      }).catch(() => undefined)
    )
  )
  // Why: tauri-plugin-notification exposes no handle cancellation API. Mobile
  // dismiss is real, while zero truthfully reports that no OS toast was closed.
  return { dismissed: 0 }
}

async function getPermissionStatus(): Promise<NotificationPermissionStatusResult> {
  const platform = hostPlatform()
  if (!hasTauriInternals()) {
    return { supported: false, platform, requested: false }
  }
  const result = await invoke<NativePermissionResult>('native_notification_permission')
  return { supported: true, platform, requested: result.state !== 'prompt' }
}

async function requestPermission(): Promise<NotificationPermissionStatusResult> {
  const platform = hostPlatform()
  if (!hasTauriInternals()) {
    return { supported: false, platform, requested: false }
  }
  await invoke<NativePermissionResult>('request_native_notification_permission')
  return { supported: true, platform, requested: true }
}

async function playSound(options?: { force?: boolean; volume?: number }) {
  if (activeSound && !options?.force) {
    return { played: false, reason: 'deduped' as const }
  }
  releaseActiveSound()
  const settings = await window.api.settings.get()
  const soundId = settings.notifications.customSoundId ?? 'system'
  if (soundId === 'system') {
    return { played: false, reason: 'missing-path' as const }
  }
  let url = BUILT_IN_SOUND_URLS.get(soundId) ?? null
  if (soundId === 'custom') {
    const path = settings.notifications.customSoundPath
    if (!path) {
      return { played: false, reason: 'missing-path' as const }
    }
    try {
      const data = await invoke<NativeSoundData>('load_notification_sound', { path })
      activeSoundObjectUrl = URL.createObjectURL(
        new Blob([decodeBase64(data.dataBase64)], { type: data.mimeType })
      )
      url = activeSoundObjectUrl
    } catch {
      return { played: false, reason: 'read-failed' as const }
    }
  }
  if (!url) {
    return { played: false, reason: 'missing-path' as const }
  }
  const audio = new Audio(url)
  audio.volume = Math.min(1, Math.max(0, (options?.volume ?? 100) / 100))
  activeSound = audio
  audio.addEventListener('ended', releaseActiveSound, { once: true })
  audio.addEventListener('error', releaseActiveSound, { once: true })
  try {
    await audio.play()
    return { played: true as const }
  } catch {
    releaseActiveSound()
    return { played: false, reason: 'playback-failed' as const }
  }
}

function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

function releaseActiveSound(): void {
  activeSound?.pause()
  activeSound = null
  if (activeSoundObjectUrl) {
    URL.revokeObjectURL(activeSoundObjectUrl)
  }
  activeSoundObjectUrl = null
}

export function createPebbleNotificationsApi(base: NotificationsApi): NotificationsApi {
  return {
    ...base,
    dispatch,
    dismiss,
    openSystemSettings: () => invoke<void>('open_notification_system_settings'),
    getPermissionStatus,
    requestPermission,
    playSound
  }
}
