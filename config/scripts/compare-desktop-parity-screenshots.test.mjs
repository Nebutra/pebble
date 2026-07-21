import assert from 'node:assert/strict'
import test from 'node:test'

import { PNG } from 'pngjs'

import { compareDesktopParityScreenshots } from './compare-desktop-parity-screenshots.mjs'

function image(width, height, color) {
  const png = new PNG({ width, height })
  for (let offset = 0; offset < png.data.length; offset += 4) {
    png.data.set(color, offset)
  }
  return PNG.sync.write(png)
}

test('desktop parity accepts identical same-size screenshots', () => {
  const screenshot = image(2, 2, [240, 240, 240, 255])
  const result = compareDesktopParityScreenshots(screenshot, screenshot)
  assert.equal(result.matches, true)
  assert.equal(result.mismatchPixels, 0)
})

test('desktop parity reports changed pixels and enforces the mismatch budget', () => {
  const reference = image(2, 2, [240, 240, 240, 255])
  const candidate = PNG.sync.read(reference)
  candidate.data.set([20, 20, 20, 255], 0)
  const result = compareDesktopParityScreenshots(reference, PNG.sync.write(candidate), {
    channelThreshold: 16,
    maxMismatchRatio: 0.2
  })
  assert.equal(result.matches, false)
  assert.equal(result.mismatchPixels, 1)
  assert.equal(result.mismatchRatio, 0.25)
  assert.deepEqual([...PNG.sync.read(result.diffBytes).data.subarray(0, 4)], [255, 0, 72, 255])
})

test('desktop parity rejects captures with different widths', () => {
  assert.throws(
    () => compareDesktopParityScreenshots(image(2, 2, [0, 0, 0, 255]), image(3, 2, [0, 0, 0, 255])),
    /equal widths and near-identical heights/
  )
})

test('desktop parity crops a small macOS window edge height delta', () => {
  const result = compareDesktopParityScreenshots(
    image(2, 2, [0, 0, 0, 255]),
    image(2, 6, [0, 0, 0, 255]),
    { maxMismatchRatio: 0 }
  )
  assert.equal(result.matches, true)
  assert.equal(result.height, 2)
})

test('desktop parity rejects a window edge height delta above four pixels', () => {
  assert.throws(
    () => compareDesktopParityScreenshots(image(2, 2, [0, 0, 0, 255]), image(2, 7, [0, 0, 0, 255])),
    /equal widths and near-identical heights/
  )
})

test('desktop parity tolerates two-pixel edge raster shifts but not added pixels', () => {
  const reference = PNG.sync.read(image(6, 1, [240, 240, 240, 255]))
  reference.data.set([20, 20, 20, 255], 4)
  const shifted = PNG.sync.read(image(6, 1, [240, 240, 240, 255]))
  shifted.data.set([20, 20, 20, 255], 12)
  const shiftedResult = compareDesktopParityScreenshots(
    PNG.sync.write(reference),
    PNG.sync.write(shifted),
    { maxMismatchRatio: 0 }
  )
  assert.equal(shiftedResult.matches, true)

  const added = PNG.sync.read(PNG.sync.write(reference))
  added.data.set([20, 20, 20, 255], 20)
  const addedResult = compareDesktopParityScreenshots(
    PNG.sync.write(reference),
    PNG.sync.write(added),
    { maxMismatchRatio: 0 }
  )
  assert.equal(addedResult.matches, false)
})

test('desktop parity tolerates edge antialiasing without weakening flat color checks', () => {
  const reference = PNG.sync.read(image(3, 1, [240, 240, 240, 255]))
  reference.data.set([20, 20, 20, 255], 4)
  const antialiased = PNG.sync.read(PNG.sync.write(reference))
  antialiased.data.set([75, 75, 75, 255], 4)
  assert.equal(
    compareDesktopParityScreenshots(PNG.sync.write(reference), PNG.sync.write(antialiased), {
      maxMismatchRatio: 0
    }).matches,
    true
  )

  const flatReference = image(3, 1, [240, 240, 240, 255])
  const flatChange = image(3, 1, [190, 190, 190, 255])
  assert.equal(
    compareDesktopParityScreenshots(flatReference, flatChange, { maxMismatchRatio: 0 }).matches,
    false
  )
})
