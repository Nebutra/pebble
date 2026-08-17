import React, { useEffect, useState } from 'react'
import {
  readTerminalRenderingDiagnostics,
  summariseTerminalRenderers,
  type TerminalRendererSummary
} from '@/lib/pane-manager/active-pane-manager-registry'
import { SettingsRow } from './SettingsFormControls'
import { translate } from '@/i18n/i18n'

// Why: "Auto" never said what it chose. A pane that lost its WebGL context falls
// back to xterm's DOM renderer — much slower — and nothing anywhere reported it,
// so slow typing was indistinguishable from a busy machine. Show what is
// actually in use, next to the control that claims to decide it.

function describe(summary: TerminalRendererSummary): string {
  if (summary.paneCount === 0) {
    return translate(
      'auto.components.settings.TerminalActiveRendererRow.noPanes',
      'No terminal panes are open.'
    )
  }
  if (summary.downgradedByContextLoss) {
    return translate(
      'auto.components.settings.TerminalActiveRendererRow.contextLoss',
      'DOM — WebGL context was lost, so this pane fell back to the slower renderer.'
    )
  }
  if (summary.webglPaneCount === summary.paneCount) {
    return translate('auto.components.settings.TerminalActiveRendererRow.webgl', 'WebGL')
  }
  if (summary.webglPaneCount === 0) {
    return translate(
      'auto.components.settings.TerminalActiveRendererRow.dom',
      'DOM — reason: {{value0}}',
      { value0: summary.autoDecisionReason ?? 'unknown' }
    )
  }
  return translate(
    'auto.components.settings.TerminalActiveRendererRow.mixed',
    '{{value0}} of {{value1}} panes on WebGL',
    { value0: summary.webglPaneCount, value1: summary.paneCount }
  )
}

export function TerminalActiveRendererRow(): React.JSX.Element {
  const [summary, setSummary] = useState<TerminalRendererSummary | null>(null)

  useEffect(() => {
    const sample = (): void =>
      setSummary(summariseTerminalRenderers(readTerminalRenderingDiagnostics()))
    sample()
    // Why: a context loss can downgrade a pane while this page is open, and the
    // whole point of the row is to catch that moment.
    const handle = window.setInterval(sample, 2000)
    return () => window.clearInterval(handle)
  }, [])

  return (
    <SettingsRow
      label={translate(
        'auto.components.settings.TerminalActiveRendererRow.label',
        'Active renderer'
      )}
      description={translate(
        'auto.components.settings.TerminalActiveRendererRow.description',
        'What the terminal is really using right now, which is not always what the setting above asked for.'
      )}
      control={
        <span className="text-sm text-muted-foreground tabular-nums">
          {summary ? describe(summary) : '—'}
        </span>
      }
    />
  )
}
