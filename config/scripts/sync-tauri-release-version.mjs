#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const semverPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

function replaceJsonVersion(text, version, label) {
  const value = JSON.parse(text)
  if (typeof value.version !== 'string' || !semverPattern.test(value.version)) {
    throw new Error(`${label} must contain a semver version.`)
  }
  value.version = version
  return `${JSON.stringify(value, null, 2)}\n`
}

function replacePackageVersion(text, packageName, version, label) {
  const packagePattern = new RegExp(
    `(\\[\\[?package\\]?\\][\\s\\S]*?\\nname = "${packageName}"\\nversion = ")([^"\\n]+)(")`
  )
  const matches = [...text.matchAll(new RegExp(packagePattern.source, 'g'))]
  if (matches.length !== 1 || !semverPattern.test(matches[0][2])) {
    throw new Error(`${label} must contain exactly one semver ${packageName} package version.`)
  }
  return text.replace(packagePattern, `$1${version}$3`)
}

export function syncTauriReleaseVersionSources(sources, requestedVersion) {
  const version = requestedVersion?.trim().replace(/^v/i, '') ?? ''
  if (!semverPattern.test(version)) {
    throw new Error('Release version must be a valid semver version.')
  }

  return {
    desktopPackage: replaceJsonVersion(sources.desktopPackage, version, 'Desktop package.json'),
    tauriConfig: replaceJsonVersion(sources.tauriConfig, version, 'Tauri config'),
    cargoManifest: replacePackageVersion(
      sources.cargoManifest,
      'pebble-desktop-tauri',
      version,
      'Cargo.toml'
    ),
    cargoLock: replacePackageVersion(
      sources.cargoLock,
      'pebble-desktop-tauri',
      version,
      'Cargo.lock'
    )
  }
}

export async function syncTauriReleaseVersion(version, root = repoRoot) {
  const paths = {
    desktopPackage: resolve(root, 'apps/desktop/package.json'),
    tauriConfig: resolve(root, 'apps/desktop/src-tauri/tauri.conf.json'),
    cargoManifest: resolve(root, 'apps/desktop/src-tauri/Cargo.toml'),
    cargoLock: resolve(root, 'apps/desktop/src-tauri/Cargo.lock')
  }
  const sources = Object.fromEntries(
    await Promise.all(
      Object.entries(paths).map(async ([name, path]) => [name, await readFile(path, 'utf8')])
    )
  )
  const next = syncTauriReleaseVersionSources(sources, version)

  // Why: the release tag must carry one version across every source checked by
  // the reusable Tauri build before its ephemeral signing config is prepared.
  await Promise.all(
    Object.entries(paths).map(([name, path]) => writeFile(path, next[name], 'utf8'))
  )
  return next
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const version = process.argv[2]
  if (!version) {
    throw new Error('Usage: node config/scripts/sync-tauri-release-version.mjs <version>')
  }
  await syncTauriReleaseVersion(version)
  console.log(`Synchronized Pebble Tauri release version ${version.replace(/^v/i, '')}.`)
}
