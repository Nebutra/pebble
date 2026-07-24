import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { runSentryCli } from './sentry-cli-process.mjs'
import {
  resolveNativeSentryReleaseDirectory,
  resolveSentryReleaseConfig
} from './sentry-release-config.mjs'

const repoRoot = resolve(import.meta.dirname, '../..')
const packageJson = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8'))
const targetTriple = process.env.TAURI_RELEASE_TARGET_TRIPLE?.trim()
if (!targetTriple) {
  throw new Error('TAURI_RELEASE_TARGET_TRIPLE is required for native Sentry upload.')
}
const targetReleaseDir = process.env.TAURI_RELEASE_TARGET_RELEASE_DIR?.trim()
const releaseDir = resolveNativeSentryReleaseDirectory({ repoRoot, targetReleaseDir })
const config = resolveSentryReleaseConfig({
  env: process.env,
  version: packageJson.version,
  targetTriple
})

if (config) {
  if (!existsSync(releaseDir)) {
    throw new Error(`Native Sentry upload directory is missing for ${targetTriple}.`)
  }
  runSentryCli(
    [
      'debug-files',
      'upload',
      '--org',
      config.org,
      '--project',
      config.project,
      '--include-sources',
      '--wait',
      releaseDir
    ],
    { cwd: repoRoot }
  )
}
