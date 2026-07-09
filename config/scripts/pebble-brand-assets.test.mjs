import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PNG } from 'pngjs'

const scriptDir = import.meta.dirname
const projectDir = dirname(dirname(scriptDir))

const freeformIconAssets = [
  'resources/build/icon.png',
  'resources/icon.png',
  'resources/icon-dev.png',
  'resources/app-icons/pebble-watercolor.png',
  'resources/app-icons/pebble-blue.png',
  'mobile/assets/adaptive-icon.png',
  'mobile/assets/favicon.png'
]

function readPngAsset(relativePath) {
  const png = PNG.sync.read(readFileSync(join(projectDir, relativePath)))
  return { width: png.width, height: png.height, data: png.data }
}

function alphaAt(image, x, y) {
  return image.data[(y * image.width + x) * 4 + 3]
}

function maxAlpha(image) {
  let max = 0
  for (let index = 3; index < image.data.length; index += 4) {
    max = Math.max(max, image.data[index])
  }
  return max
}

describe('Pebble brand product icons', () => {
  it.each(freeformIconAssets)('%s keeps transparent corners for freeform app icons', (path) => {
    const image = readPngAsset(path)
    // Why: desktop platforms should receive the pebble silhouette itself; any
    // rounded-square plate is a generated reference texture, not a shippable icon.
    expect([
      alphaAt(image, 0, 0),
      alphaAt(image, image.width - 1, 0),
      alphaAt(image, 0, image.height - 1),
      alphaAt(image, image.width - 1, image.height - 1)
    ]).toEqual([0, 0, 0, 0])
    expect(maxAlpha(image)).toBeGreaterThan(0)
  })
})
