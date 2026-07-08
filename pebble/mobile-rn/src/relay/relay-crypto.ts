import {
  DeviceIdentity,
  MOBILE_RELAY_PROTOCOL_VERSION,
  MobileRelayClientMessage,
  MobileRelayServerMessage,
  ProjectionKind,
  RelayCryptoEnvelope,
  RelayCryptoHandshake,
  RelayCryptoReady,
} from './relay-protocol'

export interface RelayCryptoHandshakeInput {
  device: DeviceIdentity
  relayId?: string
  pairingSecretRef: string
  subscriptions: ProjectionKind[]
}

export interface RelayCryptoHandshakeState {
  payload: RelayCryptoHandshake
  complete: (ready: RelayCryptoReady) => Promise<RelayCryptoSession>
}

export interface RelayCryptoSession {
  keyId: string
  encryptMessage: (message: MobileRelayClientMessage) => Promise<RelayCryptoEnvelope>
  decryptMessage: (envelope: RelayCryptoEnvelope) => Promise<MobileRelayServerMessage>
}

export interface RelayCryptoSelfTestResult {
  ok: true
  provider: 'native' | 'webcrypto'
  algorithm: RelayCryptoReady['algorithm']
  keyId: string
  encryptedBytes: number
}

export interface RelayCryptoProvider {
  createHandshake: (input: RelayCryptoHandshakeInput) => Promise<RelayCryptoHandshakeState>
  selfTest?: () => Promise<RelayCryptoSelfTestResult>
}

const relayCryptoAlgorithm = 'X25519-HKDF-SHA256-AES-256-GCM'
const relayAssociatedData = 'pebble.mobile-relay.v1'

export function createWebCryptoRelayCryptoProvider(): RelayCryptoProvider {
  return {
    selfTest: selfTestWebCryptoRelayCrypto,
    async createHandshake(input) {
      const subtle = requireSubtleCrypto()
      const keyPair = (await subtle.generateKey(
        { name: 'X25519' } as AlgorithmIdentifier,
        true,
        ['deriveBits'],
      )) as CryptoKeyPair
      const publicKey = await subtle.exportKey('raw', keyPair.publicKey)

      return {
        payload: {
          device: input.device,
          clientPublicKey: encodeBase64Url(publicKey),
          pairingSecretRef: input.pairingSecretRef,
          subscriptions: input.subscriptions,
        },
        complete: async (ready) => {
          const serverPublicKey = await subtle.importKey(
            'raw',
            decodeBase64Url(ready.serverPublicKey),
            { name: 'X25519' } as AlgorithmIdentifier,
            false,
            [],
          )
          const sharedSecret = await subtle.deriveBits(
            { name: 'X25519', public: serverPublicKey } as AlgorithmIdentifier,
            keyPair.privateKey,
            256,
          )
          const keyBytes = await deriveRelayKeyBytes(
            subtle,
            sharedSecret,
            input.relayId ?? '',
            input.pairingSecretRef,
          )
          const keyId = await relayKeyId(subtle, keyBytes)

          if (keyId !== ready.keyId) {
            throw new Error('Relay crypto key id mismatch')
          }

          const aesKey = await subtle.importKey('raw', keyBytes, 'AES-GCM', false, [
            'encrypt',
            'decrypt',
          ])

          return createRelayCryptoSession(subtle, aesKey, keyId)
        },
      }
    },
  }
}

export function canUseWebCryptoRelayCrypto(): boolean {
  return (
    globalThis.crypto?.subtle !== undefined &&
    typeof globalThis.crypto?.getRandomValues === 'function' &&
    typeof globalThis.btoa === 'function' &&
    typeof globalThis.atob === 'function' &&
    typeof TextDecoder !== 'undefined' &&
    typeof TextEncoder !== 'undefined'
  )
}

export async function selfTestWebCryptoRelayCrypto(): Promise<RelayCryptoSelfTestResult> {
  const subtle = requireSubtleCrypto()
  const provider = createWebCryptoRelayCryptoProvider()
  const relayId = 'pebble-self-test-relay'
  const pairingSecretRef = 'pebble-self-test-secret'
  const serverKeyPair = (await subtle.generateKey(
    { name: 'X25519' } as AlgorithmIdentifier,
    true,
    ['deriveBits'],
  )) as CryptoKeyPair
  const handshake = await provider.createHandshake({
    device: {
      deviceId: 'pebble-self-test-device',
      deviceName: 'Pebble diagnostics',
      platform: 'unknown',
    },
    relayId,
    pairingSecretRef,
    subscriptions: [],
  })
  const clientPublicKey = await subtle.importKey(
    'raw',
    decodeBase64Url(handshake.payload.clientPublicKey),
    { name: 'X25519' } as AlgorithmIdentifier,
    false,
    [],
  )
  const serverPublicKey = await subtle.exportKey('raw', serverKeyPair.publicKey)
  const sharedSecret = await subtle.deriveBits(
    { name: 'X25519', public: clientPublicKey } as AlgorithmIdentifier,
    serverKeyPair.privateKey,
    256,
  )
  const keyBytes = await deriveRelayKeyBytes(
    subtle,
    sharedSecret,
    relayId,
    pairingSecretRef,
  )
  const keyId = await relayKeyId(subtle, keyBytes)
  const session = await handshake.complete({
    algorithm: relayCryptoAlgorithm,
    keyId,
    serverPublicKey: encodeBase64Url(serverPublicKey),
    associatedData: relayAssociatedData,
  })
  const clientEnvelope = await session.encryptMessage({
    version: MOBILE_RELAY_PROTOCOL_VERSION,
    id: 'pebble-self-test-client',
    type: 'heartbeat',
    payload: {
      sentAt: new Date(0).toISOString(),
    },
  })
  const serverMessage: MobileRelayServerMessage = {
    version: MOBILE_RELAY_PROTOCOL_VERSION,
    id: 'pebble-self-test-server',
    type: 'server.hello',
    payload: {
      relayId,
      acceptedSubscriptions: [],
    },
  }
  const serverEnvelope = await encryptRelayServerMessage(
    subtle,
    keyBytes,
    keyId,
    serverMessage,
  )
  const decrypted = await session.decryptMessage(serverEnvelope)

  if (decrypted.id !== serverMessage.id) {
    throw new Error('Relay crypto self-test decrypted an unexpected server message')
  }

  return {
    ok: true,
    provider: 'webcrypto',
    algorithm: relayCryptoAlgorithm,
    keyId,
    encryptedBytes: decodeBase64Url(clientEnvelope.ciphertext).byteLength,
  }
}

