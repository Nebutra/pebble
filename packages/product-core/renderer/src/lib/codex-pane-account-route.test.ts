import { describe, expect, it } from 'vitest'
import { getCodexPaneAccountRouteKey } from './codex-pane-account-route'

describe('getCodexPaneAccountRouteKey', () => {
  it('keeps the host route separate from every WSL route', () => {
    expect(getCodexPaneAccountRouteKey({ runtime: 'host' })).toBe('host')
    expect(getCodexPaneAccountRouteKey({ runtime: 'wsl', wslDistro: 'Ubuntu' })).not.toBe('host')
  })

  it('keeps distinct WSL distros apart', () => {
    expect(getCodexPaneAccountRouteKey({ runtime: 'wsl', wslDistro: 'Ubuntu' })).not.toBe(
      getCodexPaneAccountRouteKey({ runtime: 'wsl', wslDistro: 'Debian' })
    )
  })

  it('folds a blank distro onto the shared WSL default key', () => {
    const fallback = getCodexPaneAccountRouteKey({ runtime: 'wsl', wslDistro: null })
    expect(getCodexPaneAccountRouteKey({ runtime: 'wsl' })).toBe(fallback)
    expect(getCodexPaneAccountRouteKey({ runtime: 'wsl', wslDistro: '  ' })).toBe(fallback)
  })

  it('ignores surrounding whitespace so a distro matches its own panes', () => {
    expect(getCodexPaneAccountRouteKey({ runtime: 'wsl', wslDistro: ' Ubuntu ' })).toBe(
      getCodexPaneAccountRouteKey({ runtime: 'wsl', wslDistro: 'Ubuntu' })
    )
  })
})
