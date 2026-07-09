import type { PreloadApi } from '../../../src/preload/api-types'
import type { RuntimeAccessGrant } from '../../../src/shared/runtime-access-grants'
import { requestRuntimeJson } from './pebble-tauri-runtime-transport'

type RuntimeMobilePairing = {
  deviceId: string
  deviceName?: string
  workspaceName?: string
  createdAt: string
  lastConnectedAt?: string
}

type RuntimeMobileRevokeResult = {
  revoked: boolean
}

type MobileDevice = Awaited<ReturnType<PreloadApi['mobile']['listDevices']>>['devices'][number]

export function createPebbleMobileApi(base: PreloadApi['mobile']): PreloadApi['mobile'] {
  return {
    ...base,
    listDevices: async () => ({
      devices: (await listRuntimeMobilePairings()).map(mapRuntimePairingToDevice)
    }),
    revokeDevice: ({ deviceId }) => revokeRuntimeMobilePairing(deviceId),
    listRuntimeAccessGrants: async () => ({
      grants: (await listRuntimeMobilePairings()).map(mapRuntimePairingToGrant)
    }),
    revokeRuntimeAccess: ({ deviceId }) => revokeRuntimeMobilePairing(deviceId)
  }
}

async function listRuntimeMobilePairings(): Promise<RuntimeMobilePairing[]> {
  return requestRuntimeJson<RuntimeMobilePairing[]>('/v1/mobile-relay/pairings', {
    method: 'GET',
    timeoutMs: 5000
  }).catch(() => [])
}

async function revokeRuntimeMobilePairing(deviceId: string): Promise<RuntimeMobileRevokeResult> {
  return requestRuntimeJson<RuntimeMobileRevokeResult>(
    `/v1/mobile-relay/pairings/${encodeURIComponent(deviceId)}`,
    {
      method: 'DELETE',
      timeoutMs: 5000
    }
  )
}

function mapRuntimePairingToDevice(pairing: RuntimeMobilePairing): MobileDevice {
  return {
    deviceId: pairing.deviceId,
    name: readRuntimePairingName(pairing),
    pairedAt: dateMs(pairing.createdAt),
    lastSeenAt: dateMs(pairing.lastConnectedAt)
  }
}

function mapRuntimePairingToGrant(pairing: RuntimeMobilePairing): RuntimeAccessGrant {
  const lastSeenAt = dateMs(pairing.lastConnectedAt)
  return {
    deviceId: pairing.deviceId,
    name: readRuntimePairingName(pairing),
    createdAt: dateMs(pairing.createdAt),
    lastSeenAt: lastSeenAt > 0 ? lastSeenAt : null
  }
}

function readRuntimePairingName(pairing: RuntimeMobilePairing): string {
  return pairing.deviceName?.trim() || pairing.workspaceName?.trim() || pairing.deviceId
}

function dateMs(value: string | undefined): number {
  const parsed = Date.parse(value ?? '')
  return Number.isFinite(parsed) ? parsed : 0
}
