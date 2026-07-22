#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../..')
const output =
  process.env.PEBBLE_E2E_TERMINAL_PERF_REPORT_PATH ?? 'test-results/tauri-terminal-performance.json'
const result = spawnSync(
  command('node'),
  ['config/scripts/run-tauri-terminal-evidence.mjs', '--mode', 'perf', '--output', output],
  {
    cwd: root,
    stdio: 'inherit',
    env: process.env
  }
)
if (result.error) {
  throw result.error
}
process.exit(result.status ?? 1)

function command(name) {
  return process.platform === 'win32' && name !== 'node' ? `${name}.cmd` : name
}
