/* eslint-disable max-lines -- WSL CLI tests cover one installer state machine with shared
   runner fixtures; splitting would duplicate the fake WSL filesystem setup. */
import type { CliInstallStatus } from '../../shared/cli-install-types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const execFileMock = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', () => ({
  execFile: execFileMock
}))

import { WslCliInstaller, _internals } from './wsl-cli-installer'

function makeHostStatus(
  launcherPath = 'C:\\Users\\me\\AppData\\Local\\Programs\\Pebble\\resources\\bin\\pebble.cmd'
) {
  return {
    platform: 'win32',
    commandName: 'pebble',
    commandPath: 'C:\\Users\\me\\AppData\\Local\\Programs\\Pebble\\bin\\pebble.cmd',
    pathDirectory: 'C:\\Users\\me\\AppData\\Local\\Programs\\Pebble\\bin',
    pathConfigured: true,
    launcherPath,
    installMethod: 'wrapper',
    supported: true,
    state: 'installed',
    currentTarget: launcherPath,
    unsupportedReason: null,
    detail: null
  } satisfies CliInstallStatus
}

function createWslRunner(initialFile: string | null = null, pathIncludesLocalBin = true) {
  const commandPath = '/home/alice/.local/bin/pebble-ide'
  const bridgePath = '/home/alice/.local/share/pebble/pebble-wsl-bridge.ps1'
  const files = new Map<string, string>()
  if (initialFile !== null) {
    files.set(commandPath, initialFile)
    files.set(bridgePath, _internals.buildWslBridgeScript())
  }
  const calls: string[] = []
  const runner = vi.fn(async (_distro: string, command: string) => {
    calls.push(command)
    if (command.includes('printf %s "$HOME"')) {
      return '/home/alice'
    }
    if (command.includes('case ":$PATH:"')) {
      return pathIncludesLocalBin ? 'yes' : 'no'
    }
    if (command.includes('cat > "$command_tmp"')) {
      const launcher =
        command.match(/cat > "\$command_tmp" <<'PEBBLE_WSL_CLI'\n([\s\S]*)\nPEBBLE_WSL_CLI/)?.[1] ?? ''
      const bridge =
        command.match(
          /cat > "\$bridge_tmp" <<'PEBBLE_WSL_BRIDGE'\n([\s\S]*)\nPEBBLE_WSL_BRIDGE/
        )?.[1] ?? ''
      files.set(commandPath, launcher)
      files.set(bridgePath, bridge)
      return ''
    }
    if (command.includes('command -v powershell.exe')) {
      return 'yes'
    }
    if (command.includes('rm -f')) {
      if (
        files.has(bridgePath) &&
        !files.get(bridgePath)?.includes('# Pebble managed WSL CLI PowerShell bridge')
      ) {
        throw new Error('__PEBBLE_CONFLICT__')
      }
      files.delete(commandPath)
      files.delete(bridgePath)
      return ''
    }
    if (command.includes('cat ')) {
      if (command.includes(commandPath)) {
        return files.get(commandPath) ?? '__PEBBLE_MISSING__'
      }
      if (command.includes(bridgePath)) {
        return files.get(bridgePath) ?? '__PEBBLE_MISSING__'
      }
    }
    throw new Error(`Unexpected WSL command: ${command}`)
  })
  return {
    runner,
    calls,
    getBridge: () => files.get(bridgePath) ?? null,
    getFile: () => files.get(commandPath) ?? null
  }
}

