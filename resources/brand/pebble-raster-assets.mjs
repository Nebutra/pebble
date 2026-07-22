#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { PNG } from 'pngjs'
import {
  buildWindowsIcoFromPng,
  encodePng,
  resizeImage
} from '../../config/scripts/trim-windows-icon-source.mjs'

const __dirname = import.meta.dirname
const ROOT = resolve(__dirname, '..', '..')
const GENERATED = join(ROOT, 'resources', 'brand', 'generated')
const PROCESSED = join(ROOT, 'resources', 'brand', 'processed')
const BUILD = join(ROOT, 'resources', 'build')
const APP_ICONS = join(ROOT, 'resources', 'app-icons')
const MOBILE = join(ROOT, 'mobile', 'assets')

const CLASSIC_TEXTURE_SOURCE = join(GENERATED, 'pebble-icon', 'selected-icon.png')
const SOFT_SOURCE = join(GENERATED, 'pebble-icon', '02-icon-soft.png')
const MINERAL_SOURCE = join(GENERATED, 'pebble-icon', '03-icon-mineral.png')
const GLYPH_SOURCE = join(GENERATED, 'pebble-icon', 'selected-glyph-chromakey.png')

const PEBBLE_MIST = { r: 244, g: 240, b: 234, a: 255 }
const MOBILE_SPLASH_BG = { r: 244, g: 240, b: 234, a: 255 }
const TRANSPARENT_BACKGROUND = { r: 0, g: 0, b: 0, a: 0 }

function readPng(path) {
  const png = PNG.sync.read(readFileSync(path))
  return { width: png.width, height: png.height, data: png.data }
}

function encodeRgbPng(image) {
  const png = new PNG({ width: image.width, height: image.height })
  image.data.copy(png.data)
  return PNG.sync.write(png, {
    colorType: 2,
    inputColorType: 6,
    bgColor: {
      red: PEBBLE_MIST.r,
      green: PEBBLE_MIST.g,
      blue: PEBBLE_MIST.b
    }
  })
}

function writePng(path, image, { rgb = false } = {}) {
  writeFileSync(path, rgb ? encodeRgbPng(image) : encodePng(image))
}

function assertInput(path) {
  if (!existsSync(path)) {
    throw new Error(`Missing source image: ${path}`)
  }
}

function isChromaGreen(data, index) {
  return data[index + 1] > 150 && data[index] < 120 && data[index + 2] < 120
}

function buildGlyphMasks(glyph) {
  const { width, height, data } = glyph
  const green = new Uint8Array(width * height)
  const visited = new Uint8Array(width * height)
  const queue = []

  for (let offset = 0; offset < green.length; offset++) {
    green[offset] = isChromaGreen(data, offset * 4) ? 1 : 0
  }

  function enqueue(x, y) {
    if (x < 0 || y < 0 || x >= width || y >= height) {
      return
    }
    const offset = y * width + x
    if (visited[offset]) {
      return
    }
    if (!green[offset]) {
      return
    }
    visited[offset] = 1
    queue.push([x, y])
  }

  for (let x = 0; x < width; x++) {
    enqueue(x, 0)
    enqueue(x, height - 1)
  }
  for (let y = 0; y < height; y++) {
    enqueue(0, y)
    enqueue(width - 1, y)
  }

  for (let head = 0; head < queue.length; head++) {
    const [x, y] = queue[head]
    enqueue(x + 1, y)
    enqueue(x - 1, y)
    enqueue(x, y + 1)
    enqueue(x, y - 1)
  }

  const stone = new Uint8Array(width * height)
  const prompt = new Uint8Array(width * height)
  for (let offset = 0; offset < green.length; offset++) {
    if (visited[offset]) {
      continue
    }
    if (green[offset]) {
      prompt[offset] = 1
    } else {
      stone[offset] = 1
    }
  }
  return { width, height, stone, prompt }
}

function createCanvas(width, height, fill) {
  const data = Buffer.alloc(width * height * 4)
  for (let index = 0; index < data.length; index += 4) {
    data[index] = fill.r
    data[index + 1] = fill.g
    data[index + 2] = fill.b
    data[index + 3] = fill.a
  }
  return { width, height, data }
}

