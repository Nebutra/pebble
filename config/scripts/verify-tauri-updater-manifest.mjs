import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { verifyUpdaterSignatureWithRust } from './verify-tauri-release-artifacts.mjs'

const repoRoot = resolve(import.meta.dirname, '../..')

// Why: tauri-action emits API asset URLs (`api.github.com/repos/o/r/releases/
// assets/<id>`), not browser download URLs, so that private repositories work.
// tauri-plugin-updater sends `Accept: application/octet-stream` when fetching
// the payload, which is what makes those URLs resolve to bytes instead of JSON.
// Both forms are legitimate; this gate previously accepted only the browser one
// and so failed every release, which is how publishing came to bypass it.
export function classifyUpdaterUrl(rawUrl) {
  let url
  try {
    url = new URL(rawUrl)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    return null
  }
  const segments = decodeSegments(url)
  if (!segments) {
    return null
  }
  if (url.host === 'github.com') {
    const [owner, repo, releases, download, tag, assetName, ...extra] = segments
    if (releases !== 'releases' || download !== 'download' || !assetName || extra.length > 0) {
      return null
    }
    return { kind: 'browser', repository: `${owner}/${repo}`, tag, assetName }
  }
  if (url.host === 'api.github.com') {
    const [repos, owner, repo, releases, assets, assetId, ...extra] = segments
    if (
      repos !== 'repos' ||
      releases !== 'releases' ||
      assets !== 'assets' ||
      !/^\d+$/.test(assetId ?? '') ||
      extra.length > 0
    ) {
      return null
    }
    return { kind: 'api', repository: `${owner}/${repo}`, assetId: Number(assetId) }
  }
  return null
}

function decodeSegments(url) {
  try {
    return url.pathname
      .split('/')
      .filter(Boolean)
      .map((segment) => decodeURIComponent(segment))
  } catch {
    return null
  }
}

function sameRepository(a, b) {
  // GitHub owner and repository names are case-insensitive.
  return a.toLowerCase() === b.toLowerCase()
}

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
    if (!classifyUpdaterUrl(url)) {
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
  // Why: signatures authenticate downloaded bytes, but cannot prove that a
  // manifest routes clients to an artifact uploaded for this exact release.
  for (const [platform, entry] of Object.entries(manifest.platforms)) {
    const asset = resolveUpdaterAsset(entry.url, {
      platform,
      repository,
      tag,
      releaseAssets: options.releaseAssets
    })
    const label = asset.name ?? asset.id
    if (asset.state !== 'uploaded') {
      throw new Error(
        `Tauri updater platform ${platform} references release asset ${label} in state ${
          asset.state ?? 'unknown'
        }.`
      )
    }
    if (!Number.isFinite(asset.size) || asset.size <= 0) {
      throw new Error(`Tauri updater platform ${platform} references empty release asset ${label}.`)
    }
  }
  return manifest
}

// Why: resolve against the release's own asset list rather than trusting the
// URL text. A browser URL names the asset; an API URL only carries its numeric
// id, and the id is the stronger claim — it cannot point at another release.
export function resolveUpdaterAsset(rawUrl, { platform, repository, tag, releaseAssets }) {
  const target = classifyUpdaterUrl(rawUrl)
  if (!target) {
    throw new Error(`Tauri updater platform ${platform} has an ambiguous download URL.`)
  }
  if (!sameRepository(target.repository, repository)) {
    throw new Error(
      `Tauri updater platform ${platform} does not target ${repository} release ${tag}.`
    )
  }
  if (target.kind === 'browser') {
    if (target.tag !== tag) {
      throw new Error(
        `Tauri updater platform ${platform} does not target ${repository} release ${tag}.`
      )
    }
    const asset = releaseAssets.find((candidate) => candidate?.name === target.assetName)
    if (!asset) {
      throw new Error(
        `Tauri updater platform ${platform} references missing release asset ${target.assetName}.`
      )
    }
    return asset
  }
  const asset = releaseAssets.find((candidate) => candidate?.id === target.assetId)
  if (!asset) {
    throw new Error(
      `Tauri updater platform ${platform} references release asset ${target.assetId}, which is not part of ${tag}.`
    )
  }
  return asset
}

// Why: `GET /releases/tags/{tag}` cannot see a draft — a draft carries no tag
// association until it is published. Now that the release stays a draft until
// these checks pass, that endpoint 404s on the very release being verified, so
// fall back to the list endpoint, which does include drafts.
export async function findReleaseByTag({ repository, tag, headers, fetchImpl }) {
  const byTag = await fetchImpl(
    `https://api.github.com/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`,
    { headers }
  )
  if (byTag.ok) {
    return byTag.json()
  }
  if (byTag.status !== 404) {
    throw new Error(`Could not read GitHub release ${tag}: status ${byTag.status}.`)
  }
  const listed = await fetchImpl(
    `https://api.github.com/repos/${repository}/releases?per_page=100`,
    { headers }
  )
  if (!listed.ok) {
    throw new Error(`Could not list GitHub releases for ${tag}: status ${listed.status}.`)
  }
  const releases = await listed.json()
  const match = Array.isArray(releases)
    ? releases.find((candidate) => candidate?.tag_name === tag)
    : null
  if (!match) {
    throw new Error(`Could not read GitHub release ${tag}: status 404.`)
  }
  return match
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
  const release = await findReleaseByTag({ repository, tag, headers, fetchImpl })
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
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'pebble-updater-verification-'))
  const verified = []
  try {
    for (const [platform, entry] of Object.entries(manifest.platforms)) {
      // Why: an API URL's last path segment is the asset id, not its filename,
      // so matching on basename silently found nothing for tauri-action output.
      const target = classifyUpdaterUrl(entry.url)
      const asset = releaseAssets.find((candidate) =>
        target?.kind === 'api'
          ? candidate?.id === target.assetId
          : candidate?.name === target?.assetName
      )
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
    const directory = resolve(process.argv[2] || `${repoRoot}/apps/desktop/src-tauri/target`)
    const paths = await verifyGeneratedUpdaterManifests(directory)
    console.log(`Verified ${paths.length} Tauri updater manifest(s).`)
  }
}
