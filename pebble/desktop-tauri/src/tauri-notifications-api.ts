import { invoke } from '@tauri-apps/api/core'

import type { PreloadApi } from '../../../src/preload/api-types'
import { buildNotificationOptions } from '../../../src/main/ipc/notification-options'
import type {
  NotificationDispatchRequest,
  NotificationDispatchResult,
  NotificationPermissionStatusResult
} from '../../../src/shared/types'
import { hasTauriInternals } from './pebble-runtime-http-bridge'

type NotificationsApi = NonNullable<Partial<PreloadApi>['notifications']>

type NativeShowResult = { delivered: boolean; reason?: string }
type NativePermissionResult = { granted: boolean; state: string }

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
  const result = await invoke<NativeShowResult>('show_native_notification', {
    input: { title: options.title, body: options.body }
  }).catch(() => ({ delivered: false, reason: 'invoke-failed' }) satisfies NativeShowResult)
  return dispatchReasonFrom(result)
}

async function getPermissionStatus(): Promise<NotificationPermissionStatusResult> {
  const platform = hostPlatform()
  if (!hasTauriInternals()) {
    return { supported: false, platform, requested: false }
  }
  const result = await invoke<NativePermissionResult>('native_notification_permission').catch(
    () => null
  )
  if (!result) {
    return { supported: false, platform, requested: false }
  }
  return { supported: true, platform, requested: result.state !== 'prompt' }
}

async function requestPermission(): Promise<NotificationPermissionStatusResult> {
  const platform = hostPlatform()
  if (!hasTauriInternals()) {
    return { supported: false, platform, requested: false }
  }
  const result = await invoke<NativePermissionResult>(
    'request_native_notification_permission'
  ).catch(() => null)
  if (!result) {
    return { supported: false, platform, requested: false }
  }
  return { supported: true, platform, requested: true }
}

export function createPebbleNotificationsApi(base: NotificationsApi): NotificationsApi {
  return {
    ...base,
    dispatch,
    getPermissionStatus,
    requestPermission
    // Why: dismiss/openSystemSettings/playSound have no faithful cross-platform
    // native mapping through tauri-plugin-notification yet, so they keep the web
    // base's explicit no-op behavior rather than pretending to act.
  }
}
