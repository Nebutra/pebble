import { invoke } from '@tauri-apps/api/core'
import { useAppStore } from '@/store'
import { callRuntimeRpc, getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import type {
  BrowserVideoRecordingStartInput as StartInput,
  BrowserVideoRecordingStopResult as VideoRecordingStopResult,
  TauriBrowserVideoRecordingBridge
} from '../../../packages/product-core/shared/browser-video-recording-bridge'
import {
  startTauriBrowserScreencast,
  type TauriBrowserScreencastSession
} from './tauri-browser-screencast-channel'

type Recording = {
  input: StartInput
  canvas: HTMLCanvasElement
  context: CanvasRenderingContext2D
  recorder: MediaRecorder | null
  capture: TauriBrowserScreencastSession | null
  sink: VideoChunkSink
  writeQueue: Promise<void>
  frameCount: number
  startedAt: number
  stopPromise: Promise<VideoRecordingStopResult> | null
}

type VideoChunkSink = {
  append: (bytes: Uint8Array) => Promise<void>
  finish: () => Promise<{ path: string; bytes: number }>
  discard: () => Promise<void>
}

const recordings = new Map<string, Recording>()

export function installTauriBrowserVideoRecordingBridge(): TauriBrowserVideoRecordingBridge {
  const bridge: TauriBrowserVideoRecordingBridge = {
    start: startRecording,
    stop: stopRecording,
    rebind: rebindRecording,
    stopForTab: finalizeRecordingForTab
  }
  window.__pebbleTauriBrowserVideoRecordings = bridge
  return bridge
}

async function startRecording(
  input: StartInput
): Promise<{ started: true; path: string; mimeType: string }> {
  if (recordings.has(input.browserTabId)) {
    throw new Error('A browser video recording is already in progress.')
  }
  const mimeType = selectVideoMimeType(input.format)
  const sink = await createVideoChunkSink(input)
  const canvas = document.createElement('canvas')
  canvas.width = 2
  canvas.height = 2
  const context = canvas.getContext('2d', { alpha: false })
  if (!context) {
    throw new Error('Browser video could not create a recording canvas.')
  }
  if (typeof canvas.captureStream !== 'function') {
    await sink.discard().catch(() => undefined)
    throw new Error('This platform cannot capture a canvas for browser video recording.')
  }
  // Store the selected type before native capture can deliver frame zero.
  canvas.dataset.pebbleVideoMimeType = mimeType
  const recording: Recording = {
    input,
    canvas,
    context,
    recorder: null,
    capture: null,
    sink,
    writeQueue: Promise.resolve(),
    frameCount: 0,
    startedAt: Date.now(),
    stopPromise: null
  }
  try {
    recording.capture = await startRecordingCapture(input, recording)
  } catch (error) {
    await sink.discard().catch(() => undefined)
    throw error
  }
  recordings.set(input.browserTabId, recording)
  return { started: true, path: input.path, mimeType }
}

async function startRecordingCapture(
  input: StartInput,
  recording: Recording
): Promise<TauriBrowserScreencastSession> {
  return startTauriBrowserScreencast({
    label: input.label,
    format: 'jpeg',
    minFrameIntervalMs: 100,
    deviceScaleFactor: window.devicePixelRatio,
    onFrame: (frame) => drawRecordingFrame(recording, frame)
  })
}

async function drawRecordingFrame(recording: Recording, frame: Uint8Array): Promise<void> {
  const image = await createImageBitmap(new Blob([frame.slice()], { type: 'image/jpeg' }))
  try {
    if (!recording.recorder) {
      initializeMediaRecorder(recording, image.width, image.height)
    }
    recording.context.drawImage(image, 0, 0, recording.canvas.width, recording.canvas.height)
    recording.frameCount += 1
  } finally {
    image.close()
  }
}

function initializeMediaRecorder(recording: Recording, width: number, height: number): void {
  recording.canvas.width = Math.max(2, width)
  recording.canvas.height = Math.max(2, height)
  const stream = recording.canvas.captureStream(10)
  const mimeType = recording.canvas.dataset.pebbleVideoMimeType ?? ''
  const recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: 2_500_000
  })
  recorder.ondataavailable = (event) => {
    if (event.data.size === 0) {
      return
    }
    recording.writeQueue = recording.writeQueue.then(async () => {
      const bytes = new Uint8Array(await event.data.arrayBuffer())
      await recording.sink.append(bytes)
    })
  }
  recording.recorder = recorder
  recorder.start(1_000)
}

async function stopRecording(browserTabId: string): Promise<VideoRecordingStopResult> {
  const recording = recordings.get(browserTabId)
  if (!recording) {
    throw new Error('No browser video recording is in progress.')
  }
  recording.stopPromise ??= finishRecording(recording)
  return recording.stopPromise
}

