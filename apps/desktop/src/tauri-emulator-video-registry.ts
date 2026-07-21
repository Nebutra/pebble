export type NativeVideoMeta = {
  streamId: string
  deviceId: string
  meta: { codecId: string; width: number; height: number }
}

export type NativeVideoFrame = {
  streamId: string
  deviceId: string
  config: boolean
  keyFrame: boolean
  pts: string
  gopIndex: number
  bytes: ArrayBuffer
}

export type NativeVideoError = { streamId: string; deviceId: string; message: string }

type RegistryEntry = {
  deviceId: string
  nativeStreamId: string
  subscribers: Set<string>
  activeSubscribers: Set<string>
  meta: NativeVideoMeta | null
  config: NativeVideoFrame | null
  gop: NativeVideoFrame[]
  gopBytes: number
  start: Promise<void>
}

const MAX_GOP_FRAMES = 120
const MAX_GOP_BYTES = 32 * 1024 * 1024

export class TauriEmulatorVideoRegistry {
  private readonly byDevice = new Map<string, RegistryEntry>()
  private readonly byNativeStream = new Map<string, RegistryEntry>()
  private readonly bySubscriber = new Map<string, RegistryEntry>()

  constructor(
    private readonly nativeStart: (deviceId: string, streamId: string) => Promise<void>,
    private readonly nativeStop: (streamId: string) => Promise<void>,
    private readonly emitMeta: (payload: NativeVideoMeta) => void,
    private readonly emitFrame: (payload: NativeVideoFrame) => void,
    private readonly emitError: (payload: NativeVideoError) => void
  ) {}

  async subscribe(deviceId: string, streamId: string): Promise<void> {
    if (this.bySubscriber.has(streamId)) {
      throw new Error('Emulator video stream id is already active.')
    }
    let entry = this.byDevice.get(deviceId)
    if (!entry) {
      const nativeStreamId = `device-${crypto.randomUUID()}`
      entry = {
        deviceId,
        nativeStreamId,
        subscribers: new Set(),
        activeSubscribers: new Set(),
        meta: null,
        config: null,
        gop: [],
        gopBytes: 0,
        start: Promise.resolve()
      }
      entry.start = this.nativeStart(deviceId, nativeStreamId).catch((error) => {
        this.removeEntry(entry as RegistryEntry)
        throw error
      })
      this.byDevice.set(deviceId, entry)
      this.byNativeStream.set(nativeStreamId, entry)
    }
    entry.subscribers.add(streamId)
    this.bySubscriber.set(streamId, entry)
    try {
      await entry.start
    } catch (error) {
      entry.subscribers.delete(streamId)
      this.bySubscriber.delete(streamId)
      throw error
    }
    if (this.bySubscriber.get(streamId) !== entry) {
      return
    }
    this.replay(entry, streamId)
    entry.activeSubscribers.add(streamId)
  }

  async unsubscribe(streamId: string): Promise<void> {
    const entry = this.bySubscriber.get(streamId)
    if (!entry) {
      return
    }
    entry.subscribers.delete(streamId)
    entry.activeSubscribers.delete(streamId)
    this.bySubscriber.delete(streamId)
    if (entry.subscribers.size > 0) {
      return
    }
    this.removeEntry(entry)
    await entry.start.catch(() => undefined)
    await this.nativeStop(entry.nativeStreamId)
  }

  acceptMeta(payload: NativeVideoMeta): void {
    const entry = this.byNativeStream.get(payload.streamId)
    if (!entry) {
      return
    }
    entry.meta = payload
    for (const streamId of entry.activeSubscribers) {
      this.emitMeta({ ...payload, streamId })
    }
  }

  acceptFrame(payload: NativeVideoFrame): void {
    const entry = this.byNativeStream.get(payload.streamId)
    if (!entry) {
      return
    }
    if (payload.config) {
      entry.config = payload
    } else if (payload.keyFrame) {
      entry.gop = [payload]
      entry.gopBytes = payload.bytes.byteLength
    } else if (entry.gop.length > 0) {
      entry.gop.push(payload)
      entry.gopBytes += payload.bytes.byteLength
      this.boundGop(entry)
    }
    for (const streamId of entry.activeSubscribers) {
      this.emitFrame({ ...payload, streamId })
    }
  }

  acceptError(payload: NativeVideoError): void {
    const entry = this.byNativeStream.get(payload.streamId)
    if (!entry) {
      return
    }
    for (const streamId of entry.activeSubscribers) {
      this.emitError({ ...payload, streamId })
    }
    this.removeEntry(entry)
  }

  private replay(entry: RegistryEntry, streamId: string): void {
    if (entry.meta) {
      this.emitMeta({ ...entry.meta, streamId })
    }
    if (entry.config) {
      this.emitFrame({ ...entry.config, streamId })
    }
    for (const frame of entry.gop) {
      this.emitFrame({ ...frame, streamId })
    }
  }

  private boundGop(entry: RegistryEntry): void {
    while (entry.gop.length > MAX_GOP_FRAMES || entry.gopBytes > MAX_GOP_BYTES) {
      if (entry.gop.length <= 1) {
        break
      }
      const [removed] = entry.gop.splice(1, 1)
      entry.gopBytes -= removed.bytes.byteLength
    }
  }

  private removeEntry(entry: RegistryEntry): void {
    this.byDevice.delete(entry.deviceId)
    this.byNativeStream.delete(entry.nativeStreamId)
    for (const streamId of entry.subscribers) {
      this.bySubscriber.delete(streamId)
    }
  }
}
