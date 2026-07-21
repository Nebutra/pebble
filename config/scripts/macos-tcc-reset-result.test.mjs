import assert from 'node:assert/strict'
import test from 'node:test'

import { isMissingTccBundleRegistration } from './macos-tcc-reset-result.mjs'

test('accepts an unregistered functional bundle as already not granted', () => {
  assert.equal(
    isMissingTccBundleRegistration(
      'tccutil: No such bundle identifier "nebutra.pebble.functional-gate": ' +
        'The operation could not be completed. (OSStatus error -10814.)'
    ),
    true
  )
})

test('does not hide other tccutil failures', () => {
  assert.equal(isMissingTccBundleRegistration('tccutil: operation not permitted'), false)
  assert.equal(isMissingTccBundleRegistration('OSStatus error -10814.'), false)
})
