import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const expectedTargets = new Map([
  ['universal-apple-darwin', 'macos'],
  ['x86_64-unknown-linux-gnu', 'linux'],
  ['aarch64-unknown-linux-gnu', 'linux'],
  ['x86_64-pc-windows-msvc', 'windows']
])

async function jsonFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = resolve(directory, entry.name)
      return entry.isDirectory() ? jsonFiles(path) : entry.isFile() && path.endsWith('.json') ? [path] : []
    })
  )
  return nested.flat()
}

function artifactsForRole(report, role) {
  return report.artifacts.filter((artifact) => artifact.role === role)
}

function requireChecks(artifacts, checks, label) {
  if (artifacts.length === 0) {
    throw new Error(`Release evidence has no ${label}.`)
  }
  for (const artifact of artifacts) {
    for (const check of checks) {
      if (!artifact.checks.includes(check)) {
        throw new Error(`Release evidence ${artifact.path} is missing check ${check}.`)
      }
    }
  }
}

export function validateReleaseEvidenceReports(reports) {
  if (!Array.isArray(reports)) {
    throw new Error('Release evidence reports must be an array.')
  }
  const byTarget = new Map()
  for (const report of reports) {
    if (report?.schemaVersion !== 1 || !Array.isArray(report.artifacts)) {
      throw new Error('Release evidence report is malformed.')
    }
    if (byTarget.has(report.targetTriple)) {
      throw new Error(`Duplicate release evidence for ${report.targetTriple}.`)
    }
    byTarget.set(report.targetTriple, report)
  }

  for (const [targetTriple, platform] of expectedTargets) {
    const report = byTarget.get(targetTriple)
    if (!report) {
      throw new Error(`Missing release evidence for ${targetTriple}.`)
    }
    if (report.platform !== platform) {
      throw new Error(`Release evidence ${targetTriple} has platform ${report.platform}.`)
    }
    requireChecks(artifactsForRole(report, 'prepared-sidecar'), ['architecture'], 'prepared sidecars')
    const preparedRelayWorkers = artifactsForRole(report, 'prepared-relay-worker')
    if (preparedRelayWorkers.length !== 6) {
      throw new Error(`Release evidence ${targetTriple} must include six prepared relay workers.`)
    }
    requireChecks(preparedRelayWorkers, ['architecture'], 'prepared relay workers')
    if (platform !== 'linux') {
      requireChecks(artifactsForRole(report, 'updater-payload'), ['cryptographic-signature-valid', 'signature-sidecar-present'], 'updater payload')
      requireChecks(artifactsForRole(report, 'updater-signature'), ['cryptographic-signature-valid', 'non-empty'], 'updater signature')
    }

    if (platform === 'macos') {
      requireChecks(artifactsForRole(report, 'main-executable'), ['architecture', 'codesign-developer-id', 'hardened-runtime', 'notarization-stapled'], 'macOS executable')
      requireChecks(artifactsForRole(report, 'installer'), ['notarization-stapled'], 'macOS installer')
      const bundledRelayWorkers = artifactsForRole(report, 'bundled-relay-worker')
      if (bundledRelayWorkers.length !== 6) {
        throw new Error('macOS release evidence must include six bundled relay workers.')
      }
      requireChecks(bundledRelayWorkers, ['architecture'], 'bundled relay workers')
      if (
        bundledRelayWorkers.filter((artifact) =>
          artifact.checks.includes('codesign-developer-id')
        ).length !== 2
      ) {
        throw new Error('macOS release evidence must sign both Darwin relay workers.')
      }
    } else if (platform === 'windows') {
      requireChecks(artifactsForRole(report, 'main-executable'), ['architecture', 'authenticode-valid'], 'Windows executable')
      const installers = artifactsForRole(report, 'installer')
      if (installers.length !== 2) {
        throw new Error('Windows release evidence must include NSIS and MSI installers.')
      }
      requireChecks(installers, ['authenticode-valid'], 'Windows installer')
      requireChecks(installers, ['relay-worker-matrix-contained'], 'Windows installer')
      if (!installers.some((artifact) => artifact.checks.includes('silent-install-smoke'))) {
        throw new Error('Windows release evidence must include an NSIS silent-install smoke test.')
      }
    } else {
      requireChecks(
        artifactsForRole(report, 'main-executable'),
        ['architecture', 'glibc-symbol-ceiling'],
        'Linux executable'
      )
      const installers = artifactsForRole(report, 'installer')
      if (installers.length !== 1 || !installers[0].path.endsWith('.deb')) {
        throw new Error(`Release evidence ${targetTriple} must include exactly one Debian installer.`)
      }
      requireChecks(installers, ['relay-worker-matrix-contained'], 'Linux installer')
    }
  }
  if (byTarget.size !== expectedTargets.size) {
    throw new Error('Release evidence contains an unexpected target triple.')
  }
  return reports
}

export async function verifyReleaseEvidenceDirectory(directory) {
  const paths = await jsonFiles(directory)
  const reports = await Promise.all(paths.map(async (path) => JSON.parse(await readFile(path, 'utf8'))))
  validateReleaseEvidenceReports(reports)
  return paths
}

if (process.argv[1] === import.meta.filename) {
  const directory = resolve(process.argv[2] || 'artifacts/tauri-release-inspection')
  const paths = await verifyReleaseEvidenceDirectory(directory)
  console.log(`Verified ${paths.length} Tauri release evidence reports.`)
}
