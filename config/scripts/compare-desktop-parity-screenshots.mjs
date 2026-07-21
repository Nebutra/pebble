import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

import { PNG } from 'pngjs'

const DEFAULT_CHANNEL_THRESHOLD = 16
const DEFAULT_MAX_MISMATCH_RATIO = 0.015
const DEFAULT_SPATIAL_TOLERANCE_PX = 1
const MAX_WINDOW_EDGE_DELTA_PX = 4
const RASTER_EDGE_CHANNEL_THRESHOLD = 64
const RASTER_EDGE_CONTRAST = 24
const RASTER_EDGE_SPATIAL_TOLERANCE_PX = 2

export function compareDesktopParityScreenshots(referenceBytes, candidateBytes, options = {}) {
  let reference = PNG.sync.read(referenceBytes)
  let candidate = PNG.sync.read(candidateBytes)
  if (
    reference.width !== candidate.width ||
    Math.abs(reference.height - candidate.height) > MAX_WINDOW_EDGE_DELTA_PX
  ) {
    throw new Error(
      `Desktop parity screenshots must have equal widths and near-identical heights: ` +
        `reference=${reference.width}x${reference.height}, ` +
        `candidate=${candidate.width}x${candidate.height}`
    )
  }
  if (reference.height !== candidate.height) {
    // Why: macOS WindowServer can include up to four transient bottom-edge
    // pixels for the same fixed window; compare the shared content rectangle.
    const sharedHeight = Math.min(reference.height, candidate.height)
    reference = cropTop(reference, sharedHeight)
    candidate = cropTop(candidate, sharedHeight)
  }

  const channelThreshold = options.channelThreshold ?? DEFAULT_CHANNEL_THRESHOLD
  const maxMismatchRatio = options.maxMismatchRatio ?? DEFAULT_MAX_MISMATCH_RATIO
  const spatialTolerancePx = options.spatialTolerancePx ?? DEFAULT_SPATIAL_TOLERANCE_PX
  validateUnitInterval(maxMismatchRatio, 'maxMismatchRatio')
  if (!Number.isInteger(channelThreshold) || channelThreshold < 0 || channelThreshold > 255) {
    throw new Error('channelThreshold must be an integer from 0 through 255')
  }
  if (!Number.isInteger(spatialTolerancePx) || spatialTolerancePx < 0 || spatialTolerancePx > 4) {
    throw new Error('spatialTolerancePx must be an integer from 0 through 4')
  }

  const diff = new PNG({ width: reference.width, height: reference.height })
  let mismatchPixels = 0
  for (let offset = 0; offset < reference.data.length; offset += 4) {
    const changed = pixelChanged(reference, candidate, offset, channelThreshold, spatialTolerancePx)
    if (changed) mismatchPixels += 1
    writeDiffPixel(diff.data, candidate.data, offset, changed)
  }

  const totalPixels = reference.width * reference.height
  const mismatchRatio = totalPixels === 0 ? 0 : mismatchPixels / totalPixels
  return {
    matches: mismatchRatio <= maxMismatchRatio,
    width: reference.width,
    height: reference.height,
    mismatchPixels,
    totalPixels,
    mismatchRatio,
    maxMismatchRatio,
    spatialTolerancePx,
    diffBytes: PNG.sync.write(diff)
  }
}

function cropTop(image, height) {
  const cropped = new PNG({ width: image.width, height })
  image.data.copy(cropped.data, 0, 0, image.width * height * 4)
  return cropped
}

function pixelChanged(reference, candidate, offset, threshold, spatialTolerancePx) {
  const rasterEdge = isRasterEdge(reference, offset) || isRasterEdge(candidate, offset)
  const effectiveThreshold = rasterEdge
    ? Math.max(threshold, RASTER_EDGE_CHANNEL_THRESHOLD)
    : threshold
  // Why: CoreText glyphs can land two physical pixels apart between Chromium
  // and WebKit. Only detected edges receive that radius; flat UI fills stay strict.
  const effectiveSpatialTolerancePx = rasterEdge
    ? Math.max(spatialTolerancePx, RASTER_EDGE_SPATIAL_TOLERANCE_PX)
    : spatialTolerancePx
  if (pixelsMatch(reference.data, offset, candidate.data, offset, effectiveThreshold)) return false
  if (effectiveSpatialTolerancePx === 0) return true
  const pixelIndex = offset / 4
  const x = pixelIndex % reference.width
  const y = Math.floor(pixelIndex / reference.width)
  // Why: Chromium and WebKit rasterize identical glyph edges about one pixel
  // apart. Bidirectional matching still catches added or missing interface pixels.
  return (
    !hasNearbyMatch(
      reference,
      offset,
      candidate,
      x,
      y,
      effectiveThreshold,
      effectiveSpatialTolerancePx
    ) ||
    !hasNearbyMatch(
      candidate,
      offset,
      reference,
      x,
      y,
      effectiveThreshold,
      effectiveSpatialTolerancePx
    )
  )
}

