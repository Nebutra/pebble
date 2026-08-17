import { describe, expect, it } from 'vitest'
import {
  canRecoverWebglAfterContextLoss,
  forgetWebglContextLosses,
  recordWebglContextLoss,
  WEBGL_CONTEXT_LOSS_COOL_OFF_MS,
  WEBGL_CONTEXT_LOSS_RECOVERY_ATTEMPTS
} from './terminal-webgl-context-loss-recovery'

const NOW = 1_000_000

describe('WebGL context-loss recovery', () => {
  it('lets a pane that never lost a context use WebGL', () => {
    expect(canRecoverWebglAfterContextLoss(forgetWebglContextLosses(), NOW)).toBe(true)
  })

  it('holds a pane on DOM until the cool-off has passed', () => {
    // Why: retrying straight after a loss can loop the loss and leave xterm
    // blank, which is why the original code latched instead.
    const state = recordWebglContextLoss(forgetWebglContextLosses(), NOW)

    expect(canRecoverWebglAfterContextLoss(state, NOW + 1_000)).toBe(false)
    expect(canRecoverWebglAfterContextLoss(state, NOW + WEBGL_CONTEXT_LOSS_COOL_OFF_MS)).toBe(true)
  })

  it('stops trying once the attempts are spent', () => {
    let state = forgetWebglContextLosses()
    for (let attempt = 0; attempt <= WEBGL_CONTEXT_LOSS_RECOVERY_ATTEMPTS; attempt += 1) {
      state = recordWebglContextLoss(state, NOW)
    }

    // A display that genuinely cannot hold a context must not be asked forever.
    expect(canRecoverWebglAfterContextLoss(state, NOW + WEBGL_CONTEXT_LOSS_COOL_OFF_MS * 100)).toBe(
      false
    )
  })

  it('recovers within the allowance rather than pinning DOM for the session', () => {
    // Why: this is the bug. One transient loss used to mean a permanently slow
    // terminal, because only a manual GPU-setting change cleared the latch.
    const state = recordWebglContextLoss(forgetWebglContextLosses(), NOW)

    expect(canRecoverWebglAfterContextLoss(state, NOW + WEBGL_CONTEXT_LOSS_COOL_OFF_MS + 1)).toBe(
      true
    )
  })

  it('forgets the history once a context has held', () => {
    let state = forgetWebglContextLosses()
    for (let attempt = 0; attempt <= WEBGL_CONTEXT_LOSS_RECOVERY_ATTEMPTS; attempt += 1) {
      state = recordWebglContextLoss(state, NOW)
    }
    expect(canRecoverWebglAfterContextLoss(state, NOW + WEBGL_CONTEXT_LOSS_COOL_OFF_MS)).toBe(false)

    // Why: two unrelated hiccups hours apart must not add up to "this pane
    // cannot hold a context".
    expect(canRecoverWebglAfterContextLoss(forgetWebglContextLosses(), NOW)).toBe(true)
  })
})
