import { describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn()
}))

import { createRuntimeProcessStartCommand } from './runtime-bridge'

describe('createRuntimeProcessStartCommand', () => {
  it('leaves executable blank by default so the Rust side resolves its own bundled binary path', () => {
    const command = createRuntimeProcessStartCommand({ listen: '127.0.0.1:17777' })

    // A hardcoded literal like "pebble-runtime" would defeat the Rust command's
    // own environment-aware default (the binary bundled next to the running
    // executable) and fail to spawn whenever "pebble-runtime" isn't separately
    // on PATH, e.g. every dev build.
    expect(command.executable).toBe('')
    expect(command.listen).toBe('127.0.0.1:17777')
  })

  it('honors an explicit executable override when one is provided', () => {
    const command = createRuntimeProcessStartCommand({
      listen: '127.0.0.1:17777',
      executable: '/custom/path/pebble-runtime'
    })

    expect(command.executable).toBe('/custom/path/pebble-runtime')
  })
})
