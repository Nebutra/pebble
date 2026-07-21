import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'

import { verifyUpdaterSignatureWithRust } from './verify-tauri-release-artifacts.mjs'

const repoRoot = resolve(import.meta.dirname, '../..')

export function validateUpdaterManifest(manifest, options = {}) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('Tauri updater manifest must be a JSON object.')
  }
  if (
    typeof manifest.version !== 'string' ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)
  ) {
    throw new Error('Tauri updater manifest has an invalid version.')
  }
  const platforms = manifest.platforms
  if (!platforms || typeof platforms !== 'object' || Array.isArray(platforms)) {
    throw new Error('Tauri updater manifest has no platform entries.')
  }
  const entries = Object.entries(platforms)
  if (entries.length === 0) {
    throw new Error('Tauri updater manifest has no platform entries.')
  }
  for (const [platform, value] of entries) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`Tauri updater platform ${platform} is malformed.`)
    }
    const url = typeof value.url === 'string' ? value.url : ''
    const signature = typeof value.signature === 'string' ? value.signature.trim() : ''
    if (!url.startsWith('https://github.com/nebutra/pebble/releases/download/')) {
      throw new Error(`Tauri updater platform ${platform} has an unexpected download URL.`)
    }
    if (!signature) {
      throw new Error(`Tauri updater platform ${platform} has no signature.`)
    }
  }
  const expectedVersion = options.expectedVersion?.trim().replace(/^v/i, '')
  if (expectedVersion && manifest.version !== expectedVersion) {
    throw new Error(
      `Tauri updater manifest version ${manifest.version} does not match ${expectedVersion}.`
    )
  }
  for (const platform of options.requiredPlatforms ?? []) {
    if (!Object.hasOwn(platforms, platform)) {
      throw new Error(`Tauri updater manifest is missing required platform ${platform}.`)
    }
  }
  return manifest
}

export function validatePublishedUpdaterManifest(manifest, options = {}) {
  const repository = options.repository?.trim() ?? ''
  if (!/^[^/]+\/[^/]+$/.test(repository)) {
    throw new Error('GITHUB_REPOSITORY must use owner/repository format.')
  }
  const tag = options.tag?.trim() ?? ''
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag)) {
    throw new Error('TAURI_RELEASE_TAG must be a canonical v-prefixed semver tag.')
  }
  if (!Array.isArray(options.releaseAssets)) {
    throw new Error('GitHub release assets are required to verify updater targets.')
  }

  validateUpdaterManifest(manifest, {
    expectedVersion: tag,
    requiredPlatforms: options.requiredPlatforms
  })
  const assetsByName = new Map(
    options.releaseAssets
      .filter((asset) => asset && typeof asset.name === 'string')
      .map((asset) => [asset.name, asset])
  )
  // Why: signatures authenticate downloaded bytes, but cannot prove that a
  // manifest routes clients to an artifact uploaded for this exact release.
  for (const [platform, entry] of Object.entries(manifest.platforms)) {
    const assetName = updaterAssetName(entry.url, { platform, repository, tag })
    const asset = assetsByName.get(assetName)
    if (!asset) {
      throw new Error(
        `Tauri updater platform ${platform} references missing release asset ${assetName}.`
      )
    }
    if (asset.state !== 'uploaded') {
      throw new Error(
        `Tauri updater platform ${platform} references release asset ${assetName} in state ${
          asset.state ?? 'unknown'
        }.`
      )
    }
    if (!Number.isFinite(asset.size) || asset.size <= 0) {
      throw new Error(
        `Tauri updater platform ${platform} references empty release asset ${assetName}.`
      )
    }
  }
  return manifest
}

function updaterAssetName(rawUrl, { platform, repository, tag }) {
  let url
  try {
    url = new URL(rawUrl)
  } catch {
    throw new Error(`Tauri updater platform ${platform} has an invalid download URL.`)
  }
  if (
    url.protocol !== 'https:' ||
    url.host !== 'github.com' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(`Tauri updater platform ${platform} has an ambiguous download URL.`)
  }

  let segments
  try {
    segments = url.pathname
      .split('/')
      .filter(Boolean)
      .map((segment) => decodeURIComponent(segment))
  } catch {
    throw new Error(`Tauri updater platform ${platform} has an invalid download URL.`)
  }
  const [owner, repo, releases, download, urlTag, assetName, ...extra] = segments
  if (
    `${owner}/${repo}` !== repository ||
    releases !== 'releases' ||
    download !== 'download' ||
    urlTag !== tag ||
    !assetName ||
    extra.length > 0
  ) {
    throw new Error(
      `Tauri updater platform ${platform} does not target ${repository} release ${tag}.`
    )
  }
  return assetName
}

