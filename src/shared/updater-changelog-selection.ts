import type { ChangelogData } from './types'

export type ChangelogEntry = {
  version: string
  title: string
  description: string
  mediaUrl?: string
  releaseNotesUrl: string
}

const CHANGELOG_URL = 'https://github.com/nebutra/pebble/releases'
const PEBBLE_RELEASE_TAG_URL_PREFIX = 'https://github.com/nebutra/pebble/releases/tag/'
const PRODUCT_CHANGELOG_HOSTS = new Set(['nebutra.com', 'www.nebutra.com'])

export function selectChangelogData(
  json: unknown,
  incomingVersion: string,
  localVersion: string
): ChangelogData | null {
  if (!Array.isArray(json)) {
    return null
  }
  const entries = json as ChangelogEntry[]
  const localIndex = entries.findIndex((entry) => entry.version === localVersion)
  const incomingIndex = entries.findIndex((entry) => entry.version === incomingVersion)

  if (incomingIndex !== -1) {
    const entry = entries[incomingIndex]
    if (isValidEntry(entry) && hasRichContent(entry)) {
      const releasesBehind =
        localIndex === -1
          ? null
          : localIndex - incomingIndex > 0
            ? localIndex - incomingIndex
            : null
      return { release: releaseFromEntry(entry), releasesBehind }
    }
  }

  for (let index = 0; index < entries.length; index += 1) {
    const candidate = entries[index]
    if (!isValidEntry(candidate) || !hasRichContent(candidate)) {
      continue
    }
    if (localIndex !== -1) {
      if (localIndex < index) {
        continue
      }
    } else if (compareVersions(localVersion, candidate.version) >= 0) {
      continue
    }

    const effectiveIncomingIndex = incomingIndex !== -1 ? incomingIndex : 0
    const releasesBehind =
      localIndex === -1
        ? null
        : localIndex - effectiveIncomingIndex > 0
          ? localIndex - effectiveIncomingIndex
          : null
    const release = releaseFromEntry(candidate)
    return { release: { ...release, releaseNotesUrl: CHANGELOG_URL }, releasesBehind }
  }

  return null
}

function releaseTagFromVersion(version: string): string {
  return version.startsWith('v') ? version : `v${version}`
}

function isValidEntry(entry: ChangelogEntry): boolean {
  return (
    typeof entry.title === 'string' &&
    typeof entry.description === 'string' &&
    typeof entry.releaseNotesUrl === 'string'
  )
}

function hasRichContent(entry: ChangelogEntry): boolean {
  return Boolean(entry.mediaUrl)
}

function canonicalReleaseNotesUrl(releaseNotesUrl: string): string {
  try {
    const url = new URL(releaseNotesUrl)
    const host = url.hostname.toLowerCase()
    const parts = url.pathname.split('/').filter(Boolean)

    if (
      PRODUCT_CHANGELOG_HOSTS.has(host) &&
      parts[0] === 'pebble' &&
      parts[1] === 'changelog'
    ) {
      const version = parts[2]
      return version
        ? `${PEBBLE_RELEASE_TAG_URL_PREFIX}${releaseTagFromVersion(version)}`
        : CHANGELOG_URL
    }

    if (host !== 'github.com') {
      return releaseNotesUrl
    }

    const releasesIndex = parts.findIndex(
      (part, index) => part === 'releases' && parts[index + 1] === 'tag'
    )
    const tag = releasesIndex === -1 ? '' : parts.slice(releasesIndex + 2).join('/')
    return tag ? `${PEBBLE_RELEASE_TAG_URL_PREFIX}${tag}` : releaseNotesUrl
  } catch {
    return releaseNotesUrl
  }
}

function releaseFromEntry(entry: ChangelogEntry): ChangelogData['release'] {
  return {
    title: entry.title,
    description: entry.description,
    mediaUrl: entry.mediaUrl,
    releaseNotesUrl: canonicalReleaseNotesUrl(entry.releaseNotesUrl)
  }
}

type ParsedVersion = {
  core: [number, number, number]
  prerelease: string[]
}

function parseVersion(value: string): ParsedVersion | null {
  const normalized = value.trim().replace(/^v/i, '')
  const match = normalized.match(
    /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-.]+))?(?:\+([0-9A-Za-z-.]+))?$/
  )
  if (!match) {
    return null
  }

  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4]?.split('.') ?? []
  }
}

function compareVersions(left: string, right: string): number {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (!a || !b) {
    return 0
  }
  for (let index = 0; index < 3; index += 1) {
    const diff = a.core[index] - b.core[index]
    if (diff !== 0) {
      return diff
    }
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) {
    return 0
  }
  if (a.prerelease.length === 0) {
    return 1
  }
  if (b.prerelease.length === 0) {
    return -1
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const leftPart = a.prerelease[index]
    const rightPart = b.prerelease[index]
    if (leftPart === undefined) {
      return -1
    }
    if (rightPart === undefined) {
      return 1
    }
    const leftNumber = /^\d+$/.test(leftPart) ? Number(leftPart) : null
    const rightNumber = /^\d+$/.test(rightPart) ? Number(rightPart) : null
    if (leftNumber !== null && rightNumber !== null && leftNumber !== rightNumber) {
      return leftNumber - rightNumber
    }
    if (leftNumber !== null && rightNumber === null) {
      return -1
    }
    if (leftNumber === null && rightNumber !== null) {
      return 1
    }
    if (leftPart !== rightPart) {
      return leftPart < rightPart ? -1 : 1
    }
  }
  return 0
}