async function finishRecording(recording: Recording): Promise<VideoRecordingStopResult> {
  recordings.delete(recording.input.browserTabId)
  await recording.capture?.stop()
  const recorder = recording.recorder
  if (!recorder || recording.frameCount === 0) {
    await recording.sink.discard()
    throw new Error('Browser video recording captured no frames.')
  }
  await stopMediaRecorder(recorder)
  await recording.writeQueue
  const output = await recording.sink.finish()
  return {
    ...output,
    frames: recording.frameCount,
    durationMs: Date.now() - recording.startedAt,
    mimeType: recorder.mimeType
  }
}

function stopMediaRecorder(recorder: MediaRecorder): Promise<void> {
  return new Promise((resolve, reject) => {
    recorder.addEventListener('stop', () => resolve(), { once: true })
    recorder.addEventListener('error', () => reject(new Error('Browser video encoder failed.')), {
      once: true
    })
    recorder.requestData()
    recorder.stop()
  })
}

async function rebindRecording(browserTabId: string, label: string): Promise<void> {
  const recording = recordings.get(browserTabId)
  if (!recording || recording.input.label === label) {
    return
  }
  await recording.capture?.stop()
  recording.input = { ...recording.input, label }
  recording.capture = await startRecordingCapture(recording.input, recording)
}

async function finalizeRecordingForTab(browserTabId: string): Promise<void> {
  if (!recordings.has(browserTabId)) {
    return
  }
  await stopRecording(browserTabId).catch(() => undefined)
}

export function selectVideoMimeType(format: 'webm' | 'mp4'): string {
  if (typeof MediaRecorder === 'undefined') {
    throw new Error('This platform does not provide a browser video encoder.')
  }
  const candidates =
    format === 'webm'
      ? ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
      : ['video/mp4;codecs=avc1.42E01E', 'video/mp4']
  const supported = candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate))
  if (!supported) {
    throw new Error(`This platform cannot encode browser video as ${format.toUpperCase()}.`)
  }
  return supported
}

async function createVideoChunkSink(input: StartInput): Promise<VideoChunkSink> {
  return input.worktree ? createRuntimeVideoSink(input) : createLocalVideoSink(input.path)
}

async function createLocalVideoSink(path: string): Promise<VideoChunkSink> {
  const { recordingId } = await invoke<{ recordingId: string }>('browser_video_recording_start', {
    input: { path, baseDir: null }
  })
  let bytes = 0
  return {
    append: async (chunk) => {
      await invoke('browser_video_recording_append', chunk, {
        headers: { 'x-pebble-recording-id': recordingId }
      })
      bytes += chunk.byteLength
    },
    finish: () =>
      invoke('browser_video_recording_stop', {
        input: { recordingId, discard: false }
      }),
    discard: async () => {
      await invoke('browser_video_recording_stop', {
        input: { recordingId, discard: true }
      }).catch(() => undefined)
    }
  }
}

async function createRuntimeVideoSink(input: StartInput): Promise<VideoChunkSink> {
  const target = getActiveRuntimeTarget(useAppStore.getState().settings)
  const relativePath = normalizeRecordingRelativePath(input.path)
  const temporaryPath = makeRecordingTemporaryPath(relativePath)
  let wroteChunk = false
  let bytes = 0
  const scope = { worktree: input.worktree }
  return {
    append: async (chunk) => {
      await callRuntimeRpc(target, wroteChunk ? 'files.writeBase64Chunk' : 'files.writeBase64', {
        ...scope,
        relativePath: temporaryPath,
        contentBase64: bytesToBase64(chunk),
        append: wroteChunk
      })
      wroteChunk = true
      bytes += chunk.byteLength
    },
    finish: async () => {
      if (!wroteChunk) {
        throw new Error('Browser video recording captured no encoded data.')
      }
      await callRuntimeRpc(target, 'files.commitUpload', {
        ...scope,
        tempRelativePath: temporaryPath,
        finalRelativePath: relativePath
      })
      return { path: relativePath, bytes }
    },
    discard: async () => {
      await callRuntimeRpc(target, 'files.delete', {
        ...scope,
        relativePath: temporaryPath,
        recursive: false
      }).catch(() => undefined)
    }
  }
}

export function normalizeRecordingRelativePath(path: string): string {
  const normalized = path.replaceAll('\\', '/').replace(/^\.\//, '')
  if (!normalized || normalized.startsWith('/') || normalized.split('/').includes('..')) {
    throw new Error('Worktree browser video paths must be relative and remain inside the worktree.')
  }
  return normalized
}

function makeRecordingTemporaryPath(path: string): string {
  const slash = path.lastIndexOf('/')
  const directory = slash < 0 ? '' : path.slice(0, slash + 1)
  const leaf = slash < 0 ? path : path.slice(slash + 1)
  return `${directory}.${leaf}.pebble-recording-${crypto.randomUUID()}`
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return btoa(binary)
}
