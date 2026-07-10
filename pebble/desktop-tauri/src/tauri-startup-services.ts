import {
  ensurePebbleRuntimeProcess,
  readPebbleStatusOrNull
} from './pebble-tauri-runtime-transport'
import { refreshTauriAgents } from './tauri-preflight-agent-api'

const DEFAULT_TAURI_STARTUP_SERVICE_TIMEOUT_MS = 2500

export async function waitForTauriStartupServices(
  timeoutMs = DEFAULT_TAURI_STARTUP_SERVICE_TIMEOUT_MS
): Promise<void> {
  await Promise.allSettled([
    settleStartupService('runtime-process', ensurePebbleRuntimeProcess(), timeoutMs),
    settleStartupService('runtime-status', readPebbleStatusOrNull(), timeoutMs),
    settleStartupService('agent-refresh', refreshTauriAgents(), timeoutMs)
  ])
}

async function settleStartupService(
  label: string,
  task: Promise<unknown>,
  timeoutMs: number
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | null = null
  try {
    await Promise.race([
      task.then(
        () => undefined,
        (error) => {
          console.warn(`[tauri-startup] ${label} failed:`, error)
        }
      ),
      new Promise<void>((resolve) => {
        timeout = setTimeout(() => {
          console.warn(`[tauri-startup] ${label} timed out after ${timeoutMs}ms.`)
          resolve()
        }, timeoutMs)
      })
    ])
  } finally {
    if (timeout) {
      clearTimeout(timeout)
    }
  }
}
