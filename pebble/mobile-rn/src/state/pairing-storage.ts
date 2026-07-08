import AsyncStorage from '@react-native-async-storage/async-storage'
import { Platform } from 'react-native'

import { createRuntimeRandomId } from '@/relay/runtime-random-id'
import { DeviceIdentity, DevicePlatform, PairingRecord } from '@/relay/relay-protocol'
import {
  clearStoredPairingSecretRef,
  loadStoredPairingSecretRef,
  saveStoredPairingSecretRef,
} from '@/state/pairing-secret-storage'

const pairingRecordKey = '@pebble.mobile.pairingRecord'
const deviceIdentityKey = '@pebble.mobile.deviceIdentity'

export async function loadStoredPairingRecord(): Promise<PairingRecord | null> {
  const rawRecord = await AsyncStorage.getItem(pairingRecordKey)

  if (rawRecord === null) {
    return null
  }

  try {
    const parsed = JSON.parse(rawRecord) as unknown

    if (!isPairingRecord(parsed)) {
      return null
    }

    const secureSecretRef = await loadStoredPairingSecretRef()

    if (secureSecretRef === null) {
      await AsyncStorage.removeItem(pairingRecordKey)
      return null
    }

    return {
      ...parsed,
      pairingSecretRef: secureSecretRef,
    }
  } catch {
    return null
  }
}

export async function saveStoredPairingRecord(record: PairingRecord): Promise<void> {
  let storedRecord = record

  if (record.pairingSecretRef !== undefined) {
    const secretStored = await saveStoredPairingSecretRef(record.pairingSecretRef)

    // Keep reconnect metadata in AsyncStorage while platform keystore owns the secret.
    // When SecureStore is unavailable, the pairing remains usable only for the current session.
    storedRecord = {
      ...record,
      pairingSecretRef: undefined,
    }
    if (!secretStored) {
      await clearStoredPairingSecretRef()
    }
  }

  await AsyncStorage.setItem(pairingRecordKey, JSON.stringify(storedRecord))
}

export async function clearStoredPairingRecord(): Promise<void> {
  await Promise.all([
    AsyncStorage.removeItem(pairingRecordKey),
    clearStoredPairingSecretRef(),
  ])
}

export async function loadOrCreateDeviceIdentity(): Promise<DeviceIdentity> {
  const rawIdentity = await AsyncStorage.getItem(deviceIdentityKey)

  if (rawIdentity !== null) {
    try {
      const parsed = JSON.parse(rawIdentity) as unknown

      if (isDeviceIdentity(parsed)) {
        return parsed
      }
    } catch {
      await AsyncStorage.removeItem(deviceIdentityKey)
    }
  }

  const identity = createDeviceIdentity()
  await AsyncStorage.setItem(deviceIdentityKey, JSON.stringify(identity))

  return identity
}

export function createDeviceIdentity(): DeviceIdentity {
  return {
    deviceId: createLocalDeviceId(),
    deviceName: `Pebble Mobile ${Platform.OS}`,
    platform: getDevicePlatform(),
  }
}

function createLocalDeviceId(): string {
  return `mobile-${createRuntimeRandomId()}`
}

function getDevicePlatform(): DevicePlatform {
  if (Platform.OS === 'ios' || Platform.OS === 'android' || Platform.OS === 'web') {
    return Platform.OS
  }

  return 'unknown'
}

function isPairingRecord(value: unknown): value is PairingRecord {
  if (!isRecord(value)) {
    return false
  }

  return (
    typeof value.deviceId === 'string' &&
    typeof value.deviceName === 'string' &&
    typeof value.endpoint === 'string' &&
    typeof value.createdAt === 'string' &&
    optionalString(value.relayId) &&
    optionalString(value.workspaceName) &&
    optionalString(value.pairingSecretRef) &&
    optionalString(value.lastConnectedAt)
  )
}

function isDeviceIdentity(value: unknown): value is DeviceIdentity {
  if (!isRecord(value)) {
    return false
  }

  return (
    typeof value.deviceId === 'string' &&
    typeof value.deviceName === 'string' &&
    (value.platform === 'ios' ||
      value.platform === 'android' ||
      value.platform === 'web' ||
      value.platform === 'unknown')
  )
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
