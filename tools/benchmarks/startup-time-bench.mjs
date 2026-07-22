#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../..')
const options = parseArgs(process.argv.slice(2))
const temporary = mkdtempSync(join(os.tmpdir(), 'pebble-tauri-startup-bench-'))
const samples = []

try {
  for (let index = 0; index < options.iterations; index += 1) {
    const reportPath = join(temporary, `runtime-${index + 1}.json`)
    const result = spawnSync(command('pnpm'), ['verify:tauri-real-runtime'], {
      cwd: root,
      stdio: 'inherit',
      env: {
        ...process.env,
        PEBBLE_REAL_RUNTIME_REPORT_PATH: reportPath,
        ...(index > 0 ? { PEBBLE_REAL_RUNTIME_REUSE_BUILD: '1' } : {})
      }
    })
    if (result.error) {
      throw result.error
    }
    if (result.status !== 0) {
      process.exit(result.status ?? 1)
    }
    const evidence = JSON.parse(readFileSync(reportPath, 'utf8'))
    samples.push({
      durationMs: evidence.durationMs,
      firstFrameMs: evidence.windowLifecycle?.firstFrameMs ?? null,
      minimizeMs: evidence.windowLifecycle?.minimizeMs ?? null,
      resumeMs: evidence.windowLifecycle?.resumeMs ?? null
    })
  }
  const report = {
    schemaVersion: 1,
    owner: 'tauri-real-runtime',
    label: options.label,
    samples,
    median: Object.fromEntries(
      Object.keys(samples[0] ?? {}).map((key) => [
        key,
        median(samples.map((sample) => sample[key]))
      ])
    )
  }
  const resultsDir = resolve(import.meta.dirname, 'results')
  mkdirSync(resultsDir, { recursive: true })
  const output = join(resultsDir, `startup-${options.label}-${stamp()}.json`)
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`)
  console.log(`Tauri startup benchmark written to ${output}`)
} finally {
  rmSync(temporary, { recursive: true, force: true })
}

function parseArgs(argv) {
  const parsed = { label: 'run', iterations: 5 }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    const next = () => {
      const candidate = argv[++index]
      if (!candidate) {
        throw new Error(`${value} requires a value`)
      }
      return candidate
    }
    if (value === '--label') {
      parsed.label = next()
    } else if (value === '--iterations') {
      parsed.iterations = Number(next())
    } else {
      throw new Error(`Unknown argument: ${value}`)
    }
  }
  if (!Number.isInteger(parsed.iterations) || parsed.iterations < 1) {
    throw new Error('--iterations must be a positive integer')
  }
  return parsed
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (sorted.length === 0) {
    return null
  }
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function command(name) {
  return process.platform === 'win32' ? `${name}.cmd` : name
}
