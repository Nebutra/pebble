import type { DownloadEvent } from '@tauri-apps/plugin-updater'

type DownloadProgress = { percent: number; version: string }

export function createTauriUpdateDownloadProgressHandler(
  version: string,
  emit: (progress: DownloadProgress) => void
): (event: DownloadEvent) => void {
  let downloadedBytes = 0
  let totalBytes: number | undefined
  return (event) => {
    if (event.event === 'Started') {
      downloadedBytes = 0
      totalBytes = event.data.contentLength
      emit({ percent: 0, version })
      return
    }
    if (event.event === 'Progress') {
      downloadedBytes += event.data.chunkLength
      const percent = totalBytes
        ? Math.min(99, Math.floor((downloadedBytes / totalBytes) * 100))
        : 0
      emit({ percent, version })
      return
    }
    emit({ percent: 100, version })
  }
}
