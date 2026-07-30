import type { RuntimeRpcResponse } from '../../../packages/product-core/shared/runtime-rpc-envelope'
import { requestRuntimeJson } from './pebble-tauri-runtime-transport'
import { okRuntimeRpc } from './pebble-runtime-rpc-response'
import {
  readRuntimeNativeProviders,
  readRuntimeSubsystemStatus,
  registerRuntimeNativeProvider
} from './pebble-runtime-native-providers'
import { readHostTerminalCapabilities } from './host-terminal-capabilities'
import {
  openTauriComputerUsePermissionSetup,
  readTauriComputerUsePermissionStatus
} from './tauri-computer-use-permissions-api'
import { readRuntimeObject } from './pebble-runtime-param-coercion'

export async function dispatchHostCapabilityRuntimeMethod(
  method: string,
  params?: unknown
): Promise<RuntimeRpcResponse<unknown> | null> {
  switch (method) {
    case 'provider.list':
    case 'providers.list':
    case 'nativeProvider.list':
      return okRuntimeRpc({
        providers: await readRuntimeNativeProviders(params)
      })
    case 'provider.status':
    case 'subsystem.status':
      return okRuntimeRpc({
        status: await readRuntimeSubsystemStatus(params)
      })
    case 'provider.register':
    case 'nativeProvider.register':
      return okRuntimeRpc({
        provider: await registerRuntimeNativeProvider(params)
      })
    case 'host.platform': {
      const capabilities = await readHostTerminalCapabilities(requestRuntimeJson)
      return okRuntimeRpc({ platform: capabilities.hostPlatform })
    }
    case 'host.wsl.isAvailable': {
      const capabilities = await readHostTerminalCapabilities(requestRuntimeJson)
      return okRuntimeRpc(capabilities.wslAvailable)
    }
    case 'host.wsl.listDistros': {
      const capabilities = await readHostTerminalCapabilities(requestRuntimeJson)
      return okRuntimeRpc(capabilities.wslDistros)
    }
    case 'host.pwsh.isAvailable': {
      const capabilities = await readHostTerminalCapabilities(requestRuntimeJson)
      return okRuntimeRpc(capabilities.pwshAvailable)
    }
    case 'host.gitBash.isAvailable': {
      const capabilities = await readHostTerminalCapabilities(requestRuntimeJson)
      return okRuntimeRpc(capabilities.gitBashAvailable)
    }
    case 'computer.permissionsStatus':
      return okRuntimeRpc(await readTauriComputerUsePermissionStatus())
    case 'computer.permissions':
      return okRuntimeRpc(
        await openTauriComputerUsePermissionSetup(readComputerPermissionsArgs(params))
      )
    default:
      return null
  }
}

function readComputerPermissionsArgs(
  params: unknown
): Parameters<typeof openTauriComputerUsePermissionSetup>[0] {
  const id = readRuntimeObject(params).id
  if (id === 'accessibility' || id === 'screenshots') {
    return { id }
  }
  return {}
}
