import { invoke } from '@tauri-apps/api/core'

import type { PreloadApi } from '../../../src/preload/api-types'
import type { CliInstallStatus } from '../../../src/shared/cli-install-types'
import { hasTauriInternals } from './pebble-runtime-http-bridge'

type CliApi = NonNullable<Partial<PreloadApi>['cli']>

function hostPlatform(): NodeJS.Platform {
  const userAgent = navigator.userAgent.toLowerCase()
  if (userAgent.includes('windows')) {
    return 'win32'
  }
  if (userAgent.includes('mac')) {
    return 'darwin'
  }
  return 'linux'
}

function webUnsupportedStatus(): CliInstallStatus {
  const platform = hostPlatform()
  return {
    platform,
    commandName: platform === 'linux' ? 'pebble-ide' : 'pebble',
    commandPath: null,
    pathDirectory: null,
    pathConfigured: false,
    launcherPath: null,
    installMethod: null,
    supported: false,
    state: 'unsupported',
    currentTarget: null,
    unsupportedReason: 'launch_mode_unavailable',
    detail: 'CLI registration requires the Pebble desktop shell.'
  }
}

async function callCli(command: string): Promise<CliInstallStatus> {
  if (!hasTauriInternals()) {
    return webUnsupportedStatus()
  }
  return invoke<CliInstallStatus>(command).catch(() => webUnsupportedStatus())
}

// Why: WSL CLI registration reaches into a Linux distro from a Windows host — a
// flow the native Rust command does not implement — so it stays explicitly
// unsupported and defers to the web base's no-op behavior.
export function createPebbleCliApi(base: CliApi): CliApi {
  return {
    ...base,
    getInstallStatus: () => callCli('cli_install_status'),
    install: () => callCli('cli_install'),
    remove: () => callCli('cli_remove')
  }
}
