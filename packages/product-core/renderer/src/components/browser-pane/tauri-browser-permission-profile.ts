import { PEBBLE_BROWSER_PARTITION } from '../../../../shared/constants'

const RUNTIME_PROFILE_PARTITION_PREFIX = 'persist:pebble-browser-session-'

type TauriBrowserPermissionOverrideBridge = {
  ensureProfile: (profileId: string) => Promise<void>
  deviceCapabilities?: () => Promise<unknown>
  resolveDeviceSelection?: (input: {
    profileId?: string
    origin: string
    kind: 'hid' | 'webauthn-account'
    candidates: { id: string; usagePages?: number[] }[]
  }) => Promise<unknown>
  setPermission?: (input: {
    profileId?: string
    origin: string
    name: 'media' | 'hid' | 'webauthn'
    state: 'prompt' | 'granted' | 'denied'
  }) => Promise<unknown>
}

export type TauriBrowserPermissionWindow = Window & {
  __pebbleTauriBrowserPermissionOverrides?: TauriBrowserPermissionOverrideBridge
}

export async function ensureTauriBrowserPermissionProfile(
  webviewPartition: string
): Promise<string> {
  const profileId = tauriBrowserPermissionProfileId(webviewPartition)
  // Why: permission persistence must not make browser navigation unavailable;
  // a failed hydration retains the native deny-by-default policy and retries later.
  await (window as TauriBrowserPermissionWindow).__pebbleTauriBrowserPermissionOverrides
    ?.ensureProfile(profileId)
    .catch(() => undefined)
  return profileId
}

export function tauriBrowserPermissionProfileId(webviewPartition: string): string {
  if (webviewPartition === PEBBLE_BROWSER_PARTITION) {
    return ''
  }
  return webviewPartition.startsWith(RUNTIME_PROFILE_PARTITION_PREFIX)
    ? webviewPartition.slice(RUNTIME_PROFILE_PARTITION_PREFIX.length)
    : ''
}
