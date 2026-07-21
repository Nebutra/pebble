import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { EmulatorApi } from '../../../packages/product-core/shared/emulator-api-types'
import {
  TauriEmulatorVideoRegistry,
  type NativeVideoError,
  type NativeVideoFrame,
  type NativeVideoMeta
} from './tauri-emulator-video-registry'

type VideoMetaPayload = Parameters<Parameters<EmulatorApi['onVideoStreamMeta']>[0]>[0]
type VideoFramePayload = Omit<
  Parameters<Parameters<EmulatorApi['onVideoStreamFrame']>[0]>[0],
  'bytes'
> & {
  pts: string
  gopIndex: number
  contentBase64: string
}
type VideoErrorPayload = { streamId: string; deviceId: string; message: string }

const metaListeners = new Set<Parameters<EmulatorApi['onVideoStreamMeta']>[0]>()
const frameListeners = new Set<Parameters<EmulatorApi['onVideoStreamFrame']>[0]>()
const errorListeners = new Set<(payload: VideoErrorPayload) => void>()
let nativeListenersReady: Promise<void> | null = null
const videoRegistry = new TauriEmulatorVideoRegistry(
  async (deviceId, streamId) => {
    await invoke('emulator_video_stream_start', { input: { deviceId, streamId } })
  },
  (streamId) => invoke<void>('emulator_video_stream_stop', { input: { streamId } }),
  (payload) => notify(metaListeners, payload),
  (payload) => notify(frameListeners, payload),
  (payload) => notify(errorListeners, payload)
)

export function installTauriEmulatorVideoStreamApi(): void {
  if (!hasTauriInternals()) {
    return
  }
  const base = window.api.emulator
  window.api.emulator = {
    ...base,
    startVideoStream: async (input) => {
      await ensureNativeListeners()
      await videoRegistry.subscribe(input.deviceId, input.streamId)
      return { streamId: input.streamId }
    },
    stopVideoStream: (input) => videoRegistry.unsubscribe(input.streamId),
    onVideoStreamMeta: (callback) => subscribe(metaListeners, callback),
    onVideoStreamFrame: (callback) => subscribe(frameListeners, callback),
    onVideoStreamError: (callback) => subscribe(errorListeners, callback)
  } satisfies EmulatorApi
}

function ensureNativeListeners(): Promise<void> {
  nativeListenersReady ??= Promise.all([
    listen<VideoMetaPayload>('pebble:emulator-video-meta', ({ payload }) => {
      videoRegistry.acceptMeta(payload as NativeVideoMeta)
    }),
    listen<VideoFramePayload>('pebble:emulator-video-frame', ({ payload }) => {
      const bytes = decodeBase64(payload.contentBase64)
      const frame = {
        streamId: payload.streamId,
        deviceId: payload.deviceId,
        config: payload.config,
        keyFrame: payload.keyFrame,
        pts: payload.pts,
        gopIndex: payload.gopIndex,
        bytes
      }
      videoRegistry.acceptFrame(frame as NativeVideoFrame)
    }),
    listen<VideoErrorPayload>('pebble:emulator-video-error', ({ payload }) => {
      videoRegistry.acceptError(payload as NativeVideoError)
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

function notify<T>(listeners: Set<(payload: T) => void>, payload: T): void {
  for (const callback of listeners) {
    callback(payload)
  }
}

function hasTauriInternals(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}
