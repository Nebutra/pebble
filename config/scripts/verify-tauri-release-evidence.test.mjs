import { describe, expect, it } from 'vitest'

import { validateReleaseEvidenceReports } from './verify-tauri-release-evidence.mjs'

function artifact(role, checks) {
  return { checks, path: `${role}.bin`, role, sha256: 'a'.repeat(64), size: 1 }
}

function report(platform, targetTriple) {
  const artifacts = [
    artifact('prepared-sidecar', ['architecture']),
    artifact('prepared-sidecar', ['architecture']),
    ...Array.from({ length: 6 }, () => artifact('prepared-relay-worker', ['architecture']))
  ]
  if (platform !== 'linux') {
    artifacts.push(
      artifact('updater-payload', [
        'cryptographic-signature-valid',
        'signature-sidecar-present'
      ]),
      artifact('updater-signature', ['cryptographic-signature-valid', 'non-empty'])
    )
  }
  if (platform === 'macos') {
    artifacts.push(
      artifact('main-executable', ['architecture', 'codesign-developer-id', 'hardened-runtime', 'notarization-stapled']),
      artifact('installer', ['notarization-stapled']),
      ...Array.from({ length: 2 }, () =>
        artifact('bundled-relay-worker', ['architecture', 'codesign-developer-id'])
      ),
      ...Array.from({ length: 4 }, () => artifact('bundled-relay-worker', ['architecture']))
    )
  } else if (platform === 'windows') {
    artifacts.push(
      artifact('main-executable', ['architecture', 'authenticode-valid']),
      artifact('installer', [
        'authenticode-valid',
        'relay-worker-matrix-contained',
        'silent-install-smoke'
      ]),
      artifact('installer', ['authenticode-valid', 'relay-worker-matrix-contained'])
    )
  } else {
    const installer = artifact('installer', [
      'package-architecture',
      'relay-worker-matrix-contained'
    ])
    installer.path = 'pebble.deb'
    artifacts.push(
      artifact('main-executable', ['architecture', 'glibc-symbol-ceiling']),
      installer
    )
  }
  return { artifacts, platform, schemaVersion: 1, targetTriple }
}

function completeReports() {
  return [
    report('macos', 'universal-apple-darwin'),
    report('linux', 'x86_64-unknown-linux-gnu'),
    report('linux', 'aarch64-unknown-linux-gnu'),
    report('windows', 'x86_64-pc-windows-msvc')
  ]
}

describe('Tauri release evidence matrix', () => {
  it('accepts the complete signed installer and updater matrix', () => {
    expect(() => validateReleaseEvidenceReports(completeReports())).not.toThrow()
  })

  it('rejects missing targets and downgraded signing evidence', () => {
    expect(() => validateReleaseEvidenceReports(completeReports().slice(1))).toThrow(/Missing/)
    const reports = completeReports()
    reports[3].artifacts.find(({ role }) => role === 'installer').checks = []
    expect(() => validateReleaseEvidenceReports(reports)).toThrow(/authenticode-valid/)
  })

  it('rejects updater evidence that only proves a signature sidecar exists', () => {
    const reports = completeReports()
    reports[0].artifacts.find(({ role }) => role === 'updater-payload').checks = [
      'signature-sidecar-present'
    ]
    expect(() => validateReleaseEvidenceReports(reports)).toThrow(
      /cryptographic-signature-valid/
    )
  })

  it('rejects a Windows release missing either installer format', () => {
    const reports = completeReports()
    const windows = reports[3]
    windows.artifacts.splice(
      windows.artifacts.findIndex(({ role }) => role === 'installer'),
      1
    )
    expect(() => validateReleaseEvidenceReports(reports)).toThrow(/NSIS and MSI/)
  })
})
