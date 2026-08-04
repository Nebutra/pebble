import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, afterEach } from 'vitest'

import {
  findExistingSpeechLibDir,
  libraryDirectoryHasRequiredLibs,
  resolveMacosSpeechTarget,
  speechLibRootFor,
  writeGithubEnv
} from '../../apps/desktop/scripts/ensure-macos-speech-link-libs.mjs'

const tempDirs = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true })
  }
})

describe('ensure-macos-speech-link-libs', () => {
  it('resolves triple from universal / arch defaults', () => {
    expect(resolveMacosSpeechTarget('universal-apple-darwin')).toBe('aarch64-apple-darwin')
    expect(resolveMacosSpeechTarget('aarch64-apple-darwin')).toBe('aarch64-apple-darwin')
    expect(resolveMacosSpeechTarget('x86_64-apple-darwin')).toBe('x86_64-apple-darwin')
  })

  it('detects a staged speech lib directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'pebble-macos-speech-'))
    tempDirs.push(root)
    const triple = 'aarch64-apple-darwin'
    const libDir = join(speechLibRootFor(root, triple), 'lib')
    mkdirSync(libDir, { recursive: true })
    writeFileSync(join(libDir, 'libonnxruntime.1.17.1.dylib'), 'x')
    writeFileSync(join(libDir, 'libsherpa-onnx-c-api.dylib'), 'y')

    expect(libraryDirectoryHasRequiredLibs(libDir)).toBe(true)
    expect(findExistingSpeechLibDir({ desktopRoot: root, triple, home: root })).toBe(libDir)
  })

  it('writes SHERPA_LIB_PATH to the parent of lib/', () => {
    const env = writeGithubEnv({ libDir: '/tmp/speech/lib' })
    expect(env).toContain('SHERPA_LIB_PATH=/tmp/speech\n')
    expect(env).toContain('PEBBLE_MACOS_SPEECH_LIB_DIR=/tmp/speech/lib\n')
  })
})
