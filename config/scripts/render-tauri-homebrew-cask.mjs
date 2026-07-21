#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const SHA256_PATTERN = /^[0-9a-f]{64}$/

export function renderUniversalMacCask(source, { version, sha256 }) {
  if (typeof version !== 'string' || !version.trim()) {
    throw new Error('A non-empty cask version is required')
  }
  if (!SHA256_PATTERN.test(sha256)) {
    throw new Error('The universal DMG sha256 must contain 64 lowercase hexadecimal characters')
  }

  let rendered = source.replace(/version "[^"]+"/, `version "${version.trim()}"`)
  rendered = rendered.replace(/^\s*arch arm:.*\n\n/m, '')
  rendered = rendered.replace(
    /sha256 arm:\s*"[0-9a-f]+",\s*\n\s*intel:\s*"[0-9a-f]+"/,
    `sha256 "${sha256}"`
  )
  rendered = rendered.replace(
    /pebble-macos-(?:#\{arch\}|universal)\.dmg/,
    'pebble-macos-universal.dmg'
  )

  if (!rendered.includes(`version "${version.trim()}"`)) {
    throw new Error('Could not update the cask version')
  }
  if (!rendered.includes(`sha256 "${sha256}"`)) {
    throw new Error('Could not migrate the cask sha256 to the universal DMG')
  }
  if (!rendered.includes('pebble-macos-universal.dmg') || rendered.includes('#{arch}')) {
    throw new Error('Could not migrate the cask URL to the universal DMG')
  }
  return rendered
}

async function main() {
  const path = process.argv[2]
  if (!path) {
    throw new Error('Usage: node config/scripts/render-tauri-homebrew-cask.mjs <cask-path>')
  }
  const rendered = renderUniversalMacCask(await readFile(path, 'utf8'), {
    version: process.env.VERSION,
    sha256: process.env.UNIVERSAL_SHA
  })
  await writeFile(path, rendered)
  process.stdout.write(rendered)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message)
    process.exit(1)
  })
}
