import type { AppState } from '@/store/types'

export type PaletteStatusInputsState = Pick<
  AppState,
  | 'agentStatusByPaneKey'
  | 'runtimePaneTitlesByTabId'
  | 'ptyIdsByTabId'
  | 'terminalLayoutsByTabId'
  | 'tabsByWorktree'
>

export type PaletteStatusInputs = PaletteStatusInputsState

// Why: shared frozen bundle returned whenever the Cmd+J jump palette isn't
// active. The two hottest maps here — agentStatusByPaneKey and
// runtimePaneTitlesByTabId — get a new top-level identity on every agent-status
// transition and every terminal pane-title write app-wide. The palette is always
// mounted and stays mounted for the session once opened, so subscribing while
// closed re-rendered it on unrelated terminal chatter. useShallow keeps this
// same reference across that churn. Frozen so the shared singleton can't mutate.
export const EMPTY_PALETTE_STATUS_INPUTS: PaletteStatusInputs = Object.freeze({
  agentStatusByPaneKey: {},
  runtimePaneTitlesByTabId: {},
  ptyIdsByTabId: {},
  terminalLayoutsByTabId: {},
  tabsByWorktree: {}
})

/**
 * Select the five status maps the jump palette needs while `active` (open or
 * still animating closed). While inactive return a stable frozen constant so
 * closed palette subscriptions skip re-renders on hot map churn.
 */
export function selectPaletteStatusInputs(
  s: PaletteStatusInputsState,
  active: boolean
): PaletteStatusInputs {
  if (!active) {
    return EMPTY_PALETTE_STATUS_INPUTS
  }
  return {
    agentStatusByPaneKey: s.agentStatusByPaneKey,
    runtimePaneTitlesByTabId: s.runtimePaneTitlesByTabId,
    ptyIdsByTabId: s.ptyIdsByTabId,
    terminalLayoutsByTabId: s.terminalLayoutsByTabId,
    tabsByWorktree: s.tabsByWorktree
  }
}
