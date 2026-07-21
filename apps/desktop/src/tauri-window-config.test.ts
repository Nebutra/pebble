import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

type WindowConfig = {
  maximized?: boolean
  visible?: boolean
  decorations?: boolean
  titleBarStyle?: string
  hiddenTitle?: boolean
}

const packageRoot = fileURLToPath(new URL('..', import.meta.url))

function readWindowConfig(...pathSegments: string[]): WindowConfig {
  const config = JSON.parse(readFileSync(join(packageRoot, ...pathSegments), 'utf8')) as {
    app: { windows: WindowConfig[] }
  }
  return config.app.windows[0]
}

function readMainWindowPermissions(): string[] {
  const capability = JSON.parse(
    readFileSync(join(packageRoot, 'src-tauri', 'capabilities', 'main.json'), 'utf8')
  ) as { permissions: string[] }
  return capability.permissions
}

describe('Tauri platform window configuration', () => {
  it('keeps native decorated overlay chrome on macOS', () => {
    const window = readWindowConfig('src-tauri', 'tauri.conf.json')

    expect(window).toMatchObject({
      maximized: false,
      visible: false,
      decorations: true,
      titleBarStyle: 'Overlay',
      hiddenTitle: true
    })
  })

  it('keeps the optimized native shell hidden until its renderer is ready', () => {
    const window = readWindowConfig('config', 'tauri.optimized.conf.json')

    expect(window).toMatchObject({
      maximized: false,
      visible: false,
      decorations: true,
      titleBarStyle: 'Overlay'
    })
  })

  it.each(['linux', 'windows'])(
    'uses renderer chrome without forced maximize on %s',
    (platform) => {
      const window = readWindowConfig('src-tauri', `tauri.${platform}.conf.json`)

      expect(window).toMatchObject({
        maximized: false,
        visible: false,
        decorations: false
      })
      expect(window.titleBarStyle).toBeUndefined()
    }
  )

  it('authorizes the native close fallback operations used by the renderer bridge', () => {
    expect(readMainWindowPermissions()).toEqual(
      expect.arrayContaining(['core:window:allow-destroy', 'core:window:allow-hide'])
    )
  })
})
