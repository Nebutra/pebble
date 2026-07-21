import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('../../', import.meta.url)

test('macOS capture is owned by the visible functional WKWebView', async () => {
  const [runner, gate] = await Promise.all([
    readFile(new URL('config/scripts/run-tauri-real-runtime-gate.mjs', root), 'utf8'),
    readFile(new URL('apps/desktop/src/tauri-real-runtime-gate.ts', root), 'utf8')
  ])

  assert.match(gate, /getCurrentWindow\(\)\.label !== 'optimized'/)
  assert.match(runner, /kCGWindowIsOnscreen as String/)
  assert.match(runner, /kCGWindowLayer as String/)
  assert.match(runner, /\['-x', '-o', `-l\$\{windowId\}`, output\]/)
  assert.match(runner, /surface && !capturedSurfaces\.has\(surface\)/)
  assert.doesNotMatch(runner, /surface === 'browser'/)
})
