import { invoke } from '@tauri-apps/api/core'
import type { PreloadApi } from '../../../src/preload/api-types'
import type {
  ComputerUsePermissionId,
  ComputerUsePermissionResetResult,
  ComputerUsePermissionSetupResult,
  ComputerUsePermissionStatusResult
} from '../../../src/shared/computer-use-permissions-types'

export function createPebbleComputerUsePermissionsApi(
  base: PreloadApi['computerUsePermissions']
): PreloadApi['computerUsePermissions'] {
  return {
    ...base,
    getStatus: readTauriComputerUsePermissionStatus,
    openSetup: openTauriComputerUsePermissionSetup,
    reset: resetTauriComputerUsePermissions
  }
}

export function readTauriComputerUsePermissionStatus(): Promise<ComputerUsePermissionStatusResult> {
  return invoke<ComputerUsePermissionStatusResult>('computer_permissions_status')
}

export function openTauriComputerUsePermissionSetup(args?: {
  id?: ComputerUsePermissionId
}): Promise<ComputerUsePermissionSetupResult> {
  return invoke<ComputerUsePermissionSetupResult>('computer_permissions_open', {
    input: args ?? {}
  })
}

export function resetTauriComputerUsePermissions(): Promise<ComputerUsePermissionResetResult> {
  return invoke<ComputerUsePermissionResetResult>('computer_permissions_reset')
}
