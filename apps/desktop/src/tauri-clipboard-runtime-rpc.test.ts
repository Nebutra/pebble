import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invokeMock, requestRuntimeJsonMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  requestRuntimeJsonMock: vi.fn()
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('./pebble-tauri-runtime-transport', () => ({ requestRuntimeJson: requestRuntimeJsonMock }))

import {
  callTauriClipboardRuntimeRpc,
  clearTauriClipboardUploadsForTests
} from './tauri-clipboard-runtime-rpc'

describe('callTauriClipboardRuntimeRpc', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearTauriClipboardUploadsForTests()
    vi.stubGlobal('crypto', { randomUUID: () => 'upload-1' })
  })

  it('saves a bounded base64 image through the native command', async () => {
    invokeMock.mockResolvedValue('/tmp/pebble.png')
    await expect(
      callTauriClipboardRuntimeRpc('clipboard.saveImageAsTempFile', {
        contentBase64: 'cG5n'
      })
    ).resolves.toEqual({ handled: true, result: '/tmp/pebble.png' })
    expect(invokeMock).toHaveBeenCalledWith('clipboard_save_image_bytes_as_temp_file', {
      contentBase64: 'cG5n'
    })
  })

  it('assembles ordered chunks and commits once', async () => {
    invokeMock.mockResolvedValue('/tmp/pebble.png')
    await callTauriClipboardRuntimeRpc('clipboard.startImageUpload', {
      expectedBase64Length: 8
    })
    await callTauriClipboardRuntimeRpc('clipboard.appendImageUploadChunk', {
      uploadId: 'upload-1',
      offset: 0,
      contentBase64: 'cG5n'
    })
    await callTauriClipboardRuntimeRpc('clipboard.appendImageUploadChunk', {
      uploadId: 'upload-1',
      offset: 4,
      contentBase64: 'ZGF0'
    })
    await expect(
      callTauriClipboardRuntimeRpc('clipboard.commitImageUpload', { uploadId: 'upload-1' })
    ).resolves.toEqual({ handled: true, result: '/tmp/pebble.png' })
    expect(invokeMock).toHaveBeenCalledWith('clipboard_save_image_bytes_as_temp_file', {
      contentBase64: 'cG5nZGF0'
    })
  })

  it('rejects out-of-order chunks and writes remote images through the SSH relay route', async () => {
    await callTauriClipboardRuntimeRpc('clipboard.startImageUpload', {
      expectedBase64Length: 4
    })
    await expect(
      callTauriClipboardRuntimeRpc('clipboard.appendImageUploadChunk', {
        uploadId: 'upload-1',
        offset: 2,
        contentBase64: 'cG5n'
      })
    ).rejects.toThrow('offset is out of order')
    requestRuntimeJsonMock.mockResolvedValue({ path: '/remote/tmp/pebble.png' })
    await expect(
      callTauriClipboardRuntimeRpc('clipboard.saveImageAsTempFile', {
        contentBase64: 'cG5n',
        connectionId: 'ssh-1'
      })
    ).resolves.toEqual({ handled: true, result: '/remote/tmp/pebble.png' })
    expect(requestRuntimeJsonMock).toHaveBeenCalledWith('/v1/ssh-targets/clipboard-image', {
      method: 'POST',
      timeoutMs: 60_000,
      body: { targetId: 'ssh-1', contentBase64: 'cG5n' }
    })
  })

  it('commits chunked uploads on the originating SSH target', async () => {
    requestRuntimeJsonMock.mockResolvedValue({ path: 'C:\\Temp\\pebble.png' })
    await callTauriClipboardRuntimeRpc('clipboard.startImageUpload', {
      expectedBase64Length: 4,
      connectionId: 'ssh-win'
    })
    await callTauriClipboardRuntimeRpc('clipboard.appendImageUploadChunk', {
      uploadId: 'upload-1',
      offset: 0,
      contentBase64: 'cG5n'
    })
    await expect(
      callTauriClipboardRuntimeRpc('clipboard.commitImageUpload', { uploadId: 'upload-1' })
    ).resolves.toEqual({ handled: true, result: 'C:\\Temp\\pebble.png' })
  })

  it('removes a failed commit upload', async () => {
    invokeMock.mockRejectedValue(new Error('disk full'))
    await callTauriClipboardRuntimeRpc('clipboard.startImageUpload', {
      expectedBase64Length: 4
    })
    await callTauriClipboardRuntimeRpc('clipboard.appendImageUploadChunk', {
      uploadId: 'upload-1',
      offset: 0,
      contentBase64: 'cG5n'
    })
    await expect(
      callTauriClipboardRuntimeRpc('clipboard.commitImageUpload', { uploadId: 'upload-1' })
    ).rejects.toThrow('disk full')
    await expect(
      callTauriClipboardRuntimeRpc('clipboard.commitImageUpload', { uploadId: 'upload-1' })
    ).rejects.toThrow('was not found')
  })
})
