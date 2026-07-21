import { describe, expect, it, vi } from 'vitest'
import {
  EMPTY_HOST_TERMINAL_CAPABILITIES,
  normalizeHostTerminalCapabilities,
  readSshTerminalCapabilities
} from './host-terminal-capabilities'

describe('host terminal capability normalization', () => {
  it('preserves a valid remote Windows capability snapshot', () => {
    expect(
      normalizeHostTerminalCapabilities({
        wslAvailable: true,
        wslDistros: ['Ubuntu', 'Debian'],
        pwshAvailable: true,
        gitBashAvailable: true,
        hostPlatform: 'win32'
      })
    ).toEqual({
      wslAvailable: true,
      wslDistros: ['Ubuntu', 'Debian'],
      pwshAvailable: true,
      gitBashAvailable: true,
      hostPlatform: 'win32'
    })
  })

  it('queries relay-only SSH capabilities by encoded target id', async () => {
    const fetcher = vi.fn().mockResolvedValue({ hostPlatform: 'linux', wslDistros: [] })
    await expect(readSshTerminalCapabilities(fetcher, 'host/one')).resolves.toEqual({
      ...EMPTY_HOST_TERMINAL_CAPABILITIES,
      hostPlatform: 'linux'
    })
    expect(fetcher).toHaveBeenCalledWith(
      '/v1/ssh-targets/host%2Fone/terminal-capabilities',
      expect.objectContaining({ method: 'GET' })
    )
  })

  it('does not advertise malformed or local fallback values', () => {
    expect(
      normalizeHostTerminalCapabilities({
        wslAvailable: 'yes',
        wslDistros: ['Ubuntu', 7],
        pwshAvailable: 1,
        gitBashAvailable: null,
        hostPlatform: 'windows'
      })
    ).toEqual({ ...EMPTY_HOST_TERMINAL_CAPABILITIES, wslDistros: ['Ubuntu'] })
  })
})
