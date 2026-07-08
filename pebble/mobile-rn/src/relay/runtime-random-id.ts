export function createRuntimeRandomId(): string {
  const randomUUID = globalThis.crypto?.randomUUID

  if (typeof randomUUID === 'function') {
    return randomUUID.call(globalThis.crypto)
  }

  const randomBytes = createRuntimeRandomBytes(16)
  if (randomBytes !== null) {
    return encodeHex(randomBytes)
  }

  // These IDs are not secrets; this fallback only keeps unsupported runtimes usable.
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`
}

function createRuntimeRandomBytes(length: number): Uint8Array | null {
  const getRandomValues = globalThis.crypto?.getRandomValues
  if (typeof getRandomValues !== 'function') {
    return null
  }

  const bytes = new Uint8Array(length)
  getRandomValues.call(globalThis.crypto, bytes)

  return bytes
}

function encodeHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}