function isRasterEdge(image, offset) {
  const pixelIndex = offset / 4
  const x = pixelIndex % image.width
  const y = Math.floor(pixelIndex / image.width)
  const center = luminanceAt(image.data, offset)
  for (let nearbyY = Math.max(0, y - 1); nearbyY <= Math.min(image.height - 1, y + 1); nearbyY += 1) {
    for (let nearbyX = Math.max(0, x - 1); nearbyX <= Math.min(image.width - 1, x + 1); nearbyX += 1) {
      const nearbyOffset = (nearbyY * image.width + nearbyX) * 4
      if (Math.abs(center - luminanceAt(image.data, nearbyOffset)) >= RASTER_EDGE_CONTRAST) return true
    }
  }
  return false
}

function luminanceAt(data, offset) {
  return data[offset] * 0.2126 + data[offset + 1] * 0.7152 + data[offset + 2] * 0.0722
}

function hasNearbyMatch(source, sourceOffset, target, x, y, threshold, radius) {
  const minX = Math.max(0, x - radius)
  const maxX = Math.min(target.width - 1, x + radius)
  const minY = Math.max(0, y - radius)
  const maxY = Math.min(target.height - 1, y + radius)
  for (let nearbyY = minY; nearbyY <= maxY; nearbyY += 1) {
    for (let nearbyX = minX; nearbyX <= maxX; nearbyX += 1) {
      const targetOffset = (nearbyY * target.width + nearbyX) * 4
      if (pixelsMatch(source.data, sourceOffset, target.data, targetOffset, threshold)) return true
    }
  }
  return false
}

function pixelsMatch(left, leftOffset, right, rightOffset, threshold) {
  return (
    Math.abs(left[leftOffset] - right[rightOffset]) <= threshold &&
    Math.abs(left[leftOffset + 1] - right[rightOffset + 1]) <= threshold &&
    Math.abs(left[leftOffset + 2] - right[rightOffset + 2]) <= threshold &&
    Math.abs(left[leftOffset + 3] - right[rightOffset + 3]) <= threshold
  )
}

function writeDiffPixel(output, candidate, offset, changed) {
  if (changed) {
    output[offset] = 255
    output[offset + 1] = 0
    output[offset + 2] = 72
    output[offset + 3] = 255
    return
  }
  const luminance = Math.round(
    candidate[offset] * 0.2126 + candidate[offset + 1] * 0.7152 + candidate[offset + 2] * 0.0722
  )
  const muted = Math.round(luminance * 0.22 + 196)
  output[offset] = muted
  output[offset + 1] = muted
  output[offset + 2] = muted
  output[offset + 3] = 255
}

function validateUnitInterval(value, name) {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} must be between 0 and 1`)
  }
}

function readCliOptions(argv) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key?.startsWith('--') || value === undefined) {
      throw new Error(`Expected --name value arguments, received ${key ?? '(empty)'}`)
    }
    values.set(key.slice(2), value)
  }
  const referencePath = values.get('reference')
  const candidatePath = values.get('candidate')
  const diffPath = values.get('diff')
  if (!referencePath || !candidatePath || !diffPath) {
    throw new Error(
      'Required: --reference <electron.png> --candidate <tauri.png> --diff <diff.png>'
    )
  }
  return {
    referencePath,
    candidatePath,
    diffPath,
    channelThreshold: values.has('channel-threshold')
      ? Number(values.get('channel-threshold'))
      : DEFAULT_CHANNEL_THRESHOLD,
    maxMismatchRatio: values.has('max-mismatch-ratio')
      ? Number(values.get('max-mismatch-ratio'))
      : DEFAULT_MAX_MISMATCH_RATIO,
    spatialTolerancePx: values.has('spatial-tolerance-px')
      ? Number(values.get('spatial-tolerance-px'))
      : DEFAULT_SPATIAL_TOLERANCE_PX
  }
}

function runCli() {
  const options = readCliOptions(process.argv.slice(2))
  const result = compareDesktopParityScreenshots(
    readFileSync(options.referencePath),
    readFileSync(options.candidatePath),
    options
  )
  writeFileSync(options.diffPath, result.diffBytes)
  const report = { ...result, diffBytes: undefined, diffPath: options.diffPath }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  if (!result.matches) process.exitCode = 1
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runCli()
}
