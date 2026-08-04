import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, afterEach } from 'vitest'

import {
  findExistingSpeechLibDir,
  libraryDirectoryHasRequiredLibs,
  resolveLinuxSpeechTarget,
  speechLibRootFor,
  writeGithubEnv
} from '../../apps/desktop/scripts/ensure-linux-speech-link-libs.mjs'

const tempDirs = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true })
  }
})

describe('ensure-linux-speech-link-libs', () => {
  it('resolves triple from arch defaults', () => {
    expect(resolveLinuxSpeechTarget('aarch64-unknown-linux-gnu')).toBe('aarch64-unknown-linux-gnu')
    expect(resolveLinuxSpeechTarget('x86_64-unknown-linux-gnu')).toBe('x86_64-unknown-linux-gnu')
  })

  it('detects a staged speech lib directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'pebble-speech-'))
    tempDirs.push(root)
    const triple = 'x86_64-unknown-linux-gnu'
    const libDir = join(speechLibRootFor(root, triple), 'lib')
    mkdirSync(libDir, { recursive: true })
    writeFileSync(join(libDir, 'libonnxruntime.so'), 'x')
    writeFileSync(join(libDir, 'libsherpa-onnx-c-api.so'), 'y')

    expect(libraryDirectoryHasRequiredLibs(libDir)).toBe(true)
    expect(findExistingSpeechLibDir({ desktopRoot: root, triple, home: root })).toBe(libDir)
  })

  it('writes SHERPA_LIB_PATH to the parent of lib/', () => {
    const env = writeGithubEnv({ libDir: '/tmp/speech/lib' })
    expect(env).toContain('SHERPA_LIB_PATH=/tmp/speech\n')
    expect(env).toContain('PEBBLE_LINUX_SPEECH_LIB_DIR=/tmp/speech/lib\n')
  })
})
