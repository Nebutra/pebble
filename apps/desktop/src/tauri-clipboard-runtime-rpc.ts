import { invoke } from '@tauri-apps/api/core'

import {
  CLIPBOARD_IMAGE_MAX_BASE64_CHARS,
  CLIPBOARD_IMAGE_TOO_LARGE_ERROR
} from '../../../packages/product-core/shared/clipboard-image'
import { requestRuntimeJson } from './pebble-tauri-runtime-transport'

const CHUNK_MAX_CHARS = 512 * 1024
const MAX_CONCURRENT_UPLOADS = 8
const UPLOAD_TTL_MS = 5 * 60 * 1000
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/

type Upload = {
  connectionId: string | null
  expectedLength: number
  chunks: string[]
  receivedLength: number
  expiresAt: number
}

type RuntimeRpcResult = { handled: boolean; result?: unknown }

const uploads = new Map<string, Upload>()

export async function callTauriClipboardRuntimeRpc(
  method: string,
  params: unknown
): Promise<RuntimeRpcResult> {
  switch (method) {
    case 'clipboard.saveImageAsTempFile':
      return handled(await saveImage(readObject(params)))
    case 'clipboard.startImageUpload':
      return handled(startUpload(readObject(params)))
    case 'clipboard.appendImageUploadChunk':
      return handled(appendChunk(readObject(params)))
    case 'clipboard.commitImageUpload':
      return handled(await commitUpload(readObject(params)))
    case 'clipboard.abortImageUpload':
      abortUpload(readRequiredString(readObject(params).uploadId, 'upload id'))
      return handled({ aborted: true })
    default:
      return { handled: false }
  }
}

export function clearTauriClipboardUploadsForTests(): void {
  uploads.clear()
}

async function saveImage(input: Record<string, unknown>): Promise<string> {
  const contentBase64 = readBase64(input.contentBase64, CLIPBOARD_IMAGE_MAX_BASE64_CHARS)
  const connectionId = readOptionalString(input.connectionId)
  if (connectionId) {
    return saveRemoteImage(connectionId, contentBase64)
  }
  return invoke<string>('clipboard_save_image_bytes_as_temp_file', { contentBase64 })
}

function startUpload(input: Record<string, unknown>): { uploadId: string } {
  pruneExpiredUploads()
  if (uploads.size >= MAX_CONCURRENT_UPLOADS) {
    throw new Error('Too many clipboard image uploads are in progress')
  }
  const expectedLength = readBoundedLength(input.expectedBase64Length)
  const uploadId = crypto.randomUUID()
  uploads.set(uploadId, {
    connectionId: readOptionalString(input.connectionId),
    expectedLength,
    chunks: [],
    receivedLength: 0,
    expiresAt: Date.now() + UPLOAD_TTL_MS
  })
  return { uploadId }
}

function appendChunk(input: Record<string, unknown>): { receivedBase64Length: number } {
  const upload = getUpload(readRequiredString(input.uploadId, 'upload id'))
  const offset = readNonNegativeInteger(input.offset, 'offset')
  if (offset !== upload.receivedLength) {
    throw new Error('Clipboard image chunk offset is out of order')
  }
  const content = readBase64(input.contentBase64, CHUNK_MAX_CHARS)
  if (upload.receivedLength + content.length > upload.expectedLength) {
    throw new Error('Clipboard image upload exceeded expected size')
  }
  upload.chunks.push(content)
  upload.receivedLength += content.length
  upload.expiresAt = Date.now() + UPLOAD_TTL_MS
  return { receivedBase64Length: upload.receivedLength }
}

async function commitUpload(input: Record<string, unknown>): Promise<string> {
  const uploadId = readRequiredString(input.uploadId, 'upload id')
  const upload = getUpload(uploadId)
  try {
    if (upload.receivedLength !== upload.expectedLength) {
      throw new Error('Clipboard image upload is incomplete')
    }
    const contentBase64 = upload.chunks.join('')
    return upload.connectionId
      ? await saveRemoteImage(upload.connectionId, contentBase64)
      : await invoke<string>('clipboard_save_image_bytes_as_temp_file', { contentBase64 })
  } finally {
    uploads.delete(uploadId)
  }
}

function getUpload(uploadId: string): Upload {
  pruneExpiredUploads()
  const upload = uploads.get(uploadId)
  if (!upload) {
    throw new Error('Clipboard image upload was not found')
  }
  return upload
}

function abortUpload(uploadId: string): void {
  uploads.delete(uploadId)
}

function pruneExpiredUploads(): void {
  const now = Date.now()
  for (const [id, upload] of uploads) {
    if (upload.expiresAt <= now) {
      uploads.delete(id)
    }
  }
}

async function saveRemoteImage(targetId: string, contentBase64: string): Promise<string> {
  const result = await requestRuntimeJson<{ path: string }>('/v1/ssh-targets/clipboard-image', {
    method: 'POST',
    timeoutMs: 60_000,
    body: { targetId, contentBase64 }
  })
  return result.path
}

function readOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function readBase64(value: unknown, maxChars: number): string {
  if (typeof value !== 'string') {
    throw new Error('Missing image content')
  }
  if (value.length > maxChars) {
    throw new Error(
      maxChars === CLIPBOARD_IMAGE_MAX_BASE64_CHARS
        ? CLIPBOARD_IMAGE_TOO_LARGE_ERROR
        : 'Clipboard image chunk is too large'
    )
  }
  if (value.length % 4 === 1 || !BASE64_PATTERN.test(value)) {
    throw new Error('Clipboard image content must be base64')
  }
  return value
}

function readBoundedLength(value: unknown): number {
  const length = readNonNegativeInteger(value, 'expected base64 length')
  if (length > CLIPBOARD_IMAGE_MAX_BASE64_CHARS) {
    throw new Error(CLIPBOARD_IMAGE_TOO_LARGE_ERROR)
  }
  return length
}

function readNonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`)
  }
  return value
}

function readRequiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} is required`)
  }
  return value
}

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function handled(result: unknown): RuntimeRpcResult {
  return { handled: true, result }
}
