import type { PasteTerminalTextDetail } from '@/constants/terminal'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import type { PtyTransport } from './pty-transport'
import { getConnectionId } from '@/lib/connection-context'
import { pasteTerminalText, wrapTerminalBracketedPasteText } from './terminal-bracketed-paste'
import { recordTerminalUserInputForLeaf } from './terminal-input-activity'
import { executeTerminalPastePlan, planTerminalPasteWithYield } from './terminal-paste-coordinator'
import { resolveTerminalPasteRuntime } from './terminal-paste-runtime'
import { getTerminalPasteSshRemotePlatform } from './terminal-paste-ssh-platform'
import { isTerminalPanePasteTargetCurrent } from './terminal-paste-target-state'
import { writeTerminalPastePtyInput } from './terminal-pty-paste-writer'

type HandleTerminalProgrammaticTextPasteArgs = {
  detail: PasteTerminalTextDetail | undefined
  tabId: string
  worktreeId: string
  getManager: () => PaneManager | null
  getPaneTransports: () => Map<number, PtyTransport>
}

export function handleTerminalProgrammaticTextPaste({
  detail,
  tabId,
  worktreeId,
  getManager,
  getPaneTransports
}: HandleTerminalProgrammaticTextPasteArgs): void {
  if (!detail?.tabId || detail.tabId !== tabId || !detail.text) {
    return
  }
  detail.onReceived?.()
  const manager = getManager()
  if (!manager) {
    detail.onSettled?.(false)
    return
  }
  const panes = manager.getPanes()
  const pane =
    typeof detail.paneId === 'number'
      ? (panes.find((candidate) => candidate.id === detail.paneId) ?? null)
      : (manager.getActivePane() ?? panes[0])
  if (!pane) {
    detail.onSettled?.(false)
    return
  }
  const paneTransports = getPaneTransports()
  const transport = paneTransports.get(pane.id)
  const ptyId = transport?.getPtyId() ?? null
  if (!transport || !ptyId || !transport.isConnected()) {
    detail.onSettled?.(false)
    return
  }
  if (detail.directPtyDraft) {
    if (detail.requireShellPasteReady && !pane.terminal.modes?.bracketedPasteMode) {
      // Why: zsh may accept bytes before its final prompt repaint, which then
      // erases setup drafts. Let the caller retry after shell paste mode is armed.
      detail.onSettled?.(false)
      return
    }
    // Why: zsh can repaint its line editor during startup after accepting raw
    // bytes. Preserve the editable draft with the shell's active paste protocol.
    const draftInput = pane.terminal.modes?.bracketedPasteMode
      ? wrapTerminalBracketedPasteText(detail.text)
      : detail.text
    void Promise.resolve(writeTerminalPastePtyInput(transport, draftInput))
      .then((accepted) => {
        if (accepted) {
          recordTerminalUserInputForLeaf(tabId, pane.leafId)
          pane.terminal.focus()
        }
        detail.onSettled?.(accepted)
      })
      .catch(() => detail.onSettled?.(false))
    return
  }
  const platform = getShortcutPlatform()
  const connectionId = getConnectionId(worktreeId) ?? null
  void planTerminalPasteWithYield({
    text: detail.text,
    source: 'programmatic',
    target: {
      kind: 'terminal',
      paneId: pane.id,
      leafId: pane.leafId,
      ptyId,
      runtime: resolveTerminalPasteRuntime({
        platform,
        ptyId,
        connectionId,
        remotePlatform: getTerminalPasteSshRemotePlatform(connectionId),
        transport
      })
    },
    terminalBracketedPasteMode: pane.terminal.modes?.bracketedPasteMode === true
  })
    .then((plan) =>
      executeTerminalPastePlan(plan, {
        pasteText: (text, options) => pasteTerminalText(pane.terminal, text, options),
        writePty: (data) => writeTerminalPastePtyInput(transport, data),
        isTargetCurrent: () =>
          isTerminalPanePasteTargetCurrent({
            manager: getManager(),
            paneTransports: getPaneTransports(),
            paneId: pane.id,
            leafId: pane.leafId,
            transport,
            ptyId
          }),
        canContinue: () =>
          isTerminalPanePasteTargetCurrent({
            manager: getManager(),
            paneTransports: getPaneTransports(),
            paneId: pane.id,
            leafId: pane.leafId,
            transport,
            ptyId
          })
      })
    )
    .then((result) => {
      if (result.status !== 'pasted') {
        detail.onSettled?.(false)
        return
      }
      recordTerminalUserInputForLeaf(tabId, pane.leafId)
      pane.terminal.focus()
      // Why: a connected transport can still become stale during async paste
      // planning. Setup flows stop retrying only after bytes were really written.
      detail.onSettled?.(true)
    })
    .catch(() => detail.onSettled?.(false))
}

function getShortcutPlatform(userAgent = globalThis.navigator?.userAgent ?? ''): NodeJS.Platform {
  if (userAgent.includes('Mac')) {
    return 'darwin'
  }
  return userAgent.includes('Windows') ? 'win32' : 'linux'
}
