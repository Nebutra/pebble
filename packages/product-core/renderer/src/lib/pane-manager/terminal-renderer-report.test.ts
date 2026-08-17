import { describe, expect, it } from 'vitest'
import { buildTerminalRendererReport, rendererReportChanged } from './terminal-renderer-report'

const summary = {
  paneCount: 1,
  webglPaneCount: 1,
  downgradedByContextLoss: false,
  autoDecisionReason: 'non-linux'
}
const NOW = new Date('2026-08-17T00:00:00.000Z')

describe('terminal renderer report', () => {
  it('records what a reader needs to tell WebGL from DOM', () => {
    const report = buildTerminalRendererReport(summary, NOW, 'probe/1.0')
    expect(report).toMatchObject({
      paneCount: 1,
      webglPaneCount: 1,
      downgradedByContextLoss: false,
      autoDecisionReason: 'non-linux',
      recordedAt: '2026-08-17T00:00:00.000Z',
      userAgent: 'probe/1.0'
    })
  })

  it('treats the first observation as a change', () => {
    expect(rendererReportChanged(null, buildTerminalRendererReport(summary, NOW, ''))).toBe(true)
  })

  it('rewrites when a pane falls back to DOM', () => {
    // Why: this is the transition the whole file exists to capture.
    const before = buildTerminalRendererReport(summary, NOW, '')
    const after = buildTerminalRendererReport(
      { ...summary, webglPaneCount: 0, downgradedByContextLoss: true },
      NOW,
      ''
    )
    expect(rendererReportChanged(before, after)).toBe(true)
  })

  it('does not rewrite when nothing a reader cares about moved', () => {
    // Why: the timestamp alone changing every sample would churn the file and
    // bury the moment the renderer actually changed.
    const before = buildTerminalRendererReport(summary, NOW, '')
    const after = buildTerminalRendererReport(summary, new Date('2026-08-17T01:00:00.000Z'), '')
    expect(rendererReportChanged(before, after)).toBe(false)
  })
})
