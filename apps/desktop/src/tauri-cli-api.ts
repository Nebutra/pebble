import { invoke } from '@tauri-apps/api/core'

import type { PreloadApi } from '../../../packages/product-core/shared/preload-api-types'
import type { CliInstallStatus } from '../../../packages/product-core/shared/cli-install-types'
import { getPebbleCliCommandNameForPlatform } from '../../../packages/product-core/shared/pebble-cli-command-name'
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
    commandName: getPebbleCliCommandNameForPlatform(platform),
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
  return invoke<CliInstallStatus>(command)
}

async function callWslCli(
  command: string,
  args?: { distro?: string | null }
): Promise<CliInstallStatus> {
  if (!hasTauriInternals()) {
    return webUnsupportedStatus()
  }
  const distro = args?.distro?.trim() || null
  return invoke<CliInstallStatus>(command, { input: { distro } })
}

export function createPebbleCliApi(base: CliApi): CliApi {
  return {
    ...base,
    getInstallStatus: () => callCli('cli_install_status'),
    install: () => callCli('cli_install'),
    remove: () => callCli('cli_remove'),
    getWslInstallStatus: (args) => callWslCli('cli_wsl_install_status', args),
    installWsl: (args) => callWslCli('cli_wsl_install', args),
    removeWsl: (args) => callWslCli('cli_wsl_remove', args)
  }
}
