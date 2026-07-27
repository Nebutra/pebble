import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { prepareMacosNativeTestResources } from '../../apps/desktop/scripts/prepare-macos-native-test-resources.mjs'

const temporaryDirectories = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true })
  }
})

function desktopFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'pebble-macos-native-test-'))
  temporaryDirectories.push(directory)
  return directory
}

describe('prepareMacosNativeTestResources', () => {
  it('creates the macOS resource paths Cargo validates without overwriting real libraries', () => {
    const desktopRoot = desktopFixture()
    const first = prepareMacosNativeTestResources({ desktopRoot, platform: 'darwin' })
    expect(first.prepared).toBe(true)
    expect(first.paths.map((path) => basename(path))).toEqual([
      'libonnxruntime.1.17.1.dylib',
      'libsherpa-onnx-c-api.dylib'
    ])
    expect(first.paths.every((path) => existsSync(path))).toBe(true)

    writeFileSync(first.paths[0], 'real-library')
    prepareMacosNativeTestResources({ desktopRoot, platform: 'darwin' })
    expect(readFileSync(first.paths[0], 'utf8')).toBe('real-library')
  })

  it('is a no-op away from macOS', () => {
    const desktopRoot = desktopFixture()
    expect(prepareMacosNativeTestResources({ desktopRoot, platform: 'linux' })).toEqual({
      prepared: false,
      paths: []
    })
  })
})
