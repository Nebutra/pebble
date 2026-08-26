import type { DownloadEvent } from '@tauri-apps/plugin-updater'

type DownloadProgress = {
  percent: number
  version: string
  /** Observed average throughput, once enough of the download has been seen. */
  bytesPerSecond?: number
  /** Seconds left at the observed throughput; absent when it cannot be derived. */
  etaSeconds?: number
}

/**
 * Ignore throughput until this much of the download has elapsed: the first
 * chunks arrive before the connection settles, and a rate derived from them
 * swings wildly enough to be worse than saying nothing.
 */
const THROUGHPUT_WARMUP_MS = 3_000

export function createTauriUpdateDownloadProgressHandler(
  version: string,
  emit: (progress: DownloadProgress) => void,
  now: () => number = Date.now
): (event: DownloadEvent) => void {
  let downloadedBytes = 0
  let totalBytes: number | undefined
  let startedAt: number | null = null
  return (event) => {
    if (event.event === 'Started') {
      downloadedBytes = 0
      totalBytes = event.data.contentLength
      startedAt = now()
      emit({ percent: 0, version })
      return
    }
    if (event.event === 'Progress') {
      downloadedBytes += event.data.chunkLength
      const percent = totalBytes
        ? Math.min(99, Math.floor((downloadedBytes / totalBytes) * 100))
        : 0
      emit({ percent, version, ...throughput(downloadedBytes, totalBytes, startedAt, now()) })
      return
    }
    emit({ percent: 100, version })
  }
}

function throughput(
  downloadedBytes: number,
  totalBytes: number | undefined,
  startedAt: number | null,
  currentTime: number
): { bytesPerSecond?: number; etaSeconds?: number } {
  const elapsedMs = startedAt === null ? 0 : currentTime - startedAt
  if (startedAt === null || elapsedMs < THROUGHPUT_WARMUP_MS || downloadedBytes <= 0) {
    return {}
  }
  const bytesPerSecond = Math.round(downloadedBytes / (elapsedMs / 1_000))
  if (bytesPerSecond <= 0) {
    return {}
  }
  if (!totalBytes || totalBytes <= downloadedBytes) {
    return { bytesPerSecond }
  }
  return {
    bytesPerSecond,
    etaSeconds: Math.round((totalBytes - downloadedBytes) / bytesPerSecond)
  }
}
