/**
 * Background release checks that do not depend on remote nudge campaigns.
 *
 * Best practice (VS Code / browser-style):
 * - silent check shortly after launch once the UI is up
 * - periodic check while the app stays open
 * - re-check when the window becomes visible or the network returns after a gap
 * - never flash "checking" / "up to date" chrome for silent runs
 * - honor dismissals for a given version (handled by UpdateCard + store)
 */

/** Delay so first paint / session restore is not competing with network. */
export const SILENT_UPDATE_STARTUP_DELAY_MS = 12_000
/** Steady-state poll while the app is running. */
export const SILENT_UPDATE_INTERVAL_MS = 4 * 60 * 60_000
/** Minimum gap between any two silent checks (including focus/online). */
export const SILENT_UPDATE_MIN_GAP_MS = 10 * 60_000
/** After backgrounding, require this much idle before focus re-check. */
export const SILENT_UPDATE_FOCUS_GAP_MS = 60 * 60_000

type SilentUpdateCheckDependencies = {
  development: boolean
  /** True when a check/download/relaunch already owns the updater pipeline. */
  isBusy: () => boolean
  /** Run a silent update check (must set userInitiated: false). */
  runSilentCheck: () => Promise<void>
  now?: () => number
  setTimeoutFn?: typeof globalThis.setTimeout
  setIntervalFn?: typeof globalThis.setInterval
  addEventListenerFn?: typeof globalThis.addEventListener
  documentRef?: Document | null
}

export class TauriSilentUpdateCheck {
  private lastCheckAt = 0
  private inFlight = false
  private installed = false
  private readonly now: () => number
  private readonly setTimeoutFn: typeof globalThis.setTimeout
  private readonly setIntervalFn: typeof globalThis.setInterval
  private readonly addEventListenerFn: typeof globalThis.addEventListener
  private readonly documentRef: Document | null

  constructor(private readonly dependencies: SilentUpdateCheckDependencies) {
    this.now = dependencies.now ?? (() => Date.now())
    this.setTimeoutFn =
      dependencies.setTimeoutFn ??
      (((fn, ms) => globalThis.setTimeout(fn, ms)) as typeof globalThis.setTimeout)
    this.setIntervalFn =
      dependencies.setIntervalFn ??
      (((fn, ms) => globalThis.setInterval(fn, ms)) as typeof globalThis.setInterval)
    // Why: Node vitest loads this module without a Window; never call .bind on
    // a missing globalThis.addEventListener during module evaluation.
    this.addEventListenerFn =
      dependencies.addEventListenerFn ??
      ((type, listener, options) => {
        globalThis.addEventListener?.(type, listener as EventListener, options)
      })
    this.documentRef =
      dependencies.documentRef !== undefined
        ? dependencies.documentRef
        : typeof document === 'undefined'
          ? null
          : document
  }

  install(): void {
    if (this.installed || this.dependencies.development) {
      return
    }
    this.installed = true
    this.setTimeoutFn(() => {
      void this.tick({ reason: 'startup' })
    }, SILENT_UPDATE_STARTUP_DELAY_MS)
    this.setIntervalFn(() => {
      void this.tick({ reason: 'interval' })
    }, SILENT_UPDATE_INTERVAL_MS)

    this.addEventListenerFn('online', () => {
      void this.tick({ reason: 'online', minGapMs: SILENT_UPDATE_MIN_GAP_MS })
    })

    const doc = this.documentRef
    if (doc) {
      doc.addEventListener('visibilitychange', () => {
        if (doc.visibilityState === 'visible') {
          void this.tick({ reason: 'focus', minGapMs: SILENT_UPDATE_FOCUS_GAP_MS })
        }
      })
    }
  }

  resetForTests(): void {
    this.lastCheckAt = 0
    this.inFlight = false
    this.installed = false
  }

  async tick(options?: {
    reason?: 'startup' | 'interval' | 'focus' | 'online' | 'manual-silent'
    minGapMs?: number
  }): Promise<void> {
    if (this.dependencies.development || this.inFlight || this.dependencies.isBusy()) {
      return
    }
    const minGap = options?.minGapMs ?? SILENT_UPDATE_MIN_GAP_MS
    const now = this.now()
    if (this.lastCheckAt > 0 && now - this.lastCheckAt < minGap) {
      return
    }
    // Why: mark the attempt time before awaiting so overlapping focus/online
    // events cannot stampede into parallel silent checks.
    this.lastCheckAt = now
    this.inFlight = true
    try {
      await this.dependencies.runSilentCheck()
    } finally {
      this.inFlight = false
    }
  }
}
