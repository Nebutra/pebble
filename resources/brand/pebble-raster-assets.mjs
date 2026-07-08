#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PNG } from 'pngjs'
import {
  buildWindowsIcoFromPng,
  encodePng,
  resizeImage
} from '../../config/scripts/trim-windows-icon-source.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..', '..')
const GENERATED = join(ROOT, 'resources', 'brand', 'generated')
const PROCESSED = join(ROOT, 'resources', 'brand', 'processed')
const BUILD = join(ROOT, 'resources', 'build')
const APP_ICONS = join(ROOT, 'resources', 'app-icons')
const MOBILE = join(ROOT, 'mobile', 'assets')

const CLASSIC_SOURCE = join(GENERATED, 'pebble-icon', 'selected-icon.png')
const SOFT_SOURCE = join(GENERATED, 'pebble-icon', '02-icon-soft.png')
const MINERAL_SOURCE = join(GENERATED, 'pebble-icon', '03-icon-mineral.png')

const PEBBLE_MIST = { r: 244, g: 240, b: 234, a: 255 }
const MOBILE_SPLASH_BG = { r: 244, g: 240, b: 234, a: 255 }

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

function pixelMax(data, index) {
  return Math.max(data[index], data[index + 1], data[index + 2])
}

function removeDarkCornerBackground(image, threshold = 56) {
  const { width, height, data } = image
  const visited = new Uint8Array(width * height)
  const queue = []

  function enqueue(x, y) {
    if (x < 0 || y < 0 || x >= width || y >= height) {
      return
    }
    const offset = y * width + x
    if (visited[offset]) {
      return
    }
    const index = offset * 4
    if (pixelMax(data, index) > threshold) {
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

  const out = Buffer.from(data)
  for (let offset = 0; offset < visited.length; offset++) {
    if (!visited[offset]) {
      continue
    }
    const index = offset * 4
    out[index] = 0
    out[index + 1] = 0
    out[index + 2] = 0
    out[index + 3] = 0
  }
  return { width, height, data: out }
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

function fitSourceOnCanvas(source, canvasSize, fitRatio, background = PEBBLE_MIST) {
  const sourceWithAlpha = removeDarkCornerBackground(source)
  const targetSide = Math.round(canvasSize * fitRatio)
  const resized = resizeImage(sourceWithAlpha, targetSide, targetSide)
  const canvas = createCanvas(canvasSize, canvasSize, background)
  const offset = Math.round((canvasSize - targetSide) / 2)
  alphaComposite(canvas, resized, offset, offset)
  return canvas
}

function makeSplash(source) {
  const canvas = createCanvas(400, 255, MOBILE_SPLASH_BG)
  const sourceWithAlpha = removeDarkCornerBackground(source)
  const resized = resizeImage(sourceWithAlpha, 154, 154)
  alphaComposite(canvas, resized, Math.round((400 - 154) / 2), Math.round((255 - 154) / 2))
  return canvas
}

function writeIconSet(source1024) {
  const iconsetDir = join(tmpdir(), `pebble-icon-${process.pid}.iconset`)
  rmSync(iconsetDir, { recursive: true, force: true })
  mkdirSync(iconsetDir, { recursive: true })
  const entries = [
    ['icon_16x16.png', 16],
    ['icon_16x16@2x.png', 32],
    ['icon_32x32.png', 32],
    ['icon_32x32@2x.png', 64],
    ['icon_128x128.png', 128],
    ['icon_128x128@2x.png', 256],
    ['icon_256x256.png', 256],
    ['icon_256x256@2x.png', 512],
    ['icon_512x512.png', 512],
    ['icon_512x512@2x.png', 1024]
  ]
  for (const [name, size] of entries) {
    writePng(join(iconsetDir, name), resizeImage(source1024, size, size), { rgb: true })
  }
  execFileSync('iconutil', ['-c', 'icns', iconsetDir, '-o', join(BUILD, 'icon.icns')])
  rmSync(iconsetDir, { recursive: true, force: true })
}

function main() {
  for (const path of [CLASSIC_SOURCE, SOFT_SOURCE, MINERAL_SOURCE]) {
    assertInput(path)
  }
  mkdirSync(PROCESSED, { recursive: true })
  mkdirSync(BUILD, { recursive: true })
  mkdirSync(APP_ICONS, { recursive: true })
  mkdirSync(MOBILE, { recursive: true })

  const classic1024 = fitSourceOnCanvas(readPng(CLASSIC_SOURCE), 1024, 0.88)
  const soft1024 = fitSourceOnCanvas(readPng(SOFT_SOURCE), 1024, 0.88)
  const mineral1024 = fitSourceOnCanvas(readPng(MINERAL_SOURCE), 1024, 0.88)

  writePng(join(PROCESSED, 'pebble-icon-classic-1024.png'), classic1024, { rgb: true })
  writePng(join(PROCESSED, 'pebble-icon-soft-1024.png'), soft1024, { rgb: true })
  writePng(join(PROCESSED, 'pebble-icon-mineral-1024.png'), mineral1024, { rgb: true })

  writePng(join(BUILD, 'icon.png'), classic1024, { rgb: true })
  writePng(join(ROOT, 'resources', 'icon.png'), resizeImage(classic1024, 256, 256), { rgb: true })
  writePng(join(ROOT, 'resources', 'icon-dev.png'), resizeImage(classic1024, 256, 256), { rgb: true })
  writePng(join(APP_ICONS, 'pebble-watercolor.png'), soft1024, { rgb: true })
  writePng(join(APP_ICONS, 'pebble-blue.png'), mineral1024, { rgb: true })

  writePng(join(MOBILE, 'icon.png'), classic1024, { rgb: true })
  writePng(join(MOBILE, 'adaptive-icon.png'), classic1024, { rgb: true })
  writePng(join(MOBILE, 'favicon.png'), resizeImage(classic1024, 48, 48), { rgb: true })
  writePng(join(MOBILE, 'splash-icon.png'), makeSplash(readPng(CLASSIC_SOURCE)), { rgb: true })

  writeIconSet(classic1024)
  writeFileSync(join(BUILD, 'icon.ico'), buildWindowsIcoFromPng(encodeRgbPng(classic1024)))

  console.log('Pebble raster brand assets generated.')
}

main()