function alphaComposite(dst, src, left, top) {
  for (let y = 0; y < src.height; y++) {
    const dy = y + top
    if (dy < 0 || dy >= dst.height) {
      continue
    }
    for (let x = 0; x < src.width; x++) {
      const dx = x + left
      if (dx < 0 || dx >= dst.width) {
        continue
      }
      const srcIndex = (y * src.width + x) * 4
      const dstIndex = (dy * dst.width + dx) * 4
      const alpha = src.data[srcIndex + 3] / 255
      const inv = 1 - alpha
      dst.data[dstIndex] = Math.round(src.data[srcIndex] * alpha + dst.data[dstIndex] * inv)
      dst.data[dstIndex + 1] = Math.round(src.data[srcIndex + 1] * alpha + dst.data[dstIndex + 1] * inv)
      dst.data[dstIndex + 2] = Math.round(src.data[srcIndex + 2] * alpha + dst.data[dstIndex + 2] * inv)
      dst.data[dstIndex + 3] = Math.round((alpha + (dst.data[dstIndex + 3] / 255) * inv) * 255)
    }
  }
}

function cropTransparentSquare(image, paddingRatio = 0.04) {
  let minX = image.width
  let minY = image.height
  let maxX = -1
  let maxY = -1

  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const index = (y * image.width + x) * 4
      if (image.data[index + 3] === 0) {
        continue
      }
      minX = Math.min(minX, x)
      minY = Math.min(minY, y)
      maxX = Math.max(maxX, x)
      maxY = Math.max(maxY, y)
    }
  }

  if (maxX < minX || maxY < minY) {
    return image
  }

  const contentWidth = maxX - minX + 1
  const contentHeight = maxY - minY + 1
  const paddedSide = Math.ceil(Math.max(contentWidth, contentHeight) * (1 + paddingRatio * 2))
  const centerX = Math.round((minX + maxX) / 2)
  const centerY = Math.round((minY + maxY) / 2)
  const sourceLeft = Math.max(0, Math.round(centerX - paddedSide / 2))
  const sourceTop = Math.max(0, Math.round(centerY - paddedSide / 2))
  const sourceRight = Math.min(image.width, sourceLeft + paddedSide)
  const sourceBottom = Math.min(image.height, sourceTop + paddedSide)
  const cropWidth = sourceRight - sourceLeft
  const cropHeight = sourceBottom - sourceTop
  const data = Buffer.alloc(cropWidth * cropHeight * 4)

  for (let y = 0; y < cropHeight; y++) {
    for (let x = 0; x < cropWidth; x++) {
      const srcIndex = ((sourceTop + y) * image.width + sourceLeft + x) * 4
      const dstIndex = (y * cropWidth + x) * 4
      data[dstIndex] = image.data[srcIndex]
      data[dstIndex + 1] = image.data[srcIndex + 1]
      data[dstIndex + 2] = image.data[srcIndex + 2]
      data[dstIndex + 3] = image.data[srcIndex + 3]
    }
  }

  return { width: cropWidth, height: cropHeight, data }
}

function createMaskedPebbleObject(texture, glyph) {
  const masks = buildGlyphMasks(glyph)
  const textureSource =
    texture.width === masks.width && texture.height === masks.height
      ? texture
      : resizeImage(texture, masks.width, masks.height)
  const data = Buffer.alloc(masks.width * masks.height * 4)

  // The generated icon contains an inner app tile; the glyph mask keeps only the
  // approved pebble silhouette and terminal mark for platform icon exports.
  for (let offset = 0; offset < masks.stone.length; offset++) {
    const index = offset * 4
    if (masks.stone[offset]) {
      data[index] = textureSource.data[index]
      data[index + 1] = textureSource.data[index + 1]
      data[index + 2] = textureSource.data[index + 2]
      data[index + 3] = 255
      continue
    }
    if (masks.prompt[offset]) {
      data[index] = 255
      data[index + 1] = 253
      data[index + 2] = 248
      data[index + 3] = 255
    }
  }

  return { width: masks.width, height: masks.height, data }
}

function fitPebbleObjectOnCanvas(texture, glyph, canvasSize, fitRatio, background = PEBBLE_MIST) {
  const maskedPebble = cropTransparentSquare(createMaskedPebbleObject(texture, glyph))
  const targetSide = Math.round(canvasSize * fitRatio)
  const resized = resizeImage(maskedPebble, targetSide, targetSide)
  const canvas = createCanvas(canvasSize, canvasSize, background)
  const offset = Math.round((canvasSize - targetSide) / 2)
  alphaComposite(canvas, resized, offset, offset)
  return canvas
}

