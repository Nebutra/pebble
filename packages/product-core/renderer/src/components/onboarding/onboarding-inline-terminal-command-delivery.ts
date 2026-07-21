import { PASTE_TERMINAL_TEXT_EVENT, type PasteTerminalTextDetail } from '@/constants/terminal'

// DOM-facing command delivery/readiness helpers, split out of
// OnboardingInlineCommandTerminal.tsx so the component stays focused on render
// and lifecycle wiring.

// Why: a cold native runtime or SSH-backed shell can take longer than Electron's
// local daemon to bind its stable pane; keep waiting, but retain a finite cap.
export const READY_MAX_ATTEMPTS = 300
export const INSERT_ACK_TIMEOUT_MS = 500
export const INSERT_NATIVE_ACK_TIMEOUT_MS = 10_000

export function dispatchTerminalTextWithAcknowledgement({
  tabId,
  text,
  onSettled,
  acknowledgementTimeoutMs = INSERT_ACK_TIMEOUT_MS,
  nativeAcknowledgementTimeoutMs = INSERT_NATIVE_ACK_TIMEOUT_MS
}: {
  tabId: string
  text: string
  onSettled: (pasted: boolean) => void
  acknowledgementTimeoutMs?: number
  nativeAcknowledgementTimeoutMs?: number
}): () => void {
  let settled = false
  let timeout: number | null = null
  const settle = (pasted: boolean): void => {
    if (settled) {
      return
    }
    settled = true
    if (timeout !== null) {
      window.clearTimeout(timeout)
    }
    onSettled(pasted)
  }
  // Why: DOM events dispatched before TerminalPane mounts have no receiver.
  // Treat missing acknowledgement as a retryable delivery failure.
  timeout = window.setTimeout(() => settle(false), acknowledgementTimeoutMs)
  window.dispatchEvent(
    new CustomEvent<PasteTerminalTextDetail>(PASTE_TERMINAL_TEXT_EVENT, {
      detail: {
        tabId,
        text,
        directPtyDraft: true,
        requireShellPasteReady: true,
        onReceived: () => {
          // Why: Tauri can deliver the event before a cold native PTY answers.
          // Separate listener delivery from the slower native write ACK.
          if (timeout !== null) {
            window.clearTimeout(timeout)
          }
          timeout = window.setTimeout(() => settle(false), nativeAcknowledgementTimeoutMs)
        },
        onSettled: settle
      }
    })
  )
  return () => {
    settled = true
    if (timeout !== null) {
      window.clearTimeout(timeout)
    }
  }
}

export function findTerminalTabElement(tabId: string): HTMLElement | null {
  for (const element of document.querySelectorAll<HTMLElement>('[data-terminal-tab-id]')) {
    if (element.dataset.terminalTabId === tabId) {
      return element
    }
  }
  return null
}

export function focusInlineTerminalSurface(tabId: string): boolean {
  const terminalElement = findTerminalTabElement(tabId)
  const input = terminalElement?.querySelector<HTMLElement>('.xterm-helper-textarea') ?? null
  if (!input) {
    return false
  }
  input.focus({ preventScroll: true })
  return document.activeElement === input
}

export function getNextTerminalReadyRetryAttempt(attempt: number): number | null {
  return attempt < READY_MAX_ATTEMPTS ? attempt + 1 : null
}

export function terminalReadyForCommand(element: HTMLElement | null): boolean {
  if (!element?.querySelector('[data-pty-id]')) {
    return false
  }
  // Why: pasting before the login shell renders a prompt can double-echo the
  // draft command. Visible terminal text is the least intrusive readiness signal.
  const renderedText = element.querySelector('.xterm-rows')?.textContent?.trim() ?? ''
  return renderedText.length > 0
}
