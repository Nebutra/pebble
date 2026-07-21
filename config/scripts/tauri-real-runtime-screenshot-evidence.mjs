import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PNG } from 'pngjs'

const SURFACES = ['terminal', 'browser', 'source-control', 'checks']
const CONTENT_TOP_PX = 48
const MIN_LUMINANCE_RANGE = 20
const MIN_QUANTIZED_COLORS = 12
const MIN_NON_DOMINANT_RATIO = 0.01
const MIN_SURFACE_MISMATCH_RATIO = 0.0005

export function validateTauriRuntimeScreenshots(directory) {
  const captures = Object.fromEntries(
    SURFACES.map((surface) => {
      const path = join(directory, `tauri-${surface}.png`)
      return [surface, analyzeRuntimeScreenshot(readFileSync(path), surface)]
    })
  )
  const distinctions = []
  for (let leftIndex = 0; leftIndex < SURFACES.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < SURFACES.length; rightIndex += 1) {
      const left = SURFACES[leftIndex]
      const right = SURFACES[rightIndex]
      const mismatchRatio = pixelMismatchRatio(captures[left].png, captures[right].png)
      distinctions.push({ left, right, mismatchRatio })
      if (mismatchRatio < MIN_SURFACE_MISMATCH_RATIO) {
        throw new Error(
          `${left} and ${right} runtime captures are not stage-distinct: ` +
            `${(mismatchRatio * 100).toFixed(3)}% changed pixels`
        )
      }
    }
  }
  const report = {
    schemaVersion: 1,
    captureBackend: process.platform === 'darwin' ? 'macos-window-server' : 'native-webview',
    surfaces: Object.fromEntries(
      SURFACES.map((surface) => {
        const { png: _png, ...metrics } = captures[surface]
        return [surface, metrics]
      })
    ),
    distinctions
  }
  writeFileSync(
    join(directory, 'tauri-real-runtime-capture-evidence.json'),
    `${JSON.stringify(report, null, 2)}\n`
  )
  return report
}

export function analyzeRuntimeScreenshot(bytes, surface) {
  const png = PNG.sync.read(bytes)
  const top = Math.min(CONTENT_TOP_PX, Math.max(0, png.height - 1))
  const colors = new Map()
  let minimumLuminance = 255
  let maximumLuminance = 0
  let opaquePixels = 0
  for (let y = top; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      const offset = (y * png.width + x) * 4
      if (png.data[offset + 3] < 245) {
        continue
      }
      const red = png.data[offset]
      const green = png.data[offset + 1]
      const blue = png.data[offset + 2]
      const luminance = Math.round(red * 0.299 + green * 0.587 + blue * 0.114)
      minimumLuminance = Math.min(minimumLuminance, luminance)
      maximumLuminance = Math.max(maximumLuminance, luminance)
      const color = ((red >> 4) << 8) | ((green >> 4) << 4) | (blue >> 4)
      colors.set(color, (colors.get(color) ?? 0) + 1)
      opaquePixels += 1
    }
  }
  const dominantPixels = Math.max(0, ...colors.values())
  const nonDominantRatio = opaquePixels === 0 ? 0 : (opaquePixels - dominantPixels) / opaquePixels
  const luminanceRange = maximumLuminance - minimumLuminance
  if (
    opaquePixels === 0 ||
    luminanceRange < MIN_LUMINANCE_RANGE ||
    colors.size < MIN_QUANTIZED_COLORS ||
    nonDominantRatio < MIN_NON_DOMINANT_RATIO
  ) {
    const metrics = { opaquePixels, luminanceRange, quantizedColors: colors.size, nonDominantRatio }
    throw new Error(
      `${surface} runtime capture has no credible composited content: ${JSON.stringify(metrics)}`
    )
  }
  return {
    png,
    width: png.width,
    height: png.height,
    contentTopPx: top,
    opaquePixels,
    luminanceRange,
    quantizedColors: colors.size,
    nonDominantRatio
  }
}

function pixelMismatchRatio(left, right) {
  if (left.width !== right.width || left.height !== right.height) {
    return 1
  }
  const top = Math.min(CONTENT_TOP_PX, Math.max(0, left.height - 1))
  let changed = 0
  let compared = 0
  for (let y = top; y < left.height; y += 1) {
    for (let x = 0; x < left.width; x += 1) {
      const offset = (y * left.width + x) * 4
      if (
        Math.abs(left.data[offset] - right.data[offset]) > 8 ||
        Math.abs(left.data[offset + 1] - right.data[offset + 1]) > 8 ||
        Math.abs(left.data[offset + 2] - right.data[offset + 2]) > 8
      ) {
        changed += 1
      }
      compared += 1
    }
  }
  return compared === 0 ? 0 : changed / compared
}
