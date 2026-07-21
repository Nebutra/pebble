import type { PreloadApi } from '../../../packages/product-core/shared/preload-api-types'

type PtyApi = PreloadApi['pty']
type SerializeRequest = Parameters<Parameters<PtyApi['onSerializeBufferRequest']>[0]>[0]
type ClearRequest = Parameters<Parameters<PtyApi['onClearBufferRequest']>[0]>[0]
type SerializedBuffer = Parameters<PtyApi['sendSerializedBuffer']>[1]

const serializeListeners = new Set<(request: SerializeRequest) => void>()
const clearListeners = new Set<(request: ClearRequest) => void>()
const pendingSerializerGenerationByPane = new Map<string, number>()
const settledSerializerGenerationByPane = new Map<string, number>()
const pendingSnapshotRequests = new Map<
  string,
  { resolve: (snapshot: SerializedBuffer) => void; timeout: ReturnType<typeof setTimeout> }
>()
let serializerGeneration = 0

export function addTauriSerializeBufferRequestListener(
  listener: (request: SerializeRequest) => void
): () => void {
  serializeListeners.add(listener)
  return () => serializeListeners.delete(listener)
}

export function addTauriClearBufferRequestListener(
  listener: (request: ClearRequest) => void
): () => void {
  clearListeners.add(listener)
  return () => clearListeners.delete(listener)
}

export function sendTauriSerializedBuffer(requestId: string, snapshot: SerializedBuffer): void {
  const request = pendingSnapshotRequests.get(requestId)
  if (!request) {
    return
  }
  pendingSnapshotRequests.delete(requestId)
  clearTimeout(request.timeout)
  request.resolve(snapshot)
}

export function declareTauriPendingPaneSerializer(paneKey: string): Promise<number> {
  if (!paneKey.trim() || paneKey.length > 256) {
    return Promise.reject(new Error('Invalid paneKey'))
  }
  const generation = ++serializerGeneration
  pendingSerializerGenerationByPane.set(paneKey, generation)
  return Promise.resolve(generation)
}

export function settleTauriPaneSerializer(paneKey: string, generation: number): Promise<void> {
  if (pendingSerializerGenerationByPane.get(paneKey) === generation) {
    pendingSerializerGenerationByPane.delete(paneKey)
    settledSerializerGenerationByPane.set(paneKey, generation)
  }
  return Promise.resolve()
}

export function clearTauriPendingPaneSerializer(
  paneKey: string,
  generation: number
): Promise<void> {
  if (pendingSerializerGenerationByPane.get(paneKey) === generation) {
    pendingSerializerGenerationByPane.delete(paneKey)
  }
  return Promise.resolve()
}

export function requestTauriSerializedBuffer(
  ptyId: string,
  opts?: { scrollbackRows?: number; altScreenForcesZeroRows?: boolean },
  timeoutMs = 100
): Promise<SerializedBuffer> {
  if (serializeListeners.size === 0) {
    return Promise.resolve(null)
  }
  const requestId = crypto.randomUUID()
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      pendingSnapshotRequests.delete(requestId)
      resolve(null)
    }, timeoutMs)
    pendingSnapshotRequests.set(requestId, { resolve, timeout })
    for (const listener of serializeListeners) {
      listener({ requestId, ptyId, opts })
    }
  })
}

export function requestTauriRendererBufferClear(ptyId: string): void {
  for (const listener of clearListeners) {
    listener({ ptyId })
  }
}
