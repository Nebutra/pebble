export function nextRuntimePollDelay(currentMs: number, minMs: number, maxMs: number): number {
  return Math.min(maxMs, Math.max(minMs, currentMs * 2))
}
