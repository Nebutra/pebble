import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }))

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

import { createPebbleFeedbackApi } from './tauri-feedback-api'

describe('createPebbleFeedbackApi', () => {
  beforeEach(() => invokeMock.mockReset())

  it('submits through the native Tauri host with the canonical renderer contract', async () => {
    invokeMock.mockResolvedValue({ ok: true })
    const input = {
      feedback: 'A native feedback report',
      submitAnonymously: false,
      githubLogin: 'trusted-user',
      githubEmail: 'trusted@example.com'
    }

    await expect(createPebbleFeedbackApi().submit(input)).resolves.toEqual({ ok: true })
    expect(invokeMock).toHaveBeenCalledWith('feedback_submit', { input })
  })
})
