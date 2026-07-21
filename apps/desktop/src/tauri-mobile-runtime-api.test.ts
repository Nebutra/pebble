import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PreloadApi } from '../../../packages/product-core/shared/preload-api-types'

const { requestRuntimeJsonMock, invokeMock, qrToDataUrlMock } = vi.hoisted(() => ({
  requestRuntimeJsonMock: vi.fn(),
  invokeMock: vi.fn(),
  qrToDataUrlMock: vi.fn()
}))

vi.mock('./pebble-tauri-runtime-transport', () => ({
  requestRuntimeJson: requestRuntimeJsonMock
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('qrcode/lib/browser', () => ({ default: { toDataURL: qrToDataUrlMock } }))

import { createPebbleMobileApi } from './tauri-mobile-runtime-api'

describe('createPebbleMobileApi', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('maps mobile devices and runtime access grants from shared-control pairings', async () => {
    requestRuntimeJsonMock.mockResolvedValue([
      {
        deviceId: 'device-1',
        name: 'iPhone',
        scope: 'mobile',
        pairedAt: 100,
        lastSeenAt: 200
      },
      {
        deviceId: 'device-2',
        name: 'Web client',
        scope: 'runtime',
        pairedAt: 300,
        lastSeenAt: 0
      }
    ])
    const api = createPebbleMobileApi({} as PreloadApi['mobile'])

    await expect(api.listDevices()).resolves.toEqual({
      devices: [
        {
          deviceId: 'device-1',
          name: 'iPhone',
          pairedAt: 100,
          lastSeenAt: 200
        }
      ]
    })
    await expect(api.listRuntimeAccessGrants()).resolves.toEqual({
      grants: [
        {
          deviceId: 'device-2',
          name: 'Web client',
          createdAt: 300,
          lastSeenAt: null
        }
      ]
    })
    expect(requestRuntimeJsonMock).toHaveBeenCalledWith('/v1/shared-control/pairings', {
      method: 'GET',
      timeoutMs: 5000
    })
  })

  it('builds the legacy-compatible pairing offer and QR from Go identity material', async () => {
    requestRuntimeJsonMock.mockResolvedValue({
      deviceId: 'device-1',
      deviceToken: 'device-token',
      publicKeyB64: 'public-key',
      scope: 'mobile'
    })
    qrToDataUrlMock.mockResolvedValue('data:image/png;base64,qr')
    const api = createPebbleMobileApi({} as PreloadApi['mobile'])

    const result = await api.getPairingQR({ address: '192.168.1.20', rotate: true })

    expect(result).toMatchObject({
      available: true,
      endpoint: 'ws://192.168.1.20:17777/v1/shared-control',
      deviceId: 'device-1',
      qrDataUrl: 'data:image/png;base64,qr'
    })
    expect(requestRuntimeJsonMock).toHaveBeenCalledWith('/v1/shared-control/pairing', {
      method: 'POST',
      timeoutMs: 5000,
      body: expect.objectContaining({ scope: 'mobile', rotate: true })
    })
    expect(qrToDataUrlMock).toHaveBeenCalledWith(
      expect.stringMatching(/^pebble:\/\/pair\?code=/),
      expect.objectContaining({ width: 256 })
    )
  })

  it('propagates pairing list runtime failures instead of returning fake empty mobile state', async () => {
    requestRuntimeJsonMock.mockRejectedValue(new Error('mobile relay unavailable'))
    const api = createPebbleMobileApi({} as PreloadApi['mobile'])

    await expect(api.listDevices()).rejects.toThrow('mobile relay unavailable')
    await expect(api.listRuntimeAccessGrants()).rejects.toThrow('mobile relay unavailable')
  })
})
