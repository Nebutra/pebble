import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { PNG } from 'pngjs'
import {
  analyzeRuntimeScreenshot,
  validateTauriRuntimeScreenshots
} from './tauri-real-runtime-screenshot-evidence.mjs'

test('rejects a window-sized image containing only a flat background', () => {
  const bytes = fixturePng(160, 120, () => [246, 246, 246, 255])
  assert.throws(() => analyzeRuntimeScreenshot(bytes, 'terminal'), /no credible composited content/)
})

test('writes metrics for nonblank stage-distinct runtime surfaces', () => {
  const directory = mkdtempSync(join(tmpdir(), 'tauri-runtime-evidence-'))
  try {
    for (const [surfaceIndex, surface] of [
      'terminal',
      'browser',
      'source-control',
      'checks'
    ].entries()) {
      writeFileSync(
        join(directory, `tauri-${surface}.png`),
        fixturePng(160, 120, (x, y) => {
          const stripe = (x + surfaceIndex * 19) % 47 < 12 || (y + surfaceIndex * 13) % 31 < 7
          return stripe
            ? [25 + surfaceIndex * 28, 40 + (x % 80), 70 + (y % 100), 255]
            : [242, 242, 242, 255]
        })
      )
    }
    const report = validateTauriRuntimeScreenshots(directory)
    assert.equal(Object.keys(report.surfaces).length, 4)
    assert.equal(report.distinctions.length, 6)
    assert.ok(report.surfaces.terminal.nonDominantRatio > 0.01)
    assert.equal(
      JSON.parse(readFileSync(join(directory, 'tauri-real-runtime-capture-evidence.json'), 'utf8'))
        .schemaVersion,
      1
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

function fixturePng(width, height, pixel) {
  const png = new PNG({ width, height })
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4
      const value = pixel(x, y)
      png.data.set(value, offset)
    }
  }
  return PNG.sync.write(png)
}
