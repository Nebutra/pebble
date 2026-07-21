import { invoke } from '@tauri-apps/api/core'

export type EmulatorPermissionOperation = 'grant' | 'revoke' | 'reset'
export type EmulatorPermissionPlatform = 'android' | 'ios'

export type EmulatorPermissionRequest = {
  platform: EmulatorPermissionPlatform
  operationId: string
  serial: string
  operation: EmulatorPermissionOperation
  package?: string
  permission?: string
  timeoutMs?: number
}

export type EmulatorPermissionResult = {
  ok: true
  operationId: string
}

export class EmulatorPermissionUnsupportedError extends Error {
  readonly code = 'emulator_unsupported'

  constructor(readonly platform: EmulatorPermissionPlatform) {
    super(`explicit emulator permission control is not supported for ${platform}`)
    this.name = 'EmulatorPermissionUnsupportedError'
  }
}

/** Uses platform-native bounded permission bridges without host-shell parsing. */
export async function setNativeEmulatorPermission(
  request: EmulatorPermissionRequest
): Promise<EmulatorPermissionResult> {
  requireTauriShell()
  const command =
    request.platform === 'ios' ? 'emulator_ios_permission_set' : 'emulator_android_permission_set'
  return invoke<EmulatorPermissionResult>(command, {
    input: {
      operationId: request.operationId,
      serial: request.serial,
      operation: request.operation,
      package: request.package,
      permission: request.permission,
      timeoutMs: request.timeoutMs
    }
  })
}

export async function cancelNativeEmulatorPermission(
  operationId: string,
  platform: EmulatorPermissionPlatform = 'android'
): Promise<boolean> {
  requireTauriShell()
  const command =
    platform === 'ios' ? 'emulator_ios_permission_cancel' : 'emulator_android_permission_cancel'
  const result = await invoke<{ cancelled: boolean }>(command, {
    operationId
  })
  return result.cancelled
}

function requireTauriShell(): void {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) {
    throw new EmulatorPermissionUnsupportedError('android')
  }
}
