import type { PreloadApi } from '../../../packages/product-core/shared/preload-api-types'
import type { RuntimeAccessGrant } from '../../../packages/product-core/shared/runtime-access-grants'
import { invoke } from '@tauri-apps/api/core'
import QRCodeBrowser from 'qrcode/lib/browser'
import { requestRuntimeJson } from './pebble-tauri-runtime-transport'

type RuntimeSharedControlPairing = {
  deviceId: string
  name: string
  scope: 'mobile' | 'runtime'
  pairedAt: number
  lastSeenAt: number
}

type RuntimeSharedControlPairingMaterial = {
  deviceId: string
  deviceToken: string
  publicKeyB64: string
  scope: 'mobile' | 'runtime'
}

type RuntimeMobileRevokeResult = {
  revoked: boolean
}

type MobileDevice = Awaited<ReturnType<PreloadApi['mobile']['listDevices']>>['devices'][number]

export function createPebbleMobileApi(base: PreloadApi['mobile']): PreloadApi['mobile'] {
  return {
    ...base,
    listNetworkInterfaces: () =>
      invoke<{ name: string; address: string }[]>('network_list_interfaces').then((interfaces) => ({
        interfaces
      })),
    getPairingQR: createMobilePairingOffer,
    getRuntimePairingUrl: createRuntimePairingOffer,
    listDevices: async () => ({
      devices: (await listRuntimeSharedControlPairings())
        .filter((pairing) => pairing.scope === 'mobile')
        .map(mapRuntimePairingToDevice)
    }),
    revokeDevice: ({ deviceId }) => revokeRuntimeSharedControlPairing(deviceId),
    listRuntimeAccessGrants: async () => ({
      grants: (await listRuntimeSharedControlPairings())
        .filter((pairing) => pairing.scope === 'runtime')
        .map(mapRuntimePairingToGrant)
    }),
    revokeRuntimeAccess: ({ deviceId }) => revokeRuntimeSharedControlPairing(deviceId),
    isWebSocketReady: async () => ({
      ready: true,
      endpoint: 'ws://127.0.0.1:17777/v1/shared-control'
    })
  }
}

async function createMobilePairingOffer(args?: {
  address?: string
  rotate?: boolean
}): ReturnType<PreloadApi['mobile']['getPairingQR']> {
  const offer = await createPairingMaterial(args, 'mobile')
  if (!offer) {
    return { available: false }
  }
  const qrDataUrl = await QRCodeBrowser.toDataURL(offer.pairingUrl, {
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 256
  })
  return { available: true, qrDataUrl, ...offer }
}

async function createRuntimePairingOffer(args?: {
  address?: string
  rotate?: boolean
}): ReturnType<PreloadApi['mobile']['getRuntimePairingUrl']> {
  const offer = await createPairingMaterial(args, 'runtime')
  if (!offer) {
    return { available: false }
  }
  return { available: true, ...offer, webClientUrl: null }
}

async function createPairingMaterial(
  args: { address?: string; rotate?: boolean } | undefined,
  scope: 'mobile' | 'runtime'
): Promise<{ pairingUrl: string; endpoint: string; deviceId: string } | null> {
  const address = args?.address?.trim()
  if (!address) {
    return null
  }
  const material = await requestRuntimeJson<RuntimeSharedControlPairingMaterial>(
    '/v1/shared-control/pairing',
    {
      method: 'POST',
      timeoutMs: 5000,
      body: {
        name: `${scope === 'mobile' ? 'Mobile' : 'Runtime'} ${new Date().toLocaleDateString()}`,
        scope,
        rotate: args?.rotate === true
      }
    }
  )
  const endpoint = `ws://${formatPairingHost(address)}:17777/v1/shared-control`
  const pairingUrl = encodePairingOffer({
    v: 2,
    endpoint,
    deviceToken: material.deviceToken,
    publicKeyB64: material.publicKeyB64,
    scope
  })
  return { pairingUrl, endpoint, deviceId: material.deviceId }
}

async function listRuntimeSharedControlPairings(): Promise<RuntimeSharedControlPairing[]> {
  return requestRuntimeJson<RuntimeSharedControlPairing[]>('/v1/shared-control/pairings', {
    method: 'GET',
    timeoutMs: 5000
  })
}

async function revokeRuntimeSharedControlPairing(
  deviceId: string
): Promise<RuntimeMobileRevokeResult> {
  return requestRuntimeJson<RuntimeMobileRevokeResult>(
    `/v1/shared-control/pairings/${encodeURIComponent(deviceId)}`,
    {
      method: 'DELETE',
      timeoutMs: 5000
    }
  )
}

function mapRuntimePairingToDevice(pairing: RuntimeSharedControlPairing): MobileDevice {
  return {
    deviceId: pairing.deviceId,
    name: pairing.name,
    pairedAt: pairing.pairedAt,
    lastSeenAt: pairing.lastSeenAt
  }
}

function mapRuntimePairingToGrant(pairing: RuntimeSharedControlPairing): RuntimeAccessGrant {
  return {
    deviceId: pairing.deviceId,
    name: pairing.name,
    createdAt: pairing.pairedAt,
    lastSeenAt: pairing.lastSeenAt > 0 ? pairing.lastSeenAt : null
  }
}

function formatPairingHost(address: string): string {
  return address.includes(':') && !address.startsWith('[') ? `[${address}]` : address
}

function encodePairingOffer(offer: object): string {
  const bytes = new TextEncoder().encode(JSON.stringify(offer))
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  const code = btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
  return `pebble://pair?code=${code}`
}
