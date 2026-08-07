import { describe, expect, it } from 'vitest'
import { getCodexPaneAccountRouteKey, resolveSwitchedCodexRoute } from './codex-pane-account-route'

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

describe('resolveSwitchedCodexRoute', () => {
  it('falls back to the account distro when the picker names none', () => {
    // Why: selectCodexAccount stores the selection under the account's own
    // distro in this case, so the route has to land on the same concrete key.
    expect(
      resolveSwitchedCodexRoute({ runtime: 'wsl', wslDistro: null }, { wslDistro: 'Ubuntu' })
    ).toEqual({ runtime: 'wsl', wslDistro: 'Ubuntu' })
  })

  it('prefers the explicitly picked distro over the account distro', () => {
    expect(
      resolveSwitchedCodexRoute({ runtime: 'wsl', wslDistro: 'Debian' }, { wslDistro: 'Ubuntu' })
    ).toEqual({ runtime: 'wsl', wslDistro: 'Debian' })
  })

  it('drops the distro entirely for a host selection', () => {
    expect(
      resolveSwitchedCodexRoute({ runtime: 'host', wslDistro: 'Ubuntu' }, { wslDistro: 'Ubuntu' })
    ).toEqual({ runtime: 'host' })
  })

  it('stays on the shared WSL default when neither side names a distro', () => {
    expect(resolveSwitchedCodexRoute({ runtime: 'wsl', wslDistro: null }, undefined)).toEqual({
      runtime: 'wsl',
      wslDistro: null
    })
  })
})
