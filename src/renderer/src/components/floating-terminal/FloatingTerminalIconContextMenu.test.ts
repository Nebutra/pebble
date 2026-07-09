import { describe, expect, it } from 'vitest'
import { getFloatingTerminalMenuSide } from './floating-terminal-menu-side'

describe('getFloatingTerminalMenuSide', () => {
  it('opens away from the nearest vertical viewport edge', () => {
    expect(getFloatingTerminalMenuSide(120, 800)).toBe('bottom')
    expect(getFloatingTerminalMenuSide(720, 800)).toBe('top')
  })

  it('falls back to bottom when viewport height is unavailable', () => {
    expect(getFloatingTerminalMenuSide(720, 0)).toBe('bottom')
  })
})
