import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { verifyObservabilityReleaseConfig } from './sentry-release-config.mjs'

const repoRoot = resolve(import.meta.dirname, '../..')
const packageJson = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8'))

verifyObservabilityReleaseConfig({
  env: process.env,
  version: packageJson.version,
  targetTriple: process.env.TAURI_RELEASE_TARGET_TRIPLE?.trim()
})
