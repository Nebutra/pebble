#!/usr/bin/env node

import { pathToFileURL } from 'node:url'

const API_VERSION = '2022-11-28'
const STABLE_DIRECT_DOWNLOAD_ASSETS = [
  'pebble-linux-aarch64.deb',
  'pebble-linux-x86_64.deb',
  'pebble-macos-universal.dmg',
  'pebble-windows-x86_64-setup.exe',
  'pebble-windows-x86_64.msi'
]

export function getRequiredReleaseAssetNames() {
  return ['latest.json', ...STABLE_DIRECT_DOWNLOAD_ASSETS]
}

export function extractManifestAssetNames(manifestText) {
  const names = new Set()
  for (const line of manifestText.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:-\s*)?(?:url|path):\s*['"]?([^'"]+)['"]?\s*$/)
    if (!match) {
      continue
    }
    const value = match[1].trim()
    try {
      names.add(new URL(value).pathname.split('/').filter(Boolean).at(-1) ?? value)
    } catch {
      names.add(value.split('/').filter(Boolean).at(-1) ?? value)
    }
  }
  return [...names]
}

export function extractTauriManifestAssetNames(manifestText) {
  const manifest = JSON.parse(manifestText)
  const platforms = manifest?.platforms
  if (!platforms || typeof platforms !== 'object' || Array.isArray(platforms)) {
    throw new Error('Tauri latest.json is missing its platforms object')
  }
  return Object.values(platforms).flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || typeof entry.url !== 'string') {
      return []
    }
    return extractManifestAssetNames(`url: ${entry.url}`)
  })
}

async function githubFetch(url, token, accept = 'application/vnd.github+json') {
  const res = await fetch(url, {
    headers: {
      Accept: accept,
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': API_VERSION
    }
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`GitHub request failed ${res.status} ${res.statusText}: ${body.slice(0, 300)}`)
  }
  return res
}

async function fetchRelease(repo, tag, token) {
  // The publish gate runs while the release is still draft.
  const res = await githubFetch(`https://api.github.com/repos/${repo}/releases?per_page=100`, token)
  const releases = await res.json()
  if (!Array.isArray(releases)) {
    throw new Error(`GitHub releases response for ${repo} was not an array`)
  }
  const release = releases.find((candidate) => candidate.tag_name === tag)
  if (!release) {
    throw new Error(`Release ${repo}@${tag} was not found in the draft-aware releases list`)
  }
  return release
}

async function fetchAssetText(repo, asset, token) {
  const res = await githubFetch(
    `https://api.github.com/repos/${repo}/releases/assets/${asset.id}`,
    token,
    'application/octet-stream'
  )
  return res.text()
}

export async function verifyRequiredReleaseAssets({ repo, tag, token }) {
  const release = await fetchRelease(repo, tag, token)
  const assetsByName = new Map(release.assets.map((asset) => [asset.name, asset]))

  const requiredNames = new Set(getRequiredReleaseAssetNames(tag))

  const tauriManifestAsset = assetsByName.get('latest.json')
  if (tauriManifestAsset) {
    const manifestText = await fetchAssetText(repo, tauriManifestAsset, token)
    for (const referencedName of extractTauriManifestAssetNames(manifestText)) {
      requiredNames.add(referencedName)
    }
  }

  const missing = [...requiredNames].filter((name) => !assetsByName.has(name)).sort()
  const notUploaded = [...requiredNames]
    .map((name) => assetsByName.get(name))
    .filter((asset) => asset && asset.state && asset.state !== 'uploaded')
    .map((asset) => `${asset.name}:${asset.state}`)
    .sort()
  const empty = [...requiredNames]
    .map((name) => assetsByName.get(name))
    .filter((asset) => asset && asset.size === 0)
    .map((asset) => asset.name)
    .sort()

  if (missing.length > 0 || notUploaded.length > 0 || empty.length > 0) {
    throw new Error(
      [
        `Release ${tag} is missing required assets.`,
        missing.length > 0 ? `Missing: ${missing.join(', ')}` : null,
        notUploaded.length > 0 ? `Not uploaded: ${notUploaded.join(', ')}` : null,
        empty.length > 0 ? `Empty: ${empty.join(', ')}` : null
      ]
        .filter(Boolean)
        .join('\n')
    )
  }

  return {
    tag,
    checked: [...requiredNames].sort(),
    draft: release.draft,
    prerelease: release.prerelease
  }
}

async function main() {
  const tag = process.argv[2]
  if (!tag) {
    throw new Error('Usage: node config/scripts/verify-release-required-assets.mjs <tag>')
  }
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
  if (!token) {
    throw new Error('GH_TOKEN or GITHUB_TOKEN must be set')
  }
  const repo = process.env.GITHUB_REPOSITORY || 'nebutra/pebble'
  const result = await verifyRequiredReleaseAssets({ repo, tag, token })
  console.log(`Verified ${result.checked.length} required release assets for ${repo}@${tag}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message)
    process.exit(1)
  })
}
