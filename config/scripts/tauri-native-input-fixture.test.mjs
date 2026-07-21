import assert from 'node:assert/strict'
import test from 'node:test'

import {
  nativeInputFixtureHtml,
  nativeInputFrameFixtureHtml
} from './tauri-native-input-fixture.mjs'

test('trusted input fixture exposes controls and read-only evidence', () => {
  const html = nativeInputFixtureHtml('http://127.0.0.1/frame')
  for (const id of [
    'mouse-target',
    'text-target',
    'key-target',
    'wheel-target',
    'drag-source',
    'drop-target',
    'check-target',
    'select-target',
    'same-origin-frame'
  ]) {
    assert.match(html, new RegExp(`id=["']${id}["']`))
  }
  assert.match(html, /event\.isTrusted/)
  assert.match(html, /__pebbleNativeInputEvidence=\(\)=>/)
  assert.doesNotMatch(html, /dispatchEvent\(/)
})

test('same-origin frame fixture routes through an open shadow root', () => {
  const html = nativeInputFrameFixtureHtml()
  assert.match(html, /attachShadow\(\{mode:'open'\}\)/)
  assert.match(html, /frame-button/)
  assert.match(html, /frame-input/)
  assert.match(html, /event\.isTrusted/)
  assert.doesNotMatch(html, /dispatchEvent\(/)
})