function makeSplash(texture, glyph) {
  const canvas = createCanvas(400, 255, MOBILE_SPLASH_BG)
  const resized = resizeImage(cropTransparentSquare(createMaskedPebbleObject(texture, glyph)), 154, 154)
  alphaComposite(canvas, resized, Math.round((400 - 154) / 2), Math.round((255 - 154) / 2))
  return canvas
}

function icnsChunk(type, png) {
  const header = Buffer.alloc(8)
  header.write(type, 0, 4, 'ascii')
  header.writeUInt32BE(png.length + 8, 4)
  return Buffer.concat([header, png])
}

function writeIcns(source1024) {
  const pngBySize = new Map(
    [16, 32, 64, 128, 256, 512, 1024].map((size) => [
      size,
      encodePng(resizeImage(source1024, size, size))
    ])
  )
  const chunks = [
    icnsChunk('ic04', pngBySize.get(16)),
    icnsChunk('ic05', pngBySize.get(32)),
    icnsChunk('ic11', pngBySize.get(32)),
    icnsChunk('ic12', pngBySize.get(64)),
    icnsChunk('ic07', pngBySize.get(128)),
    icnsChunk('ic08', pngBySize.get(256)),
    icnsChunk('ic13', pngBySize.get(256)),
    icnsChunk('ic09', pngBySize.get(512)),
    icnsChunk('ic14', pngBySize.get(512)),
    icnsChunk('ic10', pngBySize.get(1024))
  ]
  const body = Buffer.concat(chunks)
  const header = Buffer.alloc(8)
  header.write('icns', 0, 4, 'ascii')
  header.writeUInt32BE(body.length + 8, 4)
  writeFileSync(join(BUILD, 'icon.icns'), Buffer.concat([header, body]))
}

function main() {
  for (const path of [CLASSIC_TEXTURE_SOURCE, SOFT_SOURCE, MINERAL_SOURCE, GLYPH_SOURCE]) {
    assertInput(path)
  }
  mkdirSync(PROCESSED, { recursive: true })
  mkdirSync(BUILD, { recursive: true })
  mkdirSync(APP_ICONS, { recursive: true })
  mkdirSync(MOBILE, { recursive: true })

  const glyph = readPng(GLYPH_SOURCE)
  // Why: this source is texture-only and may include a generated app tile; the
  // chromakey glyph mask below is the contract for publishable freeform icons.
  const classic = readPng(CLASSIC_TEXTURE_SOURCE)
  const classic1024 = fitPebbleObjectOnCanvas(classic, glyph, 1024, 0.82, TRANSPARENT_BACKGROUND)
  const soft1024 = fitPebbleObjectOnCanvas(
    readPng(SOFT_SOURCE),
    glyph,
    1024,
    0.82,
    TRANSPARENT_BACKGROUND
  )
  const mineral1024 = fitPebbleObjectOnCanvas(
    readPng(MINERAL_SOURCE),
    glyph,
    1024,
    0.82,
    TRANSPARENT_BACKGROUND
  )
  const mobileOpaque1024 = fitPebbleObjectOnCanvas(classic, glyph, 1024, 0.82, PEBBLE_MIST)

  writePng(join(PROCESSED, 'pebble-icon-classic-1024.png'), classic1024)
  writePng(join(PROCESSED, 'pebble-icon-soft-1024.png'), soft1024)
  writePng(join(PROCESSED, 'pebble-icon-mineral-1024.png'), mineral1024)

  writePng(join(BUILD, 'icon.png'), classic1024)
  writePng(join(ROOT, 'resources', 'icon.png'), resizeImage(classic1024, 256, 256))
  writePng(join(ROOT, 'resources', 'icon-dev.png'), resizeImage(classic1024, 256, 256))
  writePng(join(APP_ICONS, 'pebble-watercolor.png'), soft1024)
  writePng(join(APP_ICONS, 'pebble-blue.png'), mineral1024)

  writePng(join(MOBILE, 'icon.png'), mobileOpaque1024, { rgb: true })
  writePng(join(MOBILE, 'adaptive-icon.png'), classic1024)
  writePng(join(MOBILE, 'favicon.png'), resizeImage(classic1024, 48, 48))
  writePng(join(MOBILE, 'splash-icon.png'), makeSplash(classic, glyph), { rgb: true })

  writeIcns(classic1024)
  writeFileSync(join(BUILD, 'icon.ico'), buildWindowsIcoFromPng(encodePng(classic1024)))

  console.log('Pebble raster brand assets generated.')
}

main()
