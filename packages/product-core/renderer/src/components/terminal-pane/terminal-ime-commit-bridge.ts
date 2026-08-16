// Why: xterm commits composed text through its own composition helper, and on a
// standards-shaped WebView that is the whole story. ArkWeb (the HarmonyOS web
// shell) ends a composition without xterm ever emitting the composed text, so an
// IME candidate can be chosen and nothing reaches the PTY — the terminal shows a
// prompt and refuses every keystroke.
//
// This does not sniff for that shell. It watches whether xterm forwarded the
// composition itself and only fills the gap when it did not, so on a WebView
// where composition already works this is inert and cannot double-send.

export type TerminalImeCommitBridge = {
  /** Called from the terminal's own data handler, so the bridge can tell whether xterm already committed. */
  noteTerminalData: () => void
  dispose: () => void
}

// Long enough for a compliant helper to emit on the same task, short enough that
// a real gap is filled before the next keystroke.
const COMMIT_GRACE_MS = 24

type CompositionTarget = Pick<
  HTMLTextAreaElement,
  'addEventListener' | 'removeEventListener' | 'value'
>

export function createTerminalImeCommitBridge(args: {
  textarea: CompositionTarget
  onCommit: (text: string) => void
  scheduleCheck?: (check: () => void) => () => void
}): TerminalImeCommitBridge {
  const schedule =
    args.scheduleCheck ??
    ((check: () => void) => {
      const handle = setTimeout(check, COMMIT_GRACE_MS)
      return () => clearTimeout(handle)
    })

  let dataSinceCompositionStart = 0
  let cancelPendingCheck: (() => void) | null = null

  const handleCompositionStart = (): void => {
    dataSinceCompositionStart = 0
  }

  const handleCompositionEnd = (event: Event): void => {
    // Why: some shells leave `data` empty on the event and only update the
    // textarea, so the element's value is the more reliable of the two.
    const composed = (event as CompositionEvent).data || args.textarea.value || ''
    cancelPendingCheck?.()
    cancelPendingCheck = schedule(() => {
      cancelPendingCheck = null
      if (dataSinceCompositionStart > 0 || composed === '') {
        return
      }
      args.onCommit(composed)
    })
  }

  args.textarea.addEventListener('compositionstart', handleCompositionStart)
  args.textarea.addEventListener('compositionend', handleCompositionEnd)

  return {
    noteTerminalData: () => {
      dataSinceCompositionStart += 1
    },
    dispose: () => {
      cancelPendingCheck?.()
      cancelPendingCheck = null
      args.textarea.removeEventListener('compositionstart', handleCompositionStart)
      args.textarea.removeEventListener('compositionend', handleCompositionEnd)
    }
  }
}
