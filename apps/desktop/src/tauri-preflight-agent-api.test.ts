import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invokeMock, readStatusMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  readStatusMock: vi.fn()
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('./pebble-tauri-runtime-transport', () => ({
  readPebbleStatusOrNull: readStatusMock
}))

import type { PreflightStatus } from '../../../packages/product-core/shared/preflight-api-types'
import { readTauriPreflightStatus } from './tauri-preflight-agent-api'

const fallback: PreflightStatus = {
  git: { installed: false },
  gh: { installed: false, authenticated: false },
  glab: { installed: false, authenticated: false }
}

describe('readTauriPreflightStatus', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    readStatusMock.mockReset()
    invokeMock.mockImplementation((command: string) => {
      if (command === 'preflight_detect_commands') {
        return Promise.resolve([])
      }
      if (command === 'preflight_probe_auth') {
        return Promise.resolve([])
      }
      throw new Error(`unexpected command: ${command}`)
    })
  })

  it('does not report Git installed while runtime status and native detection are unavailable', async () => {
    readStatusMock.mockResolvedValue(null)

    await expect(readTauriPreflightStatus(fallback)).resolves.toMatchObject({
      git: { installed: false }
    })
  })

  it('uses the native PATH probe when Git is detected', async () => {
    readStatusMock.mockResolvedValue(null)
    invokeMock.mockImplementation((command: string) =>
      Promise.resolve(command === 'preflight_detect_commands' ? ['git'] : [])
    )

    await expect(readTauriPreflightStatus(fallback)).resolves.toMatchObject({
      git: { installed: true }
    })
  })

  it('accepts an initialized runtime that explicitly has Git available', async () => {
    readStatusMock.mockResolvedValue({ unavailableTools: [] })

    await expect(readTauriPreflightStatus(fallback)).resolves.toMatchObject({
      git: { installed: true }
    })
  })
})
