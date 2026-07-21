import { invoke } from '@tauri-apps/api/core'

import { createRuntimeResourceGetCommand, getRuntimeResourceJson } from './runtime-bridge'
import { LOCAL_RUNTIME_BEARER_TOKEN } from './local-runtime-auth'

export {
  cancelNativeEmulatorPermission,
  EmulatorPermissionUnsupportedError,
  setNativeEmulatorPermission
} from './tauri-emulator-permissions-api'
export type {
  EmulatorPermissionOperation,
  EmulatorPermissionPlatform,
  EmulatorPermissionRequest,
  EmulatorPermissionResult
} from './tauri-emulator-permissions-api'

// Read-side bridge for the native Android adb adapter
// (commands/emulator_android_provider.rs), mirroring
// tauri-emulator-ios-provider-api.ts's shape for the iOS Simulator adapter.
// Scope note: Electron's `EmulatorApi` (packages/product-core/shared/preload-api-types.ts) is a much
// larger streaming/IPC contract (frame streams, video streams, gesture
// wiring tied to renderer event plumbing); this module only exposes what the
// Rust worker actually does today — starting/stopping the background adb
// reconciliation + action-queue loop, and reading the device list it
// maintains in the Go runtime. Full `EmulatorApi` parity (streaming,
// gestures) is a separate, larger slice.

export type EmulatorDeviceStatus = 'available' | 'booting' | 'running' | 'stopped' | 'error'

export type RuntimeEmulatorDevice = {
  id: string
  nativeId?: string
  name: string
  platform: 'ios' | 'android'
  runtime?: string
  status: EmulatorDeviceStatus
  error?: string
  createdAt: string
  updatedAt: string
}

export type EmulatorAndroidProviderStartResult = {
  supported: boolean
  platform: string
  providerId: string | null
  unsupportedReason?: string
}

/** Starts the native Android adb provider worker (any host with the Android
 * SDK command-line tools on PATH; see emulator_android_provider.rs for the
 * honest missing-toolchain gap). */
export async function startEmulatorAndroidProvider(
  options: { runtimeUrl?: string; bearerToken?: string } = {}
): Promise<EmulatorAndroidProviderStartResult> {
  if (!hasTauriInternals()) {
    return {
      supported: false,
      platform: 'unknown',
      providerId: null,
      unsupportedReason: 'the Android adapter requires the Tauri desktop shell'
    }
  }
  return invoke<EmulatorAndroidProviderStartResult>('start_emulator_android_provider', {
    input: {
      runtimeUrl: options.runtimeUrl,
      bearerToken: options.bearerToken ?? LOCAL_RUNTIME_BEARER_TOKEN
    }
  })
}

/** Stops the background worker after its current cycle; persisted devices/sessions are untouched. */
export async function stopEmulatorAndroidProvider(): Promise<void> {
  if (!hasTauriInternals()) {
    return
  }
  await invoke('stop_emulator_android_provider')
}

/** Reads the Go runtime's persisted emulator device list (updated by the
 * provider worker's reconciliation pass, not a live adb call). Shared with
 * the iOS adapter's device store — devices from both adapters appear
 * together, distinguished by `platform`. */
export async function listRuntimeEmulatorDevices(): Promise<RuntimeEmulatorDevice[]> {
  const result = await getRuntimeResourceJson(
    createRuntimeResourceGetCommand({ path: '/v1/emulator/devices', timeoutMs: 5000 })
  )
  if (!result.body) {
    return []
  }
  return JSON.parse(result.body) as RuntimeEmulatorDevice[]
}

function hasTauriInternals(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}
