// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

import { parseWarpThemeYaml } from '../../../packages/product-core/shared/warp-themes/parser'
import { previewTauriWarpThemeImport } from './tauri-warp-theme-import-api'

class ParserWorker {
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: (() => void) | null = null
  postMessage(args: Parameters<typeof parseWarpThemeYaml>): void {
    queueMicrotask(() => this.onmessage?.({ data: parseWarpThemeYaml(...args) } as MessageEvent))
  }
  terminate(): void {}
}

describe('Tauri Warp theme import', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    vi.stubGlobal('Worker', ParserWorker)
  })

  it('rejects invalid source objects before opening a native picker', async () => {
    await expect(
      previewTauriWarpThemeImport({ kind: 'chooseFile', path: '/tmp' })
    ).resolves.toEqual({
      found: false,
      themes: [],
      skippedFiles: [],
      error: 'Invalid Warp theme import source.'
    })
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('parses real native file contents and preserves skipped files', async () => {
    invokeMock.mockResolvedValue({
      canceled: false,
      sourceLabel: 'Selected Warp themes',
      files: [
        {
          label: 'pebble.yaml',
          sourceLabel: 'Selected Warp themes',
          contentHashDiscriminator: false,
          content: `name: Pebble\nbackground: '#111111'\nforeground: '#eeeeee'\nterminal_colors:\n  normal:\n    red: '#ff0000'\n`
        }
      ],
      skippedFiles: [{ label: 'bad.yaml', reason: 'Could not read file.' }]
    })

    const preview = await previewTauriWarpThemeImport({ kind: 'auto' })

    expect(preview.found).toBe(true)
    expect(preview.themes[0]).toMatchObject({
      name: 'Pebble',
      source: 'warp',
      terminal: { background: '#111111', foreground: '#eeeeee', red: '#ff0000' }
    })
    expect(preview.skippedFiles).toEqual([{ label: 'bad.yaml', reason: 'Could not read file.' }])
  })

  it('preserves native picker cancellation', async () => {
    invokeMock.mockResolvedValue({ canceled: true, files: [], skippedFiles: [] })
    await expect(previewTauriWarpThemeImport({ kind: 'chooseFolder' })).resolves.toEqual({
      found: false,
      canceled: true,
      themes: [],
      skippedFiles: []
    })
  })
})
