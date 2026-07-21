import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }))

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

import { createTauriTelemetryApi } from './tauri-telemetry-api'

describe('createTauriTelemetryApi', () => {
  beforeEach(() => invokeMock.mockReset())

  it('routes all telemetry operations to native commands', async () => {
    invokeMock.mockResolvedValue(undefined)
    const api = createTauriTelemetryApi()
    await api.telemetryTrack('settings_changed', { setting: 'theme' })
    await api.telemetrySetOptIn(false)
    await api.telemetryAcknowledgeBanner()
    expect(invokeMock.mock.calls).toEqual([
      ['telemetry_track', { name: 'settings_changed', props: { setting: 'theme' } }],
      ['telemetry_set_opt_in', { optedIn: false }],
      ['telemetry_acknowledge_banner']
    ])
  })

  it('returns native consent and propagates native failures', async () => {
    const consent = { effective: 'disabled', reason: 'do_not_track' } as const
    invokeMock.mockResolvedValueOnce(consent).mockRejectedValueOnce(new Error('native failed'))
    const api = createTauriTelemetryApi()
    await expect(api.telemetryGetConsentState()).resolves.toEqual(consent)
    await expect(api.telemetryTrack('app_opened', {})).rejects.toThrow('native failed')
  })
})
