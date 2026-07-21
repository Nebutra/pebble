import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

const root = resolve(import.meta.dirname, '../..')
const gateSource = readFileSync(resolve(root, 'config/scripts/run-tauri-pixel-performance-gate.mjs'), 'utf8')

describe('approved desktop pixel baselines', () => {
  it('keeps the release gate independent from the Electron process', () => {
    assert.match(gateSource, /tests\/e2e\/baselines\/desktop/)
    assert.doesNotMatch(gateSource, /electron-headless|PEBBLE_ELECTRON_|['"]playwright['"]/)
  })

  for (const surface of ['landing', 'update', 'crash', 'settings']) {
    it(`ships a nonempty ${surface} oracle`, () => {
      const image = resolve(root, `tests/e2e/baselines/desktop/${surface}.png`)
      const viewport = `${image}.viewport.json`
      assert.equal(existsSync(image), true)
      assert.ok(statSync(image).size > 10_000)
      assert.equal(readFileSync(image).subarray(1, 4).toString('ascii'), 'PNG')
      assert.deepEqual(JSON.parse(readFileSync(viewport, 'utf8')), { width: 1728, height: 994 })
    })
  }
})
