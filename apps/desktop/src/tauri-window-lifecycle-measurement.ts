import { availableMonitors, getCurrentWindow } from '@tauri-apps/api/window'
import { invoke } from '@tauri-apps/api/core'

export type WindowLifecycleMeasurement = {
  firstFrameMs: number
  minimizeObserved: boolean
  minimizeMs: number
  resumeObserved: boolean
  resumeFocused: boolean
  resumeMs: number
  monitorCount: number
  multiDisplayRestore: 'unavailable' | 'requires-relaunch'
}

const WINDOW_TRANSITION_TIMEOUT_MS = 3_000
const COMMITTED_FRAME_TIMEOUT_MS = 250

export async function measureTauriWindowLifecycle(
  launchedAtEpochMs: number
): Promise<WindowLifecycleMeasurement> {
  await waitForCommittedFrame()
  // Why: functional dev launch compiles Rust before the host starts. The WebView
  // navigation origin excludes build time while retaining real first-frame work.
  const firstFrameStartedAt = Math.max(launchedAtEpochMs, performance.timeOrigin)
  const firstFrameMs = Math.max(0, Date.now() - firstFrameStartedAt)
  const monitors = await availableMonitors()
  const appWindow = getCurrentWindow()

  const minimizeStartedAt = performance.now()
  const nativeMinimized = await invoke<boolean>('functional_gate_minimize')
  const minimizeObserved =
    nativeMinimized || (await waitForBoolean(() => appWindow.isMinimized(), true))
  const minimizeMs = Math.round(performance.now() - minimizeStartedAt)

  const resumeStartedAt = performance.now()
  const nativeFocused = await invoke<boolean>('functional_gate_restore_and_focus')
  const resumeObserved = await waitForBoolean(() => appWindow.isMinimized(), false)
  const resumeFocused = nativeFocused || (await appWindow.isFocused())
  const resumeMs = Math.round(performance.now() - resumeStartedAt)

  return {
    firstFrameMs,
    minimizeObserved,
    minimizeMs,
    resumeObserved,
    resumeFocused,
    resumeMs,
    monitorCount: monitors.length,
    // Why: one process can prove topology but not persisted restoration. A
    // multi-display runner must relaunch before it may report this as passed.
    multiDisplayRestore: monitors.length < 2 ? 'unavailable' : 'requires-relaunch'
  }
}

async function waitForCommittedFrame(): Promise<void> {
  await waitForBoolean(() => Promise.resolve(Boolean(document.querySelector('#root > *'))), true)
  await Promise.race([
    new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    ),
    // Why: macOS may throttle every animation frame while an unattended gate
    // window is occluded; lifecycle evidence must remain bounded in that state.
    new Promise<void>((resolve) => globalThis.setTimeout(resolve, COMMITTED_FRAME_TIMEOUT_MS))
  ])
}

async function waitForBoolean(
  read: () => Promise<boolean>,
  expected: boolean,
  timeoutMs = WINDOW_TRANSITION_TIMEOUT_MS
): Promise<boolean> {
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    if ((await read()) === expected) {
      return true
    }
    await new Promise((resolve) => globalThis.setTimeout(resolve, 16))
  }
  return false
}
