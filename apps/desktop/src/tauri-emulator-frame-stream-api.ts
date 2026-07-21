import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { EmulatorApi } from '../../../packages/product-core/shared/emulator-api-types'

type FramePayload = { streamId: string; contentBase64: string }
type ErrorPayload = { streamId: string; message: string }

const frameListeners = new Set<Parameters<EmulatorApi['onFrameStreamFrame']>[0]>()
const errorListeners = new Set<Parameters<EmulatorApi['onFrameStreamError']>[0]>()
let nativeListenersReady: Promise<void> | null = null

export function installTauriEmulatorFrameStreamApi(): void {
  if (!hasTauriInternals()) {
    return
  }
  const base = window.api.emulator
  window.api.emulator = {
    ...base,
    startFrameStream: async (input) => {
      await ensureNativeListeners()
      return invoke<{ streamId: string }>('emulator_frame_stream_start', { input })
    },
    stopFrameStream: (input) => invoke<void>('emulator_frame_stream_stop', { input }),
    onFrameStreamFrame: (callback) => subscribe(frameListeners, callback),
    onFrameStreamError: (callback) => subscribe(errorListeners, callback)
  } satisfies EmulatorApi
}

function ensureNativeListeners(): Promise<void> {
  nativeListenersReady ??= Promise.all([
    listen<FramePayload>('pebble:emulator-frame', ({ payload }) => {
      const bytes = decodeBase64(payload.contentBase64)
      for (const callback of frameListeners) {
        callback({ streamId: payload.streamId, bytes })
      }
    }),
    listen<ErrorPayload>('pebble:emulator-frame-error', ({ payload }) => {
      for (const callback of errorListeners) {
        callback(payload)
      }
    })
  ]).then(() => undefined)
  return nativeListenersReady
}

function decodeBase64(content: string): ArrayBuffer {
  const binary = atob(content)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes.buffer
}

function subscribe<T>(listeners: Set<(payload: T) => void>, callback: (payload: T) => void) {
  listeners.add(callback)
  void ensureNativeListeners()
  return () => listeners.delete(callback)
}

function hasTauriInternals(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}
