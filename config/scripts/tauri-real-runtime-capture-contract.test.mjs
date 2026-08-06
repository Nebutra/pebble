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

test('the app is only told to await a capture the host can actually take', async () => {
  // Why: the app blocks in functional_gate_capture_ready after announcing
  // <surface>-capture-ready whenever it receives a screenshot directory, and
  // captureFunctionalWindow only exists on macOS. Handing the directory to a
  // host that cannot capture parks golden mode until the 240s deadline, which
  // is what made `terminal rendering golden linux` time out while the plain
  // gate passed the same build in 8.5s. One constant guards both sides.
  const runner = await readFile(
    new URL('config/scripts/run-tauri-real-runtime-gate.mjs', root),
    'utf8'
  )

  assert.match(runner, /const canCaptureFunctionalWindow = process\.platform === 'darwin'/)
  // the directory is only resolved when the host can capture
  assert.match(
    runner,
    /PEBBLE_REAL_RUNTIME_SCREENSHOT_DIR && canCaptureFunctionalWindow/,
    'screenshotDir must be gated on capture support'
  )
  // and the capture branch reads the same constant rather than re-testing platform
  assert.match(runner, /if \(canCaptureFunctionalWindow && surface/)
  assert.doesNotMatch(
    runner,
    /if \(process\.platform === 'darwin' && surface/,
    'capture branch must not re-derive the platform independently'
  )
})

test('bindings that command() reads are initialized before top-level code calls it', async () => {
  // Why: `command()` is a hoisted declaration invoked from top-level statements,
  // so anything it closes over must already be initialized when those run.
  // Declaring WINDOWS_SHIM_COMMANDS beside the function left it in the temporal
  // dead zone and threw at startup — on Windows only, since every other
  // platform returns from command() before touching it.
  const runner = await readFile(
    new URL('config/scripts/run-tauri-real-runtime-gate.mjs', root),
    'utf8'
  )
  const lines = runner.split('\n')
  const declaration = lines.findIndex((line) => /^const WINDOWS_SHIM_COMMANDS\b/.test(line))
  const firstCall = lines.findIndex((line) => /^[^ /].*\bcommand\(/.test(line))

  assert.notEqual(declaration, -1, 'WINDOWS_SHIM_COMMANDS declaration not found')
  assert.notEqual(firstCall, -1, 'no top-level command() call found')
  assert.ok(
    declaration < firstCall,
    `WINDOWS_SHIM_COMMANDS is declared on line ${declaration + 1} but command() is already called on line ${firstCall + 1}`
  )
})
