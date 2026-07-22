import { EventEmitter } from 'node:events'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn()
}))

vi.mock('child_process', () => ({
  spawn: spawnMock
}))

import { launchPebbleApp, servePebbleApp } from './launch'

class FakeChildProcess extends EventEmitter {
  stdout = new EventEmitter()
  kill = vi.fn()
  unref = vi.fn()
}

describe('servePebbleApp', () => {
  beforeEach(() => {
    spawnMock.mockReset()
    process.env.PEBBLE_APP_EXECUTABLE = '/Applications/Pebble.app/Contents/MacOS/Pebble'
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env.PEBBLE_APP_EXECUTABLE
  })

  it('pins the desktop child cwd to the app root instead of the caller cwd', async () => {
    const child = {
      kill: vi.fn(),
      once: vi.fn(
        (event: string, handler: (code: number | null, signal: string | null) => void) => {
          if (event === 'exit') {
            queueMicrotask(() => handler(0, null))
          }
          return child
        }
      )
    }
    spawnMock.mockReturnValue(child)

    await expect(servePebbleApp({ json: true })).resolves.toBe(0)

    expect(spawnMock).toHaveBeenCalledWith(
      '/Applications/Pebble.app/Contents/MacOS/Pebble',
      ['--serve', '--serve-json'],
      expect.objectContaining({
        cwd: resolve(__dirname, '../../..')
      })
    )
  })

  it('passes mobile pairing through to the foreground server child', async () => {
    const child = {
      kill: vi.fn(),
      once: vi.fn(
        (event: string, handler: (code: number | null, signal: string | null) => void) => {
          if (event === 'exit') {
            queueMicrotask(() => handler(0, null))
          }
          return child
        }
      )
    }
    spawnMock.mockReturnValue(child)

    await expect(
      servePebbleApp({
        json: true,
        port: '6768',
        pairingAddress: '100.64.1.20',
        mobilePairing: true
      })
    ).resolves.toBe(0)

    expect(spawnMock).toHaveBeenCalledWith(
      '/Applications/Pebble.app/Contents/MacOS/Pebble',
      [
        '--serve',
        '--serve-json',
        '--serve-port',
        '6768',
        '--serve-pairing-address',
        '100.64.1.20',
        '--serve-mobile-pairing'
      ],
      expect.objectContaining({
        cwd: resolve(__dirname, '../../..')
      })
    )
  })

  it('passes serve flags directly to development desktop executables', async () => {
    process.env.PEBBLE_APP_EXECUTABLE = '/repo/apps/desktop/src-tauri/target/debug/pebble'
    const child = {
      kill: vi.fn(),
      once: vi.fn(
        (event: string, handler: (code: number | null, signal: string | null) => void) => {
          if (event === 'exit') {
            queueMicrotask(() => handler(0, null))
          }
          return child
        }
      )
    }
    spawnMock.mockReturnValue(child)

    await expect(servePebbleApp({ json: true, port: '6768' })).resolves.toBe(0)

    expect(spawnMock).toHaveBeenCalledWith(
      '/repo/apps/desktop/src-tauri/target/debug/pebble',
      ['--serve', '--serve-json', '--serve-port', '6768'],
      expect.objectContaining({
        cwd: resolve(__dirname, '../../..')
      })
    )
  })

  it('prints recipe JSON from a detached server child and exits', async () => {
    const child = new FakeChildProcess()
    spawnMock.mockReturnValue(child)
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    const result = servePebbleApp({
      pairingAddress: 'wss://sandbox.example.com',
      recipeJson: true,
      projectRoot: '/workspace/repo'
    })
    queueMicrotask(() => {
      child.stdout.emit(
        'data',
        '{"schemaVersion":1,"pairingCode":"pebble://pair?code=abc","projectRoot":"/workspace/repo"}\n'
      )
    })

    await expect(result).resolves.toBe(0)

    expect(spawnMock).toHaveBeenCalledWith(
      '/Applications/Pebble.app/Contents/MacOS/Pebble',
      [
        '--serve',
        '--serve-pairing-address',
        'wss://sandbox.example.com',
        '--serve-recipe-json',
        '--serve-project-root',
        '/workspace/repo'
      ],
      expect.objectContaining({
        cwd: resolve(__dirname, '../../..'),
        detached: true,
        stdio: ['ignore', 'pipe', 'inherit']
      })
    )
    expect(writeSpy).toHaveBeenCalledWith(
      '{"schemaVersion":1,"pairingCode":"pebble://pair?code=abc","projectRoot":"/workspace/repo"}\n'
    )
    expect(child.unref).toHaveBeenCalled()
  })

  it('uses a shell when a Windows command shim is the desktop executable', async () => {
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'win32' })
    process.env.PEBBLE_APP_EXECUTABLE = 'C:\\repo\\bin\\pebble-dev.cmd'
    const child = {
      kill: vi.fn(),
      once: vi.fn(
        (event: string, handler: (code: number | null, signal: string | null) => void) => {
          if (event === 'exit') {
            queueMicrotask(() => handler(0, null))
          }
          return child
        }
      )
    }
    spawnMock.mockReturnValue(child)

    try {
      await expect(servePebbleApp({ json: true })).resolves.toBe(0)
      expect(spawnMock).toHaveBeenCalledWith(
        'C:\\repo\\bin\\pebble-dev.cmd',
        ['--serve', '--serve-json'],
        expect.objectContaining({
          shell: true
        })
      )
    } finally {
      if (platformDescriptor) {
        Object.defineProperty(process, 'platform', platformDescriptor)
      }
    }
  })
})

describe('launchPebbleApp', () => {
  beforeEach(() => {
    spawnMock.mockReset()
  })

  afterEach(() => {
    delete process.env.PEBBLE_OPEN_COMMAND
    delete process.env.PEBBLE_APP_EXECUTABLE
  })

  it('handles asynchronous detached spawn errors without throwing', async () => {
    process.env.PEBBLE_APP_EXECUTABLE = '/missing/Pebble'
    const child = new FakeChildProcess()
    spawnMock.mockReturnValue(child)

    launchPebbleApp()
    child.emit('error', new Error('ENOENT'))
    await Promise.resolve()

    expect(child.unref).toHaveBeenCalled()
  })
})
