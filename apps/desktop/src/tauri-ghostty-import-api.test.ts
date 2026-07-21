// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { GlobalSettings } from '../../../packages/product-core/shared/types'

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

import { previewTauriGhosttyImport } from './tauri-ghostty-import-api'

describe('Tauri Ghostty import', () => {
  beforeEach(() => {
    invokeMock.mockReset()
  })

  it('parses every native source in Ghostty load order and omits unchanged settings', async () => {
    invokeMock.mockResolvedValue({
      configs: [
        { path: '/home/a/.config/ghostty/config.ghostty', content: 'font-size = 16\n' },
        {
          path: '/home/a/.config/ghostty/config',
          content: 'font-family = JetBrains Mono\nfont-size = 18\nbackground = #111111\n'
        }
      ]
    })

    const preview = await previewTauriGhosttyImport({
      terminalFontFamily: 'JetBrains Mono',
      terminalFontSize: 12
    } as GlobalSettings)

    expect(preview).toMatchObject({
      found: true,
      configPath: '/home/a/.config/ghostty/config.ghostty',
      configPaths: ['/home/a/.config/ghostty/config.ghostty', '/home/a/.config/ghostty/config'],
      diff: {
        terminalFontSize: 18,
        terminalColorOverrides: { background: '#111111' }
      },
      unsupportedKeys: []
    })
  })

  it('loads named theme colors natively while explicit config colors win', async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === 'settings_read_ghostty_sources') {
        return Promise.resolve({
          configs: [
            {
              path: '/home/a/.config/ghostty/config',
              content: 'theme = Pebble Dark\nforeground = #eeeeee\n'
            }
          ]
        })
      }
      return Promise.resolve('background = #111111\nforeground = #aaaaaa\nfont-size = 99\n')
    })

    const preview = await previewTauriGhosttyImport({} as GlobalSettings)

    expect(invokeMock).toHaveBeenCalledWith('settings_read_ghostty_theme', {
      input: { name: 'Pebble Dark' }
    })
    expect(preview.diff.terminalColorOverrides).toEqual({
      background: '#111111',
      foreground: '#eeeeee'
    })
    expect(preview.diff.terminalFontSize).toBeUndefined()
  })

  it('returns an explicit error instead of a synthetic empty success', async () => {
    invokeMock.mockRejectedValue(new Error('Could not read config: denied'))

    await expect(previewTauriGhosttyImport({} as GlobalSettings)).resolves.toEqual({
      found: false,
      diff: {},
      unsupportedKeys: [],
      error: 'Could not read config: denied'
    })
  })
})
