import { invoke } from '@tauri-apps/api/core'

import { hasTauriInternals } from './pebble-runtime-http-bridge'
import { requestRuntimeJson } from './pebble-tauri-runtime-transport'
import { LOCAL_RUNTIME_BEARER_TOKEN } from './local-runtime-auth'

// Read-side bridge for the native iOS Simulator adapter
// (commands/emulator_ios_provider.rs). Scope note: Electron's `EmulatorApi`
// (packages/product-core/shared/preload-api-types.ts) is a much larger streaming/IPC contract (frame
// streams, video streams, gesture wiring tied to renderer event plumbing);
// this module only exposes what the Rust worker actually does today —
// starting/stopping the background simctl reconciliation + action-queue
// loop, and reading the device list it maintains in the Go runtime. Full
// `EmulatorApi` parity (streaming, gestures) is a separate, larger slice.

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

export type EmulatorIosProviderStartResult = {
  supported: boolean
  platform: string
  providerId: string | null
  unsupportedReason?: string
}

/** Starts the native iOS Simulator provider worker (macOS only; see
 * emulator_ios_provider.rs for the honest Android/non-macOS gap). */
export async function startEmulatorIosProvider(
  options: { runtimeUrl?: string; bearerToken?: string } = {}
): Promise<EmulatorIosProviderStartResult> {
  if (!hasTauriInternals()) {
    return {
      supported: false,
      platform: 'unknown',
      providerId: null,
      unsupportedReason: 'the iOS Simulator provider requires the Tauri desktop shell'
    }
  }
  return invoke<EmulatorIosProviderStartResult>('start_emulator_ios_provider', {
    input: {
      runtimeUrl: options.runtimeUrl,
      bearerToken: options.bearerToken ?? LOCAL_RUNTIME_BEARER_TOKEN
    }
  })
}

/** Stops the background worker after its current cycle; persisted devices/sessions are untouched. */
export async function stopEmulatorIosProvider(): Promise<void> {
  if (!hasTauriInternals()) {
    return
  }
  await invoke('stop_emulator_ios_provider')
}

/** Reads the Go runtime's persisted emulator device list (updated by the
 * provider worker's reconciliation pass, not a live simctl call). */
export async function listRuntimeEmulatorDevices(): Promise<RuntimeEmulatorDevice[]> {
  return requestRuntimeJson<RuntimeEmulatorDevice[]>('/v1/emulator/devices', {
    method: 'GET',
    timeoutMs: 5000
  })
}
