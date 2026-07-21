import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanPebbleGeneratedArtifacts } from './clean-pebble-generated-artifacts.mjs'

const temporaryRoots = []

afterEach(() => {
  while (temporaryRoots.length > 0) {
    rmSync(temporaryRoots.pop(), { force: true, recursive: true })
  }
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'pebble-generated-clean-'))
  temporaryRoots.push(root)
  for (const path of [
    'dist/result.js',
    'native/zig-system/.zig-cache/object',
    'apps/desktop/src-tauri/target/debug/app',
    'apps/desktop/src-tauri/target/release/bundle/macos/Pebble.app/marker'
  ]) {
    const file = join(root, path)
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, path)
  }
  return root
}

describe('Pebble generated artifact cleanup', () => {
  it('removes caches while preserving the previewable release bundle', () => {
    const root = fixture()
    cleanPebbleGeneratedArtifacts(root)
    expect(existsSync(join(root, 'dist'))).toBe(false)
    expect(existsSync(join(root, 'native/zig-system/.zig-cache'))).toBe(false)
    expect(existsSync(join(root, 'apps/desktop/src-tauri/target/debug'))).toBe(false)
    expect(
      existsSync(
        join(root, 'apps/desktop/src-tauri/target/release/bundle/macos/Pebble.app')
      )
    ).toBe(true)
  })

  it('removes the entire Rust target only when explicitly requested', () => {
    const root = fixture()
    cleanPebbleGeneratedArtifacts(root, { includeRelease: true })
    expect(existsSync(join(root, 'apps/desktop/src-tauri/target'))).toBe(false)
  })
})
