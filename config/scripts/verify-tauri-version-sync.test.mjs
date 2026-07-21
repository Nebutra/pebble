import assert from 'node:assert/strict'
import test from 'node:test'

import { assertTauriVersionsMatch } from './verify-tauri-version-sync.mjs'

test('accepts one product version across every desktop manifest', () => {
  assert.equal(
    assertTauriVersionsMatch({
      rootPackage: '1.4.124-rc.8',
      desktopPackage: '1.4.124-rc.8',
      tauriConfig: '1.4.124-rc.8',
      cargoPackage: '1.4.124-rc.8'
    }),
    '1.4.124-rc.8'
  )
})

test('reports every manifest version when one source drifts', () => {
  assert.throws(
    () =>
      assertTauriVersionsMatch({
        rootPackage: '1.4.124-rc.8',
        desktopPackage: '0.1.0',
        tauriConfig: '1.4.124-rc.8',
        cargoPackage: '1.4.124-rc.8'
      }),
    /rootPackage=1\.4\.124-rc\.8, desktopPackage=0\.1\.0/
  )
})
