import { NativeModules } from 'react-native'

import {
  MOBILE_RELAY_PROTOCOL_VERSION,
  MobileRelayClientMessage,
  MobileRelayServerMessage,
  RelayCryptoEnvelope,
  RelayCryptoHandshake,
  RelayCryptoReady,
} from './relay-protocol'
import {
  RelayCryptoHandshakeInput,
  RelayCryptoProvider,
  RelayCryptoSession,
  RelayCryptoSelfTestResult,
} from './relay-crypto'

declare const require: undefined | ((name: string) => unknown)

interface NativeRelayCryptoModule {
  createHandshake: (input: NativeRelayCryptoHandshakeInput) => Promise<NativeRelayCryptoHandshake>
  completeHandshake: (input: NativeRelayCryptoCompleteInput) => Promise<NativeRelayCryptoSession>
  encryptMessage: (input: NativeRelayCryptoEncryptInput) => Promise<unknown>
  decryptMessage: (input: NativeRelayCryptoDecryptInput) => Promise<unknown>
  selfTest?: () => Promise<unknown>
}

interface NativeRelayCryptoHandshakeInput {
  device: RelayCryptoHandshakeInput['device']
  relayId: string
  pairingSecretRef: string
  subscriptions: RelayCryptoHandshakeInput['subscriptions']
}

interface NativeRelayCryptoHandshake {
  handshakeId: string
  payload: RelayCryptoHandshake
}

interface NativeRelayCryptoCompleteInput {
  handshakeId: string
  relayId: string
  pairingSecretRef: string
  ready: RelayCryptoReady
}

interface NativeRelayCryptoSession {
  sessionId: string
  keyId: string
}

interface NativeRelayCryptoEncryptInput {
  sessionId: string
  message: MobileRelayClientMessage
}

interface NativeRelayCryptoDecryptInput {
  sessionId: string
  envelope: RelayCryptoEnvelope
}

interface NativeModuleRegistry {
  PebbleRelayCrypto?: unknown
}

export function createNativeRelayCryptoProvider(): RelayCryptoProvider | undefined {
  const nativeModule = readNativeRelayCryptoModule()

  if (nativeModule === null) {
    return undefined
  }

  const provider: RelayCryptoProvider = {
    async createHandshake(input) {
      const handshake = await nativeModule.createHandshake({
        device: input.device,
        relayId: input.relayId ?? '',
        pairingSecretRef: input.pairingSecretRef,
        subscriptions: input.subscriptions,
      })

      if (!isNativeRelayCryptoHandshake(handshake)) {
        throw new Error('Native relay crypto returned an invalid handshake')
      }

      return {
        payload: handshake.payload,
        complete: async (ready) => {
          const session = await nativeModule.completeHandshake({
            handshakeId: handshake.handshakeId,
            relayId: input.relayId ?? '',
            pairingSecretRef: input.pairingSecretRef,
            ready,
          })

          if (!isNativeRelayCryptoSession(session)) {
            throw new Error('Native relay crypto returned an invalid session')
          }

          return createNativeRelayCryptoSession(nativeModule, session)
        },
      }
    },
  }

  const selfTest = nativeModule.selfTest
  if (typeof selfTest === 'function') {
    provider.selfTest = async () => {
      const result = await selfTest()

      if (!isNativeRelayCryptoSelfTestResult(result)) {
        throw new Error('Native relay crypto returned an invalid self-test result')
      }

      return result
    }
  }

  return provider
}

function createNativeRelayCryptoSession(
  nativeModule: NativeRelayCryptoModule,
  session: NativeRelayCryptoSession,
): RelayCryptoSession {
  return {
    keyId: session.keyId,
    async encryptMessage(message) {
      const envelope = await nativeModule.encryptMessage({
        sessionId: session.sessionId,
        message,
      })

      if (!isRelayCryptoEnvelope(envelope)) {
        throw new Error('Native relay crypto returned an invalid envelope')
      }

      return envelope
    },
    async decryptMessage(envelope) {
      const message = await nativeModule.decryptMessage({
        sessionId: session.sessionId,
        envelope,
      })

      if (!isRelayServerMessage(message)) {
        throw new Error('Native relay crypto returned an invalid server message')
      }

      return message
    },
  }
}

function readNativeRelayCryptoModule(): NativeRelayCryptoModule | null {
  const module =
    (NativeModules as NativeModuleRegistry).PebbleRelayCrypto ??
    readExpoNativeRelayCryptoModule()

  return isNativeRelayCryptoModule(module) ? module : null
}

function readExpoNativeRelayCryptoModule(): unknown {
  if (typeof require !== 'function') {
    return null
  }

  try {
    const expoModulesCore = require('expo-modules-core') as ExpoModulesCore
    if (typeof expoModulesCore.requireNativeModule === 'function') {
      return expoModulesCore.requireNativeModule('PebbleRelayCrypto')
    }

    return expoModulesCore.NativeModulesProxy?.PebbleRelayCrypto ?? null
  } catch {
    return null
  }
}

interface ExpoModulesCore {
  requireNativeModule?: (name: string) => unknown
  NativeModulesProxy?: {
    PebbleRelayCrypto?: unknown
  }
}

function isNativeRelayCryptoModule(value: unknown): value is NativeRelayCryptoModule {
  return (
    isRecord(value) &&
    typeof value.createHandshake === 'function' &&
    typeof value.completeHandshake === 'function' &&
    typeof value.encryptMessage === 'function' &&
    typeof value.decryptMessage === 'function'
  )
}

function isNativeRelayCryptoHandshake(value: unknown): value is NativeRelayCryptoHandshake {
  return (
    isRecord(value) &&
    typeof value.handshakeId === 'string' &&
    isRelayCryptoHandshake(value.payload)
  )
}

function isNativeRelayCryptoSession(value: unknown): value is NativeRelayCryptoSession {
  return (
    isRecord(value) &&
    typeof value.sessionId === 'string' &&
    typeof value.keyId === 'string'
  )
}

function isNativeRelayCryptoSelfTestResult(
  value: unknown,
): value is RelayCryptoSelfTestResult {
  return (
    isRecord(value) &&
    value.ok === true &&
    value.provider === 'native' &&
    value.algorithm === 'X25519-HKDF-SHA256-AES-256-GCM' &&
    typeof value.keyId === 'string' &&
    typeof value.encryptedBytes === 'number'
  )
}

function isRelayCryptoHandshake(value: unknown): value is RelayCryptoHandshake {
  return (
    isRecord(value) &&
    isRecord(value.device) &&
    typeof value.clientPublicKey === 'string' &&
    typeof value.pairingSecretRef === 'string' &&
    Array.isArray(value.subscriptions)
  )
}

function isRelayCryptoEnvelope(value: unknown): value is RelayCryptoEnvelope {
  return (
    isRecord(value) &&
    typeof value.keyId === 'string' &&
    typeof value.nonce === 'string' &&
    typeof value.ciphertext === 'string' &&
    (value.associatedData === undefined || typeof value.associatedData === 'string')
  )
}

function isRelayServerMessage(value: unknown): value is MobileRelayServerMessage {
  return (
    isRecord(value) &&
    value.version === MOBILE_RELAY_PROTOCOL_VERSION &&
    typeof value.id === 'string' &&
    typeof value.type === 'string' &&
    isRecord(value.payload)
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
