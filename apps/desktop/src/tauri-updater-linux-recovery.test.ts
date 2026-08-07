import { describe, expect, it } from 'vitest'
import {
  describeLinuxUpdateRefusal,
  type LinuxUpdateRecovery
} from './tauri-updater-linux-recovery'

const RELEASE_URL = 'https://github.com/Nebutra/pebble/releases/tag/v1.4.134'

function recovery(overrides: Partial<LinuxUpdateRecovery> = {}): LinuxUpdateRecovery {
  return {
    installKind: 'system',
    escalator: '/usr/bin/sudo',
    packageManager: '/usr/bin/apt',
    installCommand: "/usr/bin/sudo /usr/bin/apt install -- '<package>'",
    reason: null,
    ...overrides
  }
}

describe('linux update refusal', () => {
  it('names the exact command and how to substitute the downloaded file', () => {
    const message = describeLinuxUpdateRefusal(recovery(), RELEASE_URL)

    expect(message).toContain(RELEASE_URL)
    expect(message).toContain("/usr/bin/sudo /usr/bin/apt install -- '<package>'")
    expect(message).toContain('keeping the quotes')
  })

  it('never promises an AppImage build Pebble does not ship', () => {
    expect(describeLinuxUpdateRefusal(recovery(), RELEASE_URL)).not.toContain('AppImage')
  })

  it('explains a missing escalator instead of printing a command that would fail', () => {
    const message = describeLinuxUpdateRefusal(
      recovery({ escalator: null, installCommand: null, reason: 'no-escalator' }),
      RELEASE_URL
    )

    expect(message).toContain('no sudo or pkexec')
    expect(message).toContain(RELEASE_URL)
    expect(message).not.toContain('install --')
  })

  it('explains a missing package manager', () => {
    const message = describeLinuxUpdateRefusal(
      recovery({ packageManager: null, installCommand: null, reason: 'no-package-manager' }),
      RELEASE_URL
    )

    expect(message).toContain('no supported package manager')
  })

  it('degrades to generic guidance when the runtime reports nothing', () => {
    const message = describeLinuxUpdateRefusal(null, RELEASE_URL)

    expect(message).toContain(RELEASE_URL)
    expect(message).toContain('your package manager')
    expect(message).not.toContain('Pebble found no')
  })

  it('degrades to generic guidance for an unrecognized reason', () => {
    const message = describeLinuxUpdateRefusal(
      recovery({ installCommand: null, reason: 'not-applicable' }),
      RELEASE_URL
    )

    expect(message).toContain('your package manager')
    expect(message).not.toContain('Pebble found no')
  })
})
