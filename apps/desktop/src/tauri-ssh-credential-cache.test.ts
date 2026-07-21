import { beforeEach, describe, expect, it, vi } from 'vitest'

const { requestRuntimeJsonMock, ensureRuntimeMock } = vi.hoisted(() => ({
  requestRuntimeJsonMock: vi.fn(),
  ensureRuntimeMock: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('./pebble-runtime-http-bridge', () => ({
  ensurePebbleRuntimeProcess: ensureRuntimeMock,
  requestRuntimeJson: requestRuntimeJsonMock
}))

import {
  seedSshCredential,
  seedSshCredentialFromSubmission,
  sshNeedsPassphrasePrompt,
  trackSshCredentialRequest
} from './tauri-ssh-credential-cache'
import { createPebbleSshApi } from './tauri-ssh-targets-api'

type SshApiBase = Parameters<typeof createPebbleSshApi>[0]

function baseApi(overrides: Partial<SshApiBase> = {}): SshApiBase {
  return {
    onCredentialRequest: vi.fn().mockReturnValue(() => {}),
    submitCredential: vi.fn().mockResolvedValue(undefined),
    ...overrides
  } as unknown as SshApiBase
}

beforeEach(() => {
  vi.clearAllMocks()
  ensureRuntimeMock.mockResolvedValue(undefined)
})

describe('sshNeedsPassphrasePrompt', () => {
  it('returns the runtime promptRequired verdict', async () => {
    requestRuntimeJsonMock.mockResolvedValue({ cached: true, promptRequired: false })
    const fallback = vi.fn().mockResolvedValue(true)
    await expect(sshNeedsPassphrasePrompt('ssh-1', fallback)).resolves.toBe(false)
    expect(requestRuntimeJsonMock).toHaveBeenCalledWith('/v1/ssh-targets/ssh-1/credential', {
      method: 'GET'
    })
    expect(fallback).not.toHaveBeenCalled()
  })

  it('prompts when the credential is not cached', async () => {
    requestRuntimeJsonMock.mockResolvedValue({ cached: false, promptRequired: true })
    await expect(sshNeedsPassphrasePrompt('ssh-1', async () => false)).resolves.toBe(true)
  })

  it('falls back to the persisted flag when the runtime route fails', async () => {
    requestRuntimeJsonMock.mockRejectedValue(new Error('runtime down'))
    await expect(sshNeedsPassphrasePrompt('ssh-1', async () => true)).resolves.toBe(true)
    await expect(sshNeedsPassphrasePrompt('ssh-1', async () => false)).resolves.toBe(false)
  })

  it('never prompts when even the fallback fails', async () => {
    requestRuntimeJsonMock.mockRejectedValue(new Error('runtime down'))
    const fallback = () => Promise.reject(new Error('list failed'))
    await expect(sshNeedsPassphrasePrompt('ssh-1', fallback)).resolves.toBe(false)
  })
})

describe('credential seeding', () => {
  it('seeds a submitted credential for its tracked target', async () => {
    requestRuntimeJsonMock.mockResolvedValue({ cached: true, promptRequired: false })
    trackSshCredentialRequest({ requestId: 'req-1', targetId: 'ssh-1', kind: 'passphrase' })
    await seedSshCredentialFromSubmission({ requestId: 'req-1', value: 'open sesame' })
    expect(requestRuntimeJsonMock).toHaveBeenCalledWith('/v1/ssh-targets/ssh-1/credential', {
      method: 'POST',
      body: { kind: 'passphrase', value: 'open sesame' }
    })
  })

  it('does not seed a cancelled prompt or an unknown request', async () => {
    trackSshCredentialRequest({ requestId: 'req-2', targetId: 'ssh-1', kind: 'password' })
    await seedSshCredentialFromSubmission({ requestId: 'req-2', value: null })
    await seedSshCredentialFromSubmission({ requestId: 'req-never-seen', value: 'x' })
    expect(requestRuntimeJsonMock).not.toHaveBeenCalled()
  })

  it('consumes the tracked request so a requestId cannot double-seed', async () => {
    requestRuntimeJsonMock.mockResolvedValue({ cached: true, promptRequired: false })
    trackSshCredentialRequest({ requestId: 'req-3', targetId: 'ssh-1', kind: 'passphrase' })
    await seedSshCredentialFromSubmission({ requestId: 'req-3', value: 'first' })
    await seedSshCredentialFromSubmission({ requestId: 'req-3', value: 'second' })
    expect(requestRuntimeJsonMock).toHaveBeenCalledTimes(1)
  })

  it('swallows seeding failures so the prompt flow never breaks', async () => {
    requestRuntimeJsonMock.mockRejectedValue(new Error('boom'))
    trackSshCredentialRequest({ requestId: 'req-4', targetId: 'ssh-1', kind: 'passphrase' })
    await expect(
      seedSshCredentialFromSubmission({ requestId: 'req-4', value: 'secret' })
    ).resolves.toBeUndefined()
  })

  it('posts direct seeds with the credential kind', async () => {
    requestRuntimeJsonMock.mockResolvedValue({ cached: true, promptRequired: false })
    await seedSshCredential('ssh-2', 'password', 'pw')
    expect(requestRuntimeJsonMock).toHaveBeenCalledWith('/v1/ssh-targets/ssh-2/credential', {
      method: 'POST',
      body: { kind: 'password', value: 'pw' }
    })
  })
})

describe('createPebbleSshApi credential wiring', () => {
  it('gates needsPassphrasePrompt on the runtime cache', async () => {
    requestRuntimeJsonMock.mockResolvedValue({ cached: true, promptRequired: false })
    const api = createPebbleSshApi(baseApi())
    await expect(api.needsPassphrasePrompt({ targetId: 'ssh-9' })).resolves.toBe(false)
    expect(requestRuntimeJsonMock).toHaveBeenCalledWith('/v1/ssh-targets/ssh-9/credential', {
      method: 'GET'
    })
  })

  it('falls back to lastRequiredPassphrase from the target list on cache errors', async () => {
    requestRuntimeJsonMock.mockImplementation(async (route: string) => {
      if (route.endsWith('/credential')) {
        throw new Error('route missing')
      }
      return [{ id: 'ssh-9', lastRequiredPassphrase: true }]
    })
    const api = createPebbleSshApi(baseApi())
    await expect(api.needsPassphrasePrompt({ targetId: 'ssh-9' })).resolves.toBe(true)
    await expect(api.needsPassphrasePrompt({ targetId: 'ssh-other' })).resolves.toBe(false)
  })

  it('clears the runtime cache on disconnect, tolerating failures', async () => {
    requestRuntimeJsonMock.mockResolvedValue({ cached: false, promptRequired: true })
    const api = createPebbleSshApi(baseApi())
    await api.disconnect({ targetId: 'ssh-9' })
    expect(requestRuntimeJsonMock).toHaveBeenCalledWith('/v1/ssh-targets/ssh-9/credential', {
      method: 'DELETE'
    })
    requestRuntimeJsonMock.mockRejectedValue(new Error('down'))
    await expect(api.disconnect({ targetId: 'ssh-9' })).resolves.toBeUndefined()
  })

  it('tracks prompt requests and seeds the cache on submit', async () => {
    requestRuntimeJsonMock.mockResolvedValue({ cached: true, promptRequired: false })
    let emit:
      | ((data: {
          requestId: string
          targetId: string
          kind: 'passphrase' | 'password'
          detail: string
        }) => void)
      | null = null
    const submitCredential = vi.fn().mockResolvedValue(undefined)
    const api = createPebbleSshApi(
      baseApi({
        onCredentialRequest: (callback) => {
          emit = callback
          return () => {}
        },
        submitCredential
      })
    )
    const seen: string[] = []
    api.onCredentialRequest((data) => {
      seen.push(data.requestId)
    })
    emit!({ requestId: 'req-ui', targetId: 'ssh-9', kind: 'passphrase', detail: 'id_ed25519' })
    expect(seen).toEqual(['req-ui'])

    await api.submitCredential({ requestId: 'req-ui', value: 'trusty steed' })
    expect(submitCredential).toHaveBeenCalledWith({ requestId: 'req-ui', value: 'trusty steed' })
    expect(requestRuntimeJsonMock).toHaveBeenCalledWith('/v1/ssh-targets/ssh-9/credential', {
      method: 'POST',
      body: { kind: 'passphrase', value: 'trusty steed' }
    })
  })
})
