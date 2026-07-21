import { Channel, invoke } from '@tauri-apps/api/core'

import { createLatestBrowserScreencastForwarder } from './tauri-browser-screencast-forwarder'

export type TauriBrowserScreencastOptions = {
  label: string
  format: 'jpeg' | 'png'
  minFrameIntervalMs: number
  deviceScaleFactor: number
  onFrame: (frame: Uint8Array) => void | Promise<void>
}

export type TauriBrowserScreencastSession = {
  streamId: string
  stop: () => Promise<void>
}

type RuntimeScreencastStartInput = {
  browserTabId: string
  label: string
  subscriptionId: string
  format: 'jpeg' | 'png'
  minFrameIntervalMs: number
  deviceScaleFactor: number
}

export type TauriBrowserScreencastBridge = {
  start: (input: RuntimeScreencastStartInput) => Promise<{ streamId: string }>
  stop: (subscriptionId: string) => Promise<void>
  rebind: (browserTabId: string, label: string) => Promise<void>
  stopForTab: (browserTabId: string) => Promise<void>
}

type StartResult = { streamId: string }
type RuntimeScreencastBinding = {
  input: RuntimeScreencastStartInput
  session: TauriBrowserScreencastSession
}

const runtimeSessions = new Map<string, RuntimeScreencastBinding>()

export function installTauriBrowserScreencastBridge(): TauriBrowserScreencastBridge {
  const bridge: TauriBrowserScreencastBridge = {
    start: startRuntimeScreencast,
    stop: stopRuntimeScreencast,
    rebind: rebindRuntimeScreencasts,
    stopForTab: stopRuntimeScreencastsForTab
  }
  window.__pebbleTauriBrowserScreencasts = bridge
  return bridge
}

async function startRuntimeScreencast(
  input: RuntimeScreencastStartInput
): Promise<{ streamId: string }> {
  await stopRuntimeScreencast(input.subscriptionId)
  const session = await startRuntimeNativeScreencast(input)
  runtimeSessions.set(input.subscriptionId, { input, session })
  return { streamId: session.streamId }
}

async function startRuntimeNativeScreencast(
  input: RuntimeScreencastStartInput
): Promise<TauriBrowserScreencastSession> {
  const forwarder = createLatestBrowserScreencastForwarder((frame) =>
    invoke('browser_screencast_forward_frame', frame, {
      headers: { 'x-pebble-screencast-id': input.subscriptionId }
    })
  )
  const nativeSession = await startTauriBrowserScreencast({
    label: input.label,
    format: input.format,
    minFrameIntervalMs: input.minFrameIntervalMs,
    deviceScaleFactor: input.deviceScaleFactor,
    onFrame: (frame) => forwarder.offer(frame)
  })
  void forwarder.failed.then(() => nativeSession.stop())
  return {
    streamId: nativeSession.streamId,
    stop: async () => {
      await nativeSession.stop()
      await forwarder.stop()
    }
  }
}

async function stopRuntimeScreencast(subscriptionId: string): Promise<void> {
  const binding = runtimeSessions.get(subscriptionId)
  runtimeSessions.delete(subscriptionId)
  await binding?.session.stop()
}

async function rebindRuntimeScreencasts(browserTabId: string, label: string): Promise<void> {
  const bindings = [...runtimeSessions.entries()].filter(
    ([, binding]) => binding.input.browserTabId === browserTabId && binding.input.label !== label
  )
  for (const [subscriptionId, binding] of bindings) {
    await binding.session.stop()
    const input = { ...binding.input, label }
    const session = await startRuntimeNativeScreencast(input)
    runtimeSessions.set(subscriptionId, { input, session })
  }
}

async function stopRuntimeScreencastsForTab(browserTabId: string): Promise<void> {
  const subscriptionIds = [...runtimeSessions.entries()]
    .filter(([, binding]) => binding.input.browserTabId === browserTabId)
    .map(([subscriptionId]) => subscriptionId)
  await Promise.all(subscriptionIds.map(stopRuntimeScreencast))
}

export async function startTauriBrowserScreencast(
  options: TauriBrowserScreencastOptions
): Promise<TauriBrowserScreencastSession> {
  let streamId = ''
  let stopped = false
  let delivery = Promise.resolve()
  let releaseStart!: () => void
  const startReady = new Promise<void>((resolve) => {
    releaseStart = resolve
  })
  const channel = new Channel<ArrayBuffer>((rawFrame) => {
    const frame = new Uint8Array(rawFrame)
    let seq: number
    try {
      seq = readFrameSequence(frame)
    } catch {
      // Why: an invalid native frame cannot be ACKed safely; stopping after the
      // start result arrives releases Rust from its per-frame backpressure wait.
      delivery = delivery
        .then(() => startReady)
        .then(async () => {
          if (!stopped && streamId) {
            stopped = true
            await invoke('browser_screencast_stop', { input: { streamId } }).catch(() => undefined)
          }
        })
      return
    }
    // Why: Rust can publish frame zero before the start invoke resolves;
    // queue delivery until streamId exists so the first ACK is never lost.
    delivery = delivery
      .then(() => startReady)
      .then(() => options.onFrame(frame))
      .then(async () => {
        if (!stopped && streamId) {
          await invoke('browser_screencast_ack', { input: { streamId, seq } })
        }
      })
      .catch(async () => {
        if (!stopped && streamId) {
          stopped = true
          await invoke('browser_screencast_stop', { input: { streamId } }).catch(() => undefined)
        }
      })
  })
  const result = await invoke<StartResult>('browser_screencast_start', {
    input: {
      label: options.label,
      format: options.format,
      minFrameIntervalMs: options.minFrameIntervalMs,
      deviceScaleFactor: options.deviceScaleFactor
    },
    onFrame: channel
  })
  streamId = result.streamId
  releaseStart()
  return {
    streamId,
    stop: async () => {
      if (stopped) {
        return
      }
      stopped = true
      await invoke('browser_screencast_stop', { input: { streamId } })
      await delivery
    }
  }
}

export function readFrameSequence(frame: Uint8Array): number {
  if (frame.byteLength < 16 || frame[0] !== 0x62 || frame[1] !== 1 || frame[2] !== 1) {
    throw new Error('Native browser screencast returned an invalid protocol frame.')
  }
  return new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(4, true)
}

declare global {
  // Interface merging is required to expose this bridge on the browser-owned Window type.
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
  interface Window {
    __pebbleTauriBrowserScreencasts?: TauriBrowserScreencastBridge
  }
}
