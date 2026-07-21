import assert from 'node:assert/strict'
import test from 'node:test'

import { syncTauriReleaseVersionSources } from './sync-tauri-release-version.mjs'

function sources(overrides = {}) {
  return {
    desktopPackage: '{\n  "name": "@pebble/desktop",\n  "version": "1.4.1"\n}\n',
    tauriConfig: '{\n  "productName": "Pebble",\n  "version": "1.4.1"\n}\n',
    cargoManifest: '[package]\nname = "pebble-desktop-tauri"\nversion = "1.4.1"\n\n[dependencies]\nserde = "1"\n',
    cargoLock:
      '[[package]]\nname = "dependency"\nversion = "1.4.1"\n\n[[package]]\nname = "pebble-desktop-tauri"\nversion = "1.4.1"\ndependencies = []\n',
    ...overrides
  }
}

test('synchronizes every tracked Tauri version source', () => {
  const next = syncTauriReleaseVersionSources(sources(), 'v1.5.0-rc.2')

  assert.equal(JSON.parse(next.desktopPackage).version, '1.5.0-rc.2')
  assert.equal(JSON.parse(next.tauriConfig).version, '1.5.0-rc.2')
  assert.match(next.cargoManifest, /name = "pebble-desktop-tauri"\nversion = "1\.5\.0-rc\.2"/)
  assert.match(next.cargoLock, /name = "pebble-desktop-tauri"\nversion = "1\.5\.0-rc\.2"/)
  assert.match(next.cargoLock, /name = "dependency"\nversion = "1\.4\.1"/)
})

test('rejects malformed versions and ambiguous Cargo package records', () => {
  assert.throws(() => syncTauriReleaseVersionSources(sources(), 'latest'), /valid semver/)
  assert.throws(
    () =>
      syncTauriReleaseVersionSources(
        sources({
          cargoLock:
            '[[package]]\nname = "pebble-desktop-tauri"\nversion = "1.4.1"\n\n[[package]]\nname = "pebble-desktop-tauri"\nversion = "1.4.1"\n'
        }),
        '1.5.0'
      ),
    /exactly one semver/
  )
})
