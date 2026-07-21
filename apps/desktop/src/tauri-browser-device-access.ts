import { invoke } from '@tauri-apps/api/core'

export type TauriBrowserDeviceSelectionKind = 'hid' | 'webauthn-account'
export type TauriBrowserDeviceHookCapability = 'available' | 'unavailable'
export type TauriBrowserWebAuthnEngineCapability = 'native-platform-dependent' | 'unsupported'

export type TauriBrowserDeviceAccessCapabilities = {
  platform: 'macos' | 'windows' | 'linux' | 'unknown'
  persistentOverrides: boolean
  webauthnEngine: TauriBrowserWebAuthnEngineCapability
  hidPermissionHook: TauriBrowserDeviceHookCapability
  hidSelectionHook: TauriBrowserDeviceHookCapability
  webauthnAccountSelectionHook: TauriBrowserDeviceHookCapability
  reason: string
}

export type TauriBrowserDeviceCandidate = {
  id: string
  usagePages?: number[]
}

export type TauriBrowserDeviceSelectionInput = {
  profileId?: string
  origin: string
  kind: TauriBrowserDeviceSelectionKind
  candidates: TauriBrowserDeviceCandidate[]
}

export type TauriBrowserDeviceSelectionResult = {
  status: 'selected' | 'denied' | 'ambiguous' | 'unsupported'
  selectedId?: string
  code:
    | 'selected'
    | 'insecure_origin'
    | 'explicit_grant_required'
    | 'native_selection_hook_unavailable'
    | 'no_eligible_candidate'
    | 'user_selection_required'
}

export async function getTauriBrowserDeviceAccessCapabilities(): Promise<TauriBrowserDeviceAccessCapabilities> {
  return invoke<TauriBrowserDeviceAccessCapabilities>('browser_device_access_capabilities')
}

export async function resolveTauriBrowserDeviceSelection(
  input: TauriBrowserDeviceSelectionInput
): Promise<TauriBrowserDeviceSelectionResult> {
  return invoke<TauriBrowserDeviceSelectionResult>('browser_device_selection_resolve', {
    input: {
      profileId: input.profileId ?? '',
      origin: input.origin,
      kind: input.kind,
      candidates: input.candidates.map((candidate) => ({
        id: candidate.id,
        usagePages: candidate.usagePages ?? []
      }))
    }
  })
}
