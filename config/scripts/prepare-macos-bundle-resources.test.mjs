import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { prepareMacosBundleResources } from '../../apps/desktop/scripts/prepare-macos-bundle-resources.mjs'

describe('macOS Tauri bundle resource preparation', () => {
  it('stages speech libraries before building the signed computer-use helper', () => {
    const run = vi.fn()
    const desktopRoot = resolve('/workspace/apps/desktop')
    const environment = { PEBBLE_MAC_RELEASE: '1' }

    expect(
      prepareMacosBundleResources({ desktopRoot, environment, platform: 'darwin', run })
    ).toEqual({ prepared: true })
    expect(run.mock.calls.map(([, [path]]) => path)).toEqual([
      resolve(desktopRoot, 'scripts/stage-macos-speech-libraries.mjs'),
      resolve(desktopRoot, '../../config/scripts/build-computer-macos.mjs')
    ])
    expect(run.mock.calls.every(([, , options]) => options.env === environment)).toBe(true)
  })

  it('does not invoke Apple tooling on Linux or Windows', () => {
    const run = vi.fn()

    expect(
      prepareMacosBundleResources({
        desktopRoot: '/workspace/apps/desktop',
        environment: {},
        platform: 'linux',
        run
      })
    ).toEqual({ prepared: false })
    expect(run).not.toHaveBeenCalled()
  })
})
