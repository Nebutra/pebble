/**
 * Human-readable throughput/ETA for an in-flight update download.
 *
 * Why this exists: the card showed only a percentage, so a download crawling at
 * a few tens of KB/s looked identical to a healthy one — it just sat there. A
 * user watching "3%" has no way to tell "nearly done" from "another hour".
 */

/**
 * Below this, the download is slow enough that the user should be told outright
 * rather than left to infer it from a percentage that barely moves.
 */
const SLOW_DOWNLOAD_ETA_SECONDS = 10 * 60

export function formatDownloadRate(bytesPerSecond: number): string {
  if (bytesPerSecond >= 1_000_000) {
    return `${(bytesPerSecond / 1_000_000).toFixed(1)} MB/s`
  }
  if (bytesPerSecond >= 1_000) {
    return `${Math.round(bytesPerSecond / 1_000)} KB/s`
  }
  return `${Math.max(0, Math.round(bytesPerSecond))} B/s`
}

export function formatDownloadEta(etaSeconds: number): string {
  if (etaSeconds >= 3_600) {
    // Why one decimal: rounding 90 minutes to "2 hr" overstates the wait by a
    // third, and this label exists precisely so a long wait reads honestly.
    const hours = etaSeconds / 3_600
    return `about ${Number.isInteger(hours) ? hours : hours.toFixed(1)} hr left`
  }
  if (etaSeconds >= 60) {
    return `about ${Math.round(etaSeconds / 60)} min left`
  }
  return `about ${Math.max(1, Math.round(etaSeconds))} sec left`
}

export function isSlowDownload(etaSeconds: number | undefined): boolean {
  return etaSeconds !== undefined && etaSeconds > SLOW_DOWNLOAD_ETA_SECONDS
}

/**
 * Returns null while the rate is still unknown, so the card shows the plain
 * percentage rather than a placeholder that implies a stall.
 */
export function describeDownloadRate(args: {
  bytesPerSecond?: number
  etaSeconds?: number
}): string | null {
  if (args.bytesPerSecond === undefined) {
    return null
  }
  const rate = formatDownloadRate(args.bytesPerSecond)
  if (args.etaSeconds === undefined) {
    return rate
  }
  return `${rate} · ${formatDownloadEta(args.etaSeconds)}`
}
