import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  findReleaseLibraryDirectory,
  stageMacosSpeechLibraries
} from '../../apps/desktop/scripts/stage-macos-speech-libraries.mjs'

const temporaryDirectories = []

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { force: true, recursive: true })
  }
})

function temporaryRoot() {
  const path = mkdtempSync(join(tmpdir(), 'pebble-speech-libraries-'))
  temporaryDirectories.push(path)
  return path
}

function writeLibraries(directory) {
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'libonnxruntime.1.17.1.dylib'), 'onnx')
  writeFileSync(join(directory, 'libsherpa-onnx-c-api.dylib'), 'sherpa')
}

describe('macOS speech library staging', () => {
  it('copies the complete local speech runtime into a stable bundle input', () => {
    const root = temporaryRoot()
    const release = join(root, 'aarch64-apple-darwin/release')
    const staging = join(root, 'staged')
    writeLibraries(release)

    expect(findReleaseLibraryDirectory(root)).toBe(release)
    expect(stageMacosSpeechLibraries({ sourceRoot: root, stagingRoot: staging }).libraries).toEqual([
      'libonnxruntime.1.17.1.dylib',
      'libsherpa-onnx-c-api.dylib'
    ])
  })

  it('rejects a partial runtime before Tauri creates a broken app bundle', () => {
    const root = temporaryRoot()
    const release = join(root, 'release')
    mkdirSync(release, { recursive: true })
    writeFileSync(join(release, 'libonnxruntime.1.17.1.dylib'), 'onnx')

    expect(() => findReleaseLibraryDirectory(root)).toThrow(/Could not find/)
  })
})