describe('WslCliInstaller', () => {
  beforeEach(() => {
    execFileMock.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('installs a WSL launcher that forwards to the Windows Pebble launcher', async () => {
    const wsl = createWslRunner()
    const installer = new WslCliInstaller({
      platform: 'win32',
      distro: 'Ubuntu',
      hostInstaller: { getStatus: async () => makeHostStatus() },
      wslRunner: wsl.runner
    })

    await expect(installer.getStatus()).resolves.toMatchObject({
      state: 'not_installed',
      commandPath: '/home/alice/.local/bin/pebble-ide'
    })

    const installed = await installer.install()

    expect(installed).toMatchObject({
      state: 'installed',
      pathConfigured: true,
      launcherPath: 'C:\\Users\\me\\AppData\\Local\\Programs\\Pebble\\resources\\bin\\pebble.cmd'
    })
    expect(wsl.getFile()).toBe(
      _internals.buildWslLauncher(
        'C:\\Users\\me\\AppData\\Local\\Programs\\Pebble\\resources\\bin\\pebble.cmd',
        '/home/alice/.local/share/pebble/pebble-wsl-bridge.ps1'
      )
    )
    expect(wsl.getBridge()).toBe(_internals.buildWslBridgeScript())
    const installCommand = wsl.calls.find((command) => command.includes('cat > "$command_tmp"'))
    expect(installCommand).toContain("legacy_command_path='/home/alice/.local/bin/pebble'")
    expect(installCommand).toContain('rm -f "$legacy_command_path"')
  })

  it('derives the shared WSL bridge path for current and legacy command names', () => {
    expect(_internals.getBridgePathFromCommandPath('/home/alice/.local/bin/pebble-ide')).toBe(
      '/home/alice/.local/share/pebble/pebble-wsl-bridge.ps1'
    )
    expect(_internals.getBridgePathFromCommandPath('/home/alice/.local/bin/pebble')).toBe(
      '/home/alice/.local/share/pebble/pebble-wsl-bridge.ps1'
    )
  })

  it('reports installed WSL launchers whose bin directory is missing from PATH', async () => {
    const launcher = _internals.buildWslLauncher(
      'C:\\Pebble\\pebble.cmd',
      '/home/alice/.local/share/pebble/pebble-wsl-bridge.ps1'
    )
    const wsl = createWslRunner(launcher, false)
    const installer = new WslCliInstaller({
      platform: 'win32',
      distro: 'Ubuntu',
      hostInstaller: { getStatus: async () => makeHostStatus('C:\\Pebble\\pebble.cmd') },
      wslRunner: wsl.runner
    })

    await expect(installer.getStatus()).resolves.toMatchObject({
      state: 'installed',
      pathConfigured: false,
      detail: expect.stringContaining('not on PATH')
    })
  })

  it('accepts current managed WSL scripts with an extra heredoc trailing newline', async () => {
    const launcher = `${_internals.buildWslLauncher(
      'C:\\Pebble\\pebble.cmd',
      '/home/alice/.local/share/pebble/pebble-wsl-bridge.ps1'
    )}\n`
    const wsl = createWslRunner(launcher)
    const installer = new WslCliInstaller({
      platform: 'win32',
      distro: 'Ubuntu',
      hostInstaller: { getStatus: async () => makeHostStatus('C:\\Pebble\\pebble.cmd') },
      wslRunner: async (distro, command) => {
        if (command.includes('cat /home/alice/.local/share/pebble/pebble-wsl-bridge.ps1')) {
          return `${_internals.buildWslBridgeScript()}\n`
        }
        return wsl.runner(distro, command)
      }
    })

    await expect(installer.getStatus()).resolves.toMatchObject({
      state: 'installed',
      currentTarget: 'C:\\Pebble\\pebble.cmd'
    })
  })

  it('refuses to replace an unmanaged WSL command', async () => {
    const wsl = createWslRunner('#!/usr/bin/env bash\necho elsewhere\n')
    const installer = new WslCliInstaller({
      platform: 'win32',
      distro: 'Ubuntu',
      hostInstaller: { getStatus: async () => makeHostStatus() },
      wslRunner: wsl.runner
    })

    await expect(installer.getStatus()).resolves.toMatchObject({ state: 'conflict' })
    await expect(installer.install()).rejects.toThrow('Refusing to replace')
  })

  it('removes a managed WSL launcher', async () => {
    const wsl = createWslRunner(
      _internals.buildWslLauncher(
        'C:\\Pebble\\pebble.cmd',
        '/home/alice/.local/share/pebble/pebble-wsl-bridge.ps1'
      )
    )
    const installer = new WslCliInstaller({
      platform: 'win32',
      distro: 'Ubuntu',
      hostInstaller: { getStatus: async () => makeHostStatus('C:\\Pebble\\pebble.cmd') },
      wslRunner: wsl.runner
    })

    await expect(installer.remove()).resolves.toMatchObject({ state: 'not_installed' })
    expect(wsl.getFile()).toBeNull()
  })

  it('generates a launcher that forwards arguments through a PowerShell file bridge', () => {
    const launcher = _internals.buildWslLauncher(
      'C:\\Program Files\\Pebble\\pebble.cmd',
      '/home/alice/.local/share/pebble/pebble-wsl-bridge.ps1'
    )
    const bridge = _internals.buildWslBridgeScript()

    expect(launcher).toContain('command -v powershell.exe')
    expect(launcher).toContain('/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe')
    expect(launcher).toContain(
      'Pebble WSL CLI requires Windows interop and could not find powershell.exe.'
    )
    expect(launcher).toContain('"$PEBBLE_POWERSHELL" -NoProfile -ExecutionPolicy Bypass -File')
    expect(launcher).toContain('"$PEBBLE_WIN_LAUNCHER" "$@"')
    expect(launcher).not.toContain('-Command')
    expect(bridge).toContain('[Parameter(ValueFromRemainingArguments=$true)]')
    expect(bridge).toContain('& $PebbleLauncher @ForwardArgs')
    expect(bridge).toContain('catch')
    expect(bridge).toContain('exit 1')
  })

  it('wraps WSL bash scripts as a single encoded command line', () => {
    const command = [
      'set -euo pipefail',
      `cat > "$command_tmp" <<'PEBBLE_WSL_CLI'`,
      '#!/usr/bin/env bash',
      'exec powershell.exe "$@"',
      'PEBBLE_WSL_CLI'
    ].join('\n')
    const wrapped = _internals.buildEncodedWslBashCommand(command)
    const encoded = wrapped.match(
      /^set -o pipefail; printf %s '([^']+)' \| base64 -d \| bash$/
    )?.[1]

    expect(wrapped).not.toContain('\n')
    expect(wrapped).toContain('set -o pipefail;')
    expect(encoded).toBeTruthy()
    expect(Buffer.from(encoded as string, 'base64').toString('utf8')).toBe(command)
  })

  it('treats absolute Windows PowerShell as interop-ready when powershell.exe is missing from PATH', async () => {
    const wsl = createWslRunner()
    const installer = new WslCliInstaller({
      platform: 'win32',
      distro: 'Ubuntu',
      hostInstaller: { getStatus: async () => makeHostStatus() },
      wslRunner: async (distro, command) => {
        if (command.includes('command -v powershell.exe') && !command.includes('cat >')) {
          expect(command).toContain('/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe')
          return 'yes'
        }
        return wsl.runner(distro, command)
      }
    })

    await expect(installer.getStatus()).resolves.toMatchObject({
      state: 'not_installed',
      commandPath: '/home/alice/.local/bin/pebble-ide'
    })
  })

  it('marks stale managed launchers that point at the old app bin instead of packaged resources', async () => {
    const oldLauncher = _internals.buildWslLauncher(
      'C:\\Users\\me\\AppData\\Local\\Programs\\Pebble\\bin\\pebble.cmd',
      '/home/alice/.local/share/pebble/pebble-wsl-bridge.ps1'
    )
    const wsl = createWslRunner(oldLauncher)
    const installer = new WslCliInstaller({
      platform: 'win32',
      distro: 'Ubuntu',
      hostInstaller: { getStatus: async () => makeHostStatus() },
      wslRunner: wsl.runner
    })

    await expect(installer.getStatus()).resolves.toMatchObject({
      state: 'stale',
      currentTarget: 'C:\\Users\\me\\AppData\\Local\\Programs\\Pebble\\bin\\pebble.cmd',
      launcherPath: 'C:\\Users\\me\\AppData\\Local\\Programs\\Pebble\\resources\\bin\\pebble.cmd'
    })

    await expect(installer.install()).resolves.toMatchObject({
      state: 'installed',
      currentTarget: 'C:\\Users\\me\\AppData\\Local\\Programs\\Pebble\\resources\\bin\\pebble.cmd'
    })
  })

  it('settles when wsl.exe never reports completion', async () => {
    vi.useFakeTimers()
    const killMock = vi.fn()
    execFileMock.mockImplementation(() => ({ kill: killMock }))
    const installer = new WslCliInstaller({
      platform: 'win32',
      distro: 'Ubuntu',
      hostInstaller: { getStatus: async () => makeHostStatus() }
    })

    const promise = installer.getStatus()
    let settled = false
    void promise
      .catch(() => undefined)
      .finally(() => {
        settled = true
      })

    await vi.advanceTimersByTimeAsync(10_000)
    await Promise.resolve()

    expect(settled).toBe(true)
    await expect(promise).rejects.toThrow('WSL command timed out')
    expect(killMock).toHaveBeenCalled()
  })

  it('refuses to remove an old managed launcher when the bridge path is user-owned', async () => {
    const oldLauncher = _internals.buildWslLauncher(
      'C:\\Old\\pebble.cmd',
      '/home/alice/.local/share/pebble/pebble-wsl-bridge.ps1'
    )
    const wsl = createWslRunner(oldLauncher)
    const installer = new WslCliInstaller({
      platform: 'win32',
      distro: 'Ubuntu',
      hostInstaller: { getStatus: async () => makeHostStatus('C:\\Pebble\\pebble.cmd') },
      wslRunner: async (distro, command) => {
        if (command.includes('cat /home/alice/.local/share/pebble/pebble-wsl-bridge.ps1')) {
          return 'user bridge'
        }
        if (command.includes('rm -f')) {
          throw new Error('__PEBBLE_CONFLICT__')
        }
        return wsl.runner(distro, command)
      }
    })

    await expect(installer.remove()).rejects.toThrow('__PEBBLE_CONFLICT__')
  })
})
