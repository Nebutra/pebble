#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { stopFunctionalGateProcess } from './functional-gate-process-shutdown.mjs'

const options = parseArgs(process.argv.slice(2))
const root = path.resolve(import.meta.dirname, '../..')
const dataDir = mkdtempSync(path.join(os.tmpdir(), 'pebble-tauri-idle-'))

try {
  const executable = buildAndResolveExecutable(root, options.skipBuild)
  const child = spawn(executable, [], {
    detached: process.platform !== 'win32',
    stdio: 'ignore',
    env: { ...process.env, PEBBLE_USER_DATA_PATH: dataDir }
  })
  child.once('error', (error) => {
    throw error
  })
  await delay(options.warmupMs)
  if (child.exitCode !== null) {
    throw new Error(`Tauri shell exited during warmup: ${child.exitCode}`)
  }
  const samples = []
  const deadline = Date.now() + options.sampleMs
  while (Date.now() <= deadline || samples.length === 0) {
    const rows = descendantsOf(readProcessRows(), child.pid)
    samples.push({
      sampledAt: new Date().toISOString(),
      cpuPercent: rows.reduce((sum, row) => sum + row.cpuPercent, 0),
      rssBytes: rows.reduce((sum, row) => sum + row.rssBytes, 0),
      processCount: rows.length
    })
    await delay(options.intervalMs)
  }
  await stopFunctionalGateProcess(child)
  const cpuValues = samples.map((sample) => sample.cpuPercent).sort((a, b) => a - b)
  const report = {
    schemaVersion: 1,
    owner: 'tauri-desktop',
    platform: process.platform,
    warmupMs: options.warmupMs,
    sampleMs: options.sampleMs,
    intervalMs: options.intervalMs,
    samples,
    summary: {
      meanCpuPercent: mean(cpuValues),
      p95CpuPercent: percentile(cpuValues, 0.95),
      maximumRssBytes: Math.max(...samples.map((sample) => sample.rssBytes))
    }
  }
  if (options.output) {
    await import('node:fs').then(({ mkdirSync, writeFileSync }) => {
      mkdirSync(path.dirname(path.resolve(options.output)), { recursive: true })
      writeFileSync(path.resolve(options.output), `${JSON.stringify(report, null, 2)}\n`)
    })
  } else {
    console.log(JSON.stringify(report, null, 2))
  }
} finally {
  rmSync(dataDir, { recursive: true, force: true })
}

function buildAndResolveExecutable(projectRoot, skipBuild) {
  const executable = path.join(
    projectRoot,
    'apps',
    'desktop',
    'src-tauri',
    'target',
    'release',
    process.platform === 'win32' ? 'pebble-desktop-tauri.exe' : 'pebble-desktop-tauri'
  )
  if (!skipBuild) {
    const result = spawnSync(command('pnpm'), ['build:tauri:no-bundle'], {
      cwd: projectRoot,
      stdio: 'inherit'
    })
    if (result.error) {
      throw result.error
    }
    if (result.status !== 0) {
      process.exit(result.status ?? 1)
    }
  }
  if (!existsSync(executable)) {
    throw new Error(`Tauri executable is missing at ${executable}`)
  }
  return executable
}

function readProcessRows() {
  if (process.platform === 'win32') {
    const script = [
      '$rows = Get-CimInstance Win32_Process | ForEach-Object {',
      '  $p = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue;',
      '  if ($p) { [pscustomobject]@{ pid=$_.ProcessId; ppid=$_.ParentProcessId; cpu=0; rss=$p.WorkingSet64 } }',
      '}; $rows | ConvertTo-Json -Compress'
    ].join(' ')
    const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], {
      encoding: 'utf8'
    })
    if (result.status !== 0) {
      throw new Error(result.stderr || 'Could not read Windows process table')
    }
    const parsed = JSON.parse(result.stdout || '[]')
    return (Array.isArray(parsed) ? parsed : [parsed]).map((row) => ({
      pid: Number(row.pid),
      ppid: Number(row.ppid),
      cpuPercent: Number(row.cpu) || 0,
      rssBytes: Number(row.rss) || 0
    }))
  }
  const result = spawnSync('ps', ['-Ao', 'pid=,ppid=,%cpu=,rss='], { encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(result.stderr || 'Could not read process table')
  }
  return result.stdout
    .trim()
    .split('\n')
    .map((line) => {
      const [pid, ppid, cpu, rss] = line.trim().split(/\s+/).map(Number)
      return { pid, ppid, cpuPercent: cpu || 0, rssBytes: (rss || 0) * 1024 }
    })
}

function descendantsOf(rows, rootPid) {
  const ids = new Set([rootPid])
  let changed = true
  while (changed) {
    changed = false
    for (const row of rows) {
      if (ids.has(row.ppid) && !ids.has(row.pid)) {
        ids.add(row.pid)
        changed = true
      }
    }
  }
  return rows.filter((row) => ids.has(row.pid))
}

function parseArgs(argv) {
  const parsed = {
    warmupMs: 15_000,
    sampleMs: 30_000,
    intervalMs: 1_000,
    skipBuild: false,
    output: null
  }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    const next = () => {
      const candidate = argv[++index]
      if (!candidate) {
        throw new Error(`${value} requires a value`)
      }
      return candidate
    }
    if (value === '--warmup-ms') {
      parsed.warmupMs = Number(next())
    } else if (value === '--sample-ms') {
      parsed.sampleMs = Number(next())
    } else if (value === '--interval-ms') {
      parsed.intervalMs = Number(next())
    } else if (value === '--output') {
      parsed.output = next()
    } else if (value === '--skip-build') {
      parsed.skipBuild = true
    } else {
      throw new Error(`Unknown argument: ${value}`)
    }
  }
  for (const key of ['warmupMs', 'sampleMs', 'intervalMs']) {
    if (!Number.isFinite(parsed[key]) || parsed[key] <= 0) {
      throw new Error(`${key} must be positive`)
    }
  }
  return parsed
}

function mean(values) {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) {
    return 0
  }
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}

function command(name) {
  return process.platform === 'win32' ? `${name}.cmd` : name
}
