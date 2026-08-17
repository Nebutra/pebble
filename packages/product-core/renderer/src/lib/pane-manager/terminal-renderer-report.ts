import {
  readTerminalRenderingDiagnostics,
  summariseTerminalRenderers,
  type TerminalRendererSummary
} from './active-pane-manager-registry'

// Why: a report of "the terminal is slow" was undiagnosable. In a release build
// nothing could say which renderer a pane was on — DevTools are compiled out,
// the webview console is not forwarded to stdout, and crash breadcrumbs only
// reach disk when a crash is written. So a pane silently downgraded to xterm's
// DOM renderer looked exactly like a busy machine.
//
// Write the answer to the app data directory, where it can be read without
// DevTools, without screen access, and without asking anyone to describe their
// screen. Only the summary is written; there is nothing here that is not already
// visible in the terminal settings page.

export const TERMINAL_RENDERER_DOCUMENT = 'terminal-renderer'

const SAMPLE_INTERVAL_MS = 30_000

export type TerminalRendererReport = TerminalRendererSummary & {
  recordedAt: string
  userAgent: string
}

export function buildTerminalRendererReport(
  summary: TerminalRendererSummary,
  now: Date,
  userAgent: string
): TerminalRendererReport {
  return { ...summary, recordedAt: now.toISOString(), userAgent }
}

/** True when the two reports would tell a reader different things. */
export function rendererReportChanged(
  previous: TerminalRendererReport | null,
  next: TerminalRendererReport
): boolean {
  if (!previous) {
    return true
  }
  return (
    previous.paneCount !== next.paneCount ||
    previous.webglPaneCount !== next.webglPaneCount ||
    previous.downgradedByContextLoss !== next.downgradedByContextLoss ||
    previous.autoDecisionReason !== next.autoDecisionReason
  )
}

export function startTerminalRendererReporting(
  write: (document: string, contents: string) => void,
  now: () => Date = () => new Date()
): () => void {
  let previous: TerminalRendererReport | null = null

  const sample = (): void => {
    const summary = summariseTerminalRenderers(readTerminalRenderingDiagnostics())
    if (summary.paneCount === 0) {
      // Why: a moment with no panes says nothing about the renderer, and would
      // otherwise overwrite the last real observation with an empty one.
      return
    }
    const report = buildTerminalRendererReport(
      summary,
      now(),
      typeof navigator === 'undefined' ? '' : navigator.userAgent
    )
    if (!rendererReportChanged(previous, report)) {
      return
    }
    previous = report
    try {
      write(TERMINAL_RENDERER_DOCUMENT, JSON.stringify(report, null, 2))
    } catch {
      // A diagnostic write must never disturb the app it is describing.
    }
  }

  sample()
  const handle = setInterval(sample, SAMPLE_INTERVAL_MS)
  return () => clearInterval(handle)
}
