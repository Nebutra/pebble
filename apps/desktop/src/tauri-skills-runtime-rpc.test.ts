import { describe, expect, it, vi } from 'vitest'

const { requestRuntimeJsonMock } = vi.hoisted(() => ({ requestRuntimeJsonMock: vi.fn() }))
vi.mock('./pebble-tauri-runtime-transport', () => ({ requestRuntimeJson: requestRuntimeJsonMock }))

import { callTauriSkillsRuntimeRpc } from './tauri-skills-runtime-rpc'

describe('callTauriSkillsRuntimeRpc', () => {
  it('discovers skills through the Go runtime with a normalized cwd', async () => {
    requestRuntimeJsonMock.mockResolvedValue({ skills: [], sources: [], scannedAt: 1 })
    await expect(
      callTauriSkillsRuntimeRpc('skills.discover', { cwd: ' /repo/worktree ' })
    ).resolves.toEqual({ handled: true, result: { skills: [], sources: [], scannedAt: 1 } })
    expect(requestRuntimeJsonMock).toHaveBeenCalledWith('/v1/skills/discover', {
      method: 'POST',
      timeoutMs: 15_000,
      body: { cwd: '/repo/worktree' }
    })
  })

  it('sends an empty scope for host-wide discovery', async () => {
    requestRuntimeJsonMock.mockResolvedValue({ skills: [], sources: [], scannedAt: 1 })
    await callTauriSkillsRuntimeRpc('skills.discover', null)
    expect(requestRuntimeJsonMock).toHaveBeenCalledWith('/v1/skills/discover', {
      method: 'POST',
      timeoutMs: 15_000,
      body: {}
    })
  })
})
