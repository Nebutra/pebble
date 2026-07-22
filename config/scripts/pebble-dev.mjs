#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { accessSync, constants, existsSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'

const scriptPath = realpathSync(import.meta.filename)
const scriptDir = path.dirname(scriptPath)
const repoRoot = path.resolve(scriptDir, '..', '..')
const cliEntry =
  process.env.PEBBLE_DEV_CLI_ENTRY_PATH ?? path.join(repoRoot, 'out', 'cli', 'index.js')

if (!existsSync(cliEntry)) {
  console.error("pebble-dev: CLI not built yet. Run 'pnpm run build:cli' first.")
  process.exit(1)
}

const userDataPath = process.env.PEBBLE_DEV_USER_DATA_PATH ?? getDefaultDevUserDataPath()
process.env.PEBBLE_USER_DATA_PATH = userDataPath

const tauriExecutable = getTauriExecutable()
if (!process.env.PEBBLE_APP_EXECUTABLE && isRunnableFile(tauriExecutable)) {
  process.env.PEBBLE_APP_EXECUTABLE = tauriExecutable
}

const result = spawnSync(process.execPath, [cliEntry, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env
})

if (result.signal) {
  process.kill(process.pid, result.signal)
}
process.exit(result.status ?? (result.error ? 1 : 0))

function getDefaultDevUserDataPath() {
  if (process.platform === 'darwin') {
    return path.join(process.env.HOME ?? '', 'Library', 'Application Support', 'pebble-dev')
  }
  if (process.platform === 'win32') {
    return path.join(
      process.env.APPDATA ?? path.join(process.env.USERPROFILE ?? '', 'AppData', 'Roaming'),
      'pebble-dev'
    )
  }
  return path.join(
    process.env.XDG_CONFIG_HOME ?? path.join(process.env.HOME ?? '', '.config'),
    'pebble-dev'
  )
}

function getTauriExecutable() {
  const executable =
    process.platform === 'win32' ? 'pebble-desktop-tauri.exe' : 'pebble-desktop-tauri'
  return path.join(repoRoot, 'apps', 'desktop', 'src-tauri', 'target', 'release', executable)
}

function isRunnableFile(candidate) {
  try {
    const stats = statSync(candidate)
    if (!stats.isFile()) {
      return false
    }
    if (process.platform === 'win32') {
      return true
    }
    accessSync(candidate, constants.X_OK)
    return true
  } catch {
    return false
  }
}
