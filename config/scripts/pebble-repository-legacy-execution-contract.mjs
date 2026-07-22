import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'yaml'

const forbiddenDependencyNames = [
  'electron',
  'electron-builder',
  'electron-vite',
  'electron-updater',
  '@electron/rebuild',
  '@electron-toolkit/preload',
  '@electron-toolkit/tsconfig',
  '@electron-toolkit/utils',
  '@nebutra/playwright-test',
  '@stablyai/playwright',
  '@stablyai/playwright-base',
  '@stablyai/playwright-test'
]

const dependencyGroups = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies'
]

const negativeEvidencePaths = new Set([
  'config/scripts/legacy-brand-identifier-scan.mjs',
  'config/scripts/legacy-brand-identifier-scan.test.mjs',
  'config/scripts/pebble-repository-legacy-execution-contract.mjs',
  'config/scripts/pebble-repository-legacy-execution-contract.test.mjs',
  'config/scripts/tauri-approved-pixel-baselines.test.mjs',
  'config/scripts/verify-pebble-repository-layout.mjs',
  'config/scripts/verify-tauri-mainline.mjs',
  'tests/e2e/e2e-ownership.test.mjs'
])

const forbiddenExecutionPatterns = [
  ['legacy Electron reference path', /migration[\\/]electron-reference/i],
  ['Electron Vite command', /\belectron-vite\b/i],
  ['Electron parity script', /\bparity:electron:/i],
  ['Electron Playwright project', /\belectron-(?:headless|headful)\b/i],
  ['Electron Playwright application API', /\bElectronApplication\b|\b_electron\b/],
  [
    'Electron main-process test API',
    /\bBrowserWindow\b|\bipcMain\b|\bpowerSaveBlocker\b|\bevaluateInElectronMain\b/
  ],
  ['legacy Stably Playwright package', /@(?:nebutra|stablyai)\/playwright(?:-test|-base)?\b/i],
  ['legacy Electron evidence environment', /\bPEBBLE_ELECTRON_[A-Z0-9_]*\b/],
  [
    'legacy Electron executable path',
    /node_modules[\\/](?:\.bin[\\/])?electron(?:[\\/]|(?:\.cmd|\.exe)?\b)/i
  ],
  [
    'legacy Electron app-root environment',
    /\bPEBBLE_APP_EXECUTABLE_NEEDS_APP_ROOT\b/
  ],
  ['Electron package installer', /\binstall-electron-package-binary\b/i]
]

export function isExecutableOwnershipPath(file) {
  if (negativeEvidencePaths.has(file) || file.startsWith('.trellis/tasks/')) {
    return false
  }
  if (
    file === '.gitignore' ||
    file === '.npmrc' ||
    file === 'pnpm-workspace.yaml' ||
    file === 'package.json' ||
    file.endsWith('/package.json')
  ) {
    return true
  }
  return ['.github/workflows/', 'config/', 'skills/', 'tests/', 'tools/'].some((prefix) =>
    file.startsWith(prefix)
  )
}

export function findLegacyExecutionReferences(files) {
  const failures = []
  for (const [file, text] of files) {
    if (!isExecutableOwnershipPath(file)) {
      continue
    }
    for (const [label, pattern] of forbiddenExecutionPatterns) {
      if (pattern.test(text)) {
        failures.push(`${label}: ${file}`)
      }
    }
  }
  return failures
}

export function findForbiddenManifestDependencies(manifests) {
  const failures = []
  for (const [file, manifest] of manifests) {
    for (const group of dependencyGroups) {
      for (const dependency of forbiddenDependencyNames) {
        if (dependency in (manifest[group] ?? {})) {
          failures.push(`forbidden dependency ${dependency} in ${file} (${group})`)
        }
      }
    }
    for (const [scriptName, command] of Object.entries(manifest.scripts ?? {})) {
      for (const [label, pattern] of forbiddenExecutionPatterns) {
        if (pattern.test(`${scriptName}\n${command}`)) {
          failures.push(`${label} in ${file} script ${scriptName}`)
        }
      }
    }
  }
  return failures
}

export function findForbiddenLockfilePackages(lockfile) {
  const failures = []
  for (const packageKey of Object.keys(lockfile.packages ?? {})) {
    for (const dependency of forbiddenDependencyNames) {
      if (packageKey === dependency || packageKey.startsWith(`${dependency}@`)) {
        failures.push(`forbidden lockfile package: ${packageKey}`)
      }
    }
  }
  return failures
}

export function collectLegacyExecutionFailures(repoRoot) {
  const trackedFiles = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd: repoRoot, encoding: 'utf8' }
  )
    .split('\0')
    .filter(Boolean)
  const textFiles = []
  const manifests = []
  for (const file of trackedFiles) {
    if (!isExecutableOwnershipPath(file)) {
      continue
    }
    let contents
    try {
      contents = readFileSync(resolve(repoRoot, file))
    } catch (error) {
      if (error?.code === 'ENOENT') {
        continue
      }
      throw error
    }
    if (contents.includes(0)) {
      continue
    }
    const text = contents.toString('utf8')
    if (file === 'package.json' || file.endsWith('/package.json')) {
      manifests.push([file, JSON.parse(text)])
      continue
    }
    textFiles.push([file, text])
  }
  const lockfile = parse(readFileSync(resolve(repoRoot, 'pnpm-lock.yaml'), 'utf8'))
  return [
    ...findLegacyExecutionReferences(textFiles),
    ...findForbiddenManifestDependencies(manifests),
    ...findForbiddenLockfilePackages(lockfile)
  ]
}
