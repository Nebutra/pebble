import { globSync, readFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'

import { runSentryCli } from '../../../config/scripts/sentry-cli-process.mjs'
import { resolveSentryReleaseConfig } from '../../../config/scripts/sentry-release-config.mjs'

const packageDir = resolve(import.meta.dirname, '..')
const packageJson = JSON.parse(readFileSync(resolve(packageDir, 'package.json'), 'utf8'))
const config = resolveSentryReleaseConfig({ env: process.env, version: packageJson.version })

if (config) {
  const distDir = resolve(packageDir, 'dist')
  runSentryCli(
    [
      'sourcemaps',
      'upload',
      '--org',
      config.org,
      '--project',
      config.project,
      '--release',
      config.release,
      '--dist',
      config.dist,
      '--url-prefix',
      '~/',
      '--strict',
      '--wait',
      distDir
    ],
    { cwd: packageDir }
  )
  // Why: uploaded maps are build evidence, not public application assets.
  for (const sourceMap of globSync('**/*.map', { cwd: distDir })) {
    rmSync(resolve(distDir, sourceMap))
  }
}