function createRelayCryptoSession(
  subtle: SubtleCrypto,
  aesKey: CryptoKey,
  keyId: string,
): RelayCryptoSession {
  return {
    keyId,
    async encryptMessage(message) {
      const nonce = randomBytes(12)
      const plaintext = encodeUtf8(JSON.stringify(message))
      const ciphertext = await subtle.encrypt(
        {
          name: 'AES-GCM',
          iv: nonce,
          additionalData: encodeUtf8(relayAssociatedData),
        },
        aesKey,
        plaintext,
      )

      return {
        keyId,
        nonce: encodeBase64Url(nonce),
        ciphertext: encodeBase64Url(ciphertext),
        associatedData: relayAssociatedData,
      }
    },
    async decryptMessage(envelope) {
      if (envelope.keyId !== keyId) {
        throw new Error('Relay crypto key id mismatch')
      }
      if (
        envelope.associatedData !== undefined &&
        envelope.associatedData !== relayAssociatedData
      ) {
        throw new Error('Relay crypto associated data mismatch')
      }

      const plaintext = await subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: decodeBase64Url(envelope.nonce),
          additionalData: encodeUtf8(relayAssociatedData),
        },
        aesKey,
        decodeBase64Url(envelope.ciphertext),
      )
      const parsed = JSON.parse(decodeUtf8(plaintext)) as unknown

      if (!isRelayServerMessage(parsed)) {
        throw new Error('Encrypted relay payload was not a server message')
      }

      return parsed
    },
  }
}

async function encryptRelayServerMessage(
  subtle: SubtleCrypto,
  keyBytes: ArrayBuffer,
  keyId: string,
  message: MobileRelayServerMessage,
): Promise<RelayCryptoEnvelope> {
  const aesKey = await subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt'])
  const nonce = randomBytes(12)
  const ciphertext = await subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: nonce,
      additionalData: encodeUtf8(relayAssociatedData),
    },
    aesKey,
    encodeUtf8(JSON.stringify(message)),
  )

  return {
    keyId,
    nonce: encodeBase64Url(nonce),
    ciphertext: encodeBase64Url(ciphertext),
    associatedData: relayAssociatedData,
  }
}

async function deriveRelayKeyBytes(
  subtle: SubtleCrypto,
  sharedSecret: ArrayBuffer,
  relayId: string,
  pairingSecretRef: string,
): Promise<ArrayBuffer> {
  const hkdfKey = await subtle.importKey('raw', sharedSecret, 'HKDF', false, ['deriveBits'])
  const salt = await subtle.digest(
    'SHA-256',
    encodeUtf8(`pebble-mobile-relay:${relayId}:${pairingSecretRef}`),
  )

  return subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt,
      info: encodeUtf8(relayCryptoAlgorithm),
    },
    hkdfKey,
    256,
  )
}

async function relayKeyId(subtle: SubtleCrypto, keyBytes: ArrayBuffer): Promise<string> {
  const hash = await subtle.digest('SHA-256', keyBytes)

  return encodeBase64Url(hash.slice(0, 16))
}

function requireSubtleCrypto(): SubtleCrypto {
  if (globalThis.crypto?.subtle === undefined) {
    throw new Error('Relay crypto requires WebCrypto or a native crypto provider')
  }

  return globalThis.crypto.subtle
}

function randomBytes(length: number): ArrayBuffer {
  if (typeof globalThis.crypto?.getRandomValues !== 'function') {
    throw new Error('Relay crypto requires secure random bytes')
  }

  const bytes = new Uint8Array(length)

  globalThis.crypto.getRandomValues(bytes)

  return toArrayBuffer(bytes)
}

function encodeUtf8(value: string): ArrayBuffer {
  return toArrayBuffer(new TextEncoder().encode(value))
}

function decodeUtf8(value: ArrayBuffer): string {
  return new TextDecoder().decode(value)
}

function encodeBase64Url(value: ArrayBuffer): string {
  const bytes = new Uint8Array(value)
  let binary = ''

  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }

  return globalThis
    .btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '')
}

function decodeBase64Url(value: string): ArrayBuffer {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/')
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=')
  const binary = globalThis.atob(padded)
  const bytes = new Uint8Array(binary.length)

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }

  return toArrayBuffer(bytes)
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.length)

  copy.set(bytes)

  return copy.buffer
}

function isRelayServerMessage(value: unknown): value is MobileRelayServerMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { version?: unknown }).version === MOBILE_RELAY_PROTOCOL_VERSION &&
    typeof (value as { type?: unknown }).type === 'string' &&
    typeof (value as { id?: unknown }).id === 'string'
  )
}
