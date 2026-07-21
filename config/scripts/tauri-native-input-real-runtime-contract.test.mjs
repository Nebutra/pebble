import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('../../', import.meta.url)

async function source(path) {
  return readFile(new URL(path, root), 'utf8')
}

test('focused gate mounts and registers a production child WebView', async () => {
  const [runner, gate, packageJson, functionalConfig] = await Promise.all([
    source('config/scripts/run-tauri-real-runtime-gate.mjs'),
    source('apps/desktop/src/tauri-real-runtime-gate.ts'),
    source('package.json'),
    source('apps/desktop/config/tauri.functional.conf.json')
  ])

  assert.match(packageJson, /verify:tauri-real-runtime:native-input/)
  assert.match(packageJson, /verify:tauri-real-runtime:native-drag/)
  assert.match(runner, /--native-input-only/)
  assert.match(runner, /--native-drag-only/)
  assert.match(runner, /VITE_TAURI_REAL_RUNTIME_NATIVE_INPUT_ONLY/)
  assert.match(runner, /VITE_TAURI_REAL_RUNTIME_NATIVE_DRAG_ONLY/)
  assert.match(
    runner,
    /\['reset', 'Accessibility', 'nebutra\.pebble\.functional-gate'\]/
  )
  assert.match(runner, /browserFunctionalGateAccessibilityReset/)
  assert.equal(JSON.parse(functionalConfig).identifier, 'nebutra.pebble.functional-gate')
  assert.match(gate, /ensureTauriBrowserPageWebview/)
  assert.match(gate, /browserPageId = focusedNativeInputGate\s*\? crypto\.randomUUID\(\)/)
  assert.match(gate, /addEventListener\('dom-ready'/)
  assert.match(gate, /window\.api\.browser\.registerGuest/)
  assert.ok(
    gate.indexOf('await mountNativeInputGateWebview') <
      gate.indexOf('await verifyMacosTrustedBrowserInput')
  )
})

test('runtime evidence separates permission-free input from helper-authorized drag', async () => {
  const evidence = await source(
    'apps/desktop/src/tauri-real-runtime-native-input-evidence.ts'
  )

  assert.match(evidence, /accessibilityStatus !== 'not-granted'/)
  assert.match(evidence, /backend !== 'appkit-async-responder'/)
  for (const field of [
    'browserTrustedMouseInput',
    'browserTrustedKeyInput',
    'browserTrustedTextInput',
    'browserTrustedWheelInput',
    'browserTrustedCheckInput',
    'browserTrustedSelectInput',
    'browserTrustedFrameShadowInput'
  ]) {
    assert.match(evidence, new RegExp(`${field}: true`))
  }
  assert.match(evidence, /browserTrustedDragInput: false/)
  assert.match(evidence, /verifyMacosTrustedBrowserDrag/)
  assert.match(evidence, /accessibilityStatus !== 'granted'/)
  assert.match(evidence, /browserTrustedDragInput: true/)
  assert.match(evidence, /event\.trusted/)
  assert.doesNotMatch(evidence, /dispatchEvent\(/)
  assert.doesNotMatch(evidence, /\.value\s*=/)
  assert.doesNotMatch(evidence, /\.checked\s*=/)
  assert.doesNotMatch(evidence, /\.click\(/)
})