export async function fetchReleaseUpdaterData({ repository, tag, token, fetchImpl = fetch }) {
  if (!/^[^/]+\/[^/]+$/.test(repository)) {
    throw new Error('GITHUB_REPOSITORY must use owner/repository format.')
  }
  if (!tag?.trim()) {
    throw new Error('TAURI_RELEASE_TAG is required to verify a published updater manifest.')
  }
  if (!token?.trim()) {
    throw new Error('GITHUB_TOKEN is required to verify a draft release updater manifest.')
  }
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28'
  }
  const releaseUrl = `https://api.github.com/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`
  const releaseResponse = await fetchImpl(releaseUrl, { headers })
  if (!releaseResponse.ok) {
    throw new Error(`Could not read GitHub release ${tag}: status ${releaseResponse.status}.`)
  }
  const release = await releaseResponse.json()
  const asset = Array.isArray(release.assets)
    ? release.assets.find((candidate) => candidate?.name === 'latest.json')
    : null
  if (!asset?.url) {
    throw new Error(`GitHub release ${tag} has no latest.json asset.`)
  }
  const assetResponse = await fetchImpl(asset.url, {
    headers: { ...headers, Accept: 'application/octet-stream' }
  })
  if (!assetResponse.ok) {
    throw new Error(`Could not download updater manifest: status ${assetResponse.status}.`)
  }
  return {
    manifest: await assetResponse.json(),
    releaseAssets: release.assets,
    requestHeaders: headers
  }
}

export async function verifyPublishedUpdaterPayloadSignatures({
  fetchImpl = fetch,
  manifest,
  publicKey,
  releaseAssets,
  requestHeaders,
  signatureVerifier = verifyUpdaterSignatureWithRust
}) {
  if (typeof publicKey !== 'string' || publicKey.trim() === '') {
    throw new Error('TAURI_UPDATER_PUBLIC_KEY is required to verify published updater payloads.')
  }
  const assetsByName = new Map(releaseAssets.map((asset) => [asset.name, asset]))
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'pebble-updater-verification-'))
  const verified = []
  try {
    for (const [platform, entry] of Object.entries(manifest.platforms)) {
      const assetName = decodeURIComponent(basename(new URL(entry.url).pathname))
      const asset = assetsByName.get(assetName)
      if (!asset?.url) {
        throw new Error(`Tauri updater platform ${platform} has no downloadable release asset.`)
      }
      const response = await fetchImpl(asset.url, {
        headers: { ...requestHeaders, Accept: 'application/octet-stream' }
      })
      if (!response.ok) {
        throw new Error(
          `Could not download updater payload for ${platform}: status ${response.status}.`
        )
      }
      const payloadPath = join(temporaryDirectory, `${verified.length}-payload`)
      const signaturePath = `${payloadPath}.sig`
      await writeFile(payloadPath, Buffer.from(await response.arrayBuffer()))
      await writeFile(signaturePath, entry.signature, 'utf8')
      signatureVerifier({ payloadPath, publicKey, signaturePath })
      verified.push(platform)
    }
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true })
  }
  return verified
}

export async function fetchReleaseUpdaterManifest(options) {
  return (await fetchReleaseUpdaterData(options)).manifest
}

async function findFiles(directory, name) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) {
        return findFiles(path, name)
      }
      return entry.isFile() && entry.name === name ? [path] : []
    })
  )
  return nested.flat()
}

export async function verifyGeneratedUpdaterManifests(directory) {
  const paths = await findFiles(directory, 'latest.json')
  if (paths.length === 0) {
    throw new Error(`No generated latest.json found under ${directory}.`)
  }
  for (const path of paths) {
    validateUpdaterManifest(JSON.parse(await readFile(path, 'utf8')))
  }
  return paths
}

if (process.argv[1] === import.meta.filename) {
  const releaseTag = process.env.TAURI_RELEASE_TAG?.trim()
  if (releaseTag) {
    const requiredPlatforms = (process.env.TAURI_REQUIRED_UPDATER_PLATFORMS ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
    const { manifest, releaseAssets, requestHeaders } = await fetchReleaseUpdaterData({
      repository: process.env.GITHUB_REPOSITORY ?? '',
      tag: releaseTag,
      token: process.env.GITHUB_TOKEN ?? ''
    })
    validatePublishedUpdaterManifest(manifest, {
      repository: process.env.GITHUB_REPOSITORY ?? '',
      tag: releaseTag,
      releaseAssets,
      requiredPlatforms
    })
    const verifiedPlatforms = await verifyPublishedUpdaterPayloadSignatures({
      manifest,
      publicKey: process.env.TAURI_UPDATER_PUBLIC_KEY ?? '',
      releaseAssets,
      requestHeaders
    })
    console.log(
      `Verified published Tauri updater manifest and ${verifiedPlatforms.length} payload signature(s) for ${releaseTag}.`
    )
  } else {
    const directory = resolve(
      process.argv[2] || `${repoRoot}/apps/desktop/src-tauri/target`
    )
    const paths = await verifyGeneratedUpdaterManifests(directory)
    console.log(`Verified ${paths.length} Tauri updater manifest(s).`)
  }
}
