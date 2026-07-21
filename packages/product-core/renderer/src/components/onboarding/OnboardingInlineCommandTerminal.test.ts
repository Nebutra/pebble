// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { PASTE_TERMINAL_TEXT_EVENT, type PasteTerminalTextDetail } from '../../constants/terminal'
import {
  dispatchTerminalTextWithAcknowledgement,
  focusInlineTerminalSurface,
  getNextTerminalReadyRetryAttempt,
  READY_MAX_ATTEMPTS
} from './OnboardingInlineCommandTerminal'

afterEach(() => {
  vi.useRealTimers()
  document.body.innerHTML = ''
})

describe('getNextTerminalReadyRetryAttempt', () => {
  it('stops scheduling readiness checks after the capped number of attempts', () => {
    let attempt = 0
    let scheduledRetries = 0

    while (true) {
      const nextAttempt = getNextTerminalReadyRetryAttempt(attempt)
      if (nextAttempt === null) {
        break
      }
      scheduledRetries += 1
      attempt = nextAttempt
    }

    expect(scheduledRetries).toBe(READY_MAX_ATTEMPTS)
    expect(attempt).toBe(READY_MAX_ATTEMPTS)
    expect(getNextTerminalReadyRetryAttempt(READY_MAX_ATTEMPTS)).toBeNull()
  })
})

describe('dispatchTerminalTextWithAcknowledgement', () => {
  it('reports a retryable failure when the terminal listener is not mounted yet', () => {
    vi.useFakeTimers()
    const onSettled = vi.fn()

    dispatchTerminalTextWithAcknowledgement({
      tabId: 'tab-1',
      text: 'npx skills add computer-use --global',
      onSettled,
      acknowledgementTimeoutMs: 25,
      nativeAcknowledgementTimeoutMs: 25
    })
    vi.advanceTimersByTime(25)

    expect(onSettled).toHaveBeenCalledOnce()
    expect(onSettled).toHaveBeenCalledWith(false)
  })

  it('settles once when the terminal acknowledges before the timeout', () => {
    vi.useFakeTimers()
    const onSettled = vi.fn()
    const listener = (event: Event): void => {
      const detail = (event as CustomEvent<PasteTerminalTextDetail>).detail
      expect(detail.directPtyDraft).toBe(true)
      expect(detail.requireShellPasteReady).toBe(true)
      detail.onReceived?.()
      detail.onSettled?.(true)
    }
    window.addEventListener(PASTE_TERMINAL_TEXT_EVENT, listener)

    dispatchTerminalTextWithAcknowledgement({
      tabId: 'tab-1',
      text: 'npx skills add computer-use --global',
      onSettled,
      acknowledgementTimeoutMs: 25
    })
    vi.advanceTimersByTime(25)
    window.removeEventListener(PASTE_TERMINAL_TEXT_EVENT, listener)

    expect(onSettled).toHaveBeenCalledOnce()
    expect(onSettled).toHaveBeenCalledWith(true)
  })

  it('keeps waiting for a cold native PTY after the terminal listener receives the draft', () => {
    vi.useFakeTimers()
    const onSettled = vi.fn()
    let acknowledge: ((pasted: boolean) => void) | undefined
    const listener = (event: Event): void => {
      const detail = (event as CustomEvent<PasteTerminalTextDetail>).detail
      detail.onReceived?.()
      acknowledge = detail.onSettled
    }
    window.addEventListener(PASTE_TERMINAL_TEXT_EVENT, listener)

    dispatchTerminalTextWithAcknowledgement({
      tabId: 'tab-1',
      text: 'npx skills add computer-use --global',
      onSettled,
      acknowledgementTimeoutMs: 25,
      nativeAcknowledgementTimeoutMs: 2_000
    })
    vi.advanceTimersByTime(500)
    expect(onSettled).not.toHaveBeenCalled()
    acknowledge?.(true)
    vi.advanceTimersByTime(2_000)
    window.removeEventListener(PASTE_TERMINAL_TEXT_EVENT, listener)

    expect(onSettled).toHaveBeenCalledOnce()
    expect(onSettled).toHaveBeenCalledWith(true)
  })

  it('ignores a terminal acknowledgement that arrives after delivery timed out', () => {
    vi.useFakeTimers()
    const onSettled = vi.fn()
    let acknowledge: ((pasted: boolean) => void) | undefined
    const listener = (event: Event): void => {
      const detail = (event as CustomEvent<PasteTerminalTextDetail>).detail
      acknowledge = detail.onSettled
    }
    window.addEventListener(PASTE_TERMINAL_TEXT_EVENT, listener)

    dispatchTerminalTextWithAcknowledgement({
      tabId: 'tab-1',
      text: 'npx skills add computer-use --global',
      onSettled,
      acknowledgementTimeoutMs: 25
    })
    vi.advanceTimersByTime(25)
    acknowledge?.(true)
    window.removeEventListener(PASTE_TERMINAL_TEXT_EVENT, listener)

    expect(onSettled).toHaveBeenCalledOnce()
    expect(onSettled).toHaveBeenCalledWith(false)
  })

  it('keeps retry timeout armed when the terminal only receives the event', () => {
    vi.useFakeTimers()
    const onSettled = vi.fn()
    const listener = (event: Event): void => {
      const detail = (event as CustomEvent<PasteTerminalTextDetail>).detail
      detail.onReceived?.()
    }
    window.addEventListener(PASTE_TERMINAL_TEXT_EVENT, listener)

    dispatchTerminalTextWithAcknowledgement({
      tabId: 'tab-1',
      text: 'npx skills add computer-use --global',
      onSettled,
      acknowledgementTimeoutMs: 25,
      nativeAcknowledgementTimeoutMs: 25
    })
    vi.advanceTimersByTime(25)
    window.removeEventListener(PASTE_TERMINAL_TEXT_EVENT, listener)

    expect(onSettled).toHaveBeenCalledOnce()
    expect(onSettled).toHaveBeenCalledWith(false)
  })
})

describe('focusInlineTerminalSurface', () => {
  it('focuses only the requested inline terminal input', () => {
    document.body.innerHTML = `
      <div data-terminal-tab-id="other"><textarea class="xterm-helper-textarea"></textarea></div>
      <div data-terminal-tab-id="setup"><textarea class="xterm-helper-textarea"></textarea></div>
    `

    expect(focusInlineTerminalSurface('setup')).toBe(true)
    expect(document.activeElement).toBe(
      document.querySelector('[data-terminal-tab-id="setup"] .xterm-helper-textarea')
    )
  })

  it('does not fall back to an unrelated terminal', () => {
    document.body.innerHTML = `
      <div data-terminal-tab-id="other"><textarea class="xterm-helper-textarea"></textarea></div>
    `

    expect(focusInlineTerminalSurface('missing')).toBe(false)
    expect(document.activeElement).toBe(document.body)
  })
})
