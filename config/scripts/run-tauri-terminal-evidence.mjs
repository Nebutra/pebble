#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '../..')

export const terminalRendererEvidenceModes = Object.freeze({
  golden: {
    specs: [
      'packages/product-core/renderer/src/components/terminal-pane/terminal-capability-replies.test.ts',
      'packages/product-core/renderer/src/components/terminal-pane/terminal-webgl-atlas-recovery.test.ts'
    ]
  },
  release: {
    specs: [
      'packages/product-core/renderer/src/components/terminal-pane/hidden-output-restore-scheduler.test.ts',
      'packages/product-core/renderer/src/components/terminal-pane/terminal-output-visibility.test.ts',
      'packages/product-core/renderer/src/components/terminal-pane/terminal-visibility-resume.test.ts'
    ]
  },
  perf: {
    specs: [
      'packages/product-core/renderer/src/components/terminal-pane/pty-input-write-queue.test.ts',
      'packages/product-core/renderer/src/components/terminal-pane/hidden-output-restore-scheduler.test.ts'
    ]
  }
})

export function rendererUnitArgs(mode) {
  const evidence = terminalRendererEvidenceModes[mode]
  if (!evidence) {
    throw new Error(`Unknown mode: ${mode}`)
  }
  return [
    'exec',
    'vitest',
    'run',
    '--config',
    'config/vitest.config.ts',
    ...evidence.specs,
    '--maxWorkers=1'
  ]
}

export function parseArgs(argv) {
  const parsed = {
    mode: 'golden',
    output: 'artifacts/tauri-terminal-evidence/report.json',
    evidenceDir: null,
    runs: Number(process.env.PEBBLE_TERMINAL_PERF_RUNS ?? 3),
    p95BudgetMs: Number(process.env.PEBBLE_TERMINAL_RUNTIME_P95_MS ?? 120_000)
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
    if (value === '--mode') {
      parsed.mode = next()
    } else if (value === '--output') {
      parsed.output = next()
    } else if (value === '--evidence-dir') {
      parsed.evidenceDir = next()
    } else if (value === '--runs') {
      parsed.runs = Number(next())
    } else {
      throw new Error(`Unknown argument: ${value}`)
    }
  }
  if (!terminalRendererEvidenceModes[parsed.mode]) {
    throw new Error(`Unknown mode: ${parsed.mode}`)
  }
  if (!Number.isInteger(parsed.runs) || parsed.runs < 1) {
    throw new Error('--runs must be a positive integer')
  }
  if (!Number.isFinite(parsed.p95BudgetMs) || parsed.p95BudgetMs <= 0) {
    throw new Error('PEBBLE_TERMINAL_RUNTIME_P95_MS must be positive')
  }
  return parsed
}

export function runTerminalEvidence(argv = process.argv.slice(2), spawn = spawnSync) {
  const options = parseArgs(argv)
  const outputPath = resolve(options.output)
  const evidenceDir = options.evidenceDir
    ? resolve(options.evidenceDir)
    : resolve(dirname(options.output), 'runtime-captures')
  const modeEvidence = terminalRendererEvidenceModes[options.mode]

  mkdirSync(dirname(outputPath), { recursive: true })
  mkdirSync(evidenceDir, { recursive: true })
  runProcess(spawn, command('pnpm'), rendererUnitArgs(options.mode), process.env)

  const sampleCount = options.mode === 'perf' ? options.runs : 1
  const samples = []
  for (let index = 0; index < sampleCount; index += 1) {
    const samplePath = resolve(evidenceDir, `runtime-${index + 1}.json`)
    rmSync(samplePath, { force: true })
    runProcess(spawn, command('pnpm'), ['verify:tauri-real-runtime'], {
      ...process.env,
      PEBBLE_REAL_RUNTIME_REPORT_PATH: samplePath,
      PEBBLE_REAL_RUNTIME_SCREENSHOT_DIR: evidenceDir,
      ...(index > 0 ? { PEBBLE_REAL_RUNTIME_REUSE_BUILD: '1' } : {})
    })
    samples.push(JSON.parse(readFileSync(samplePath, 'utf8')))
  }

  const durations = samples
    .map((sample) => Number(sample.durationMs))
    .filter(Number.isFinite)
    .sort((a, b) => a - b)
  const p95Ms = percentile(durations, 0.95)
  const report = {
    schemaVersion: 2,
    owner: 'tauri-terminal-evidence',
    mode: options.mode,
    renderer: {
      owner: 'renderer-unit-supporting-evidence',
      specs: modeEvidence.specs.map((spec) => relative(root, resolve(root, spec)))
    },
    native: {
      owner: 'tauri-real-runtime',
      samples,
      summary: {
        runs: samples.length,
        p95Ms,
        maximumMs: durations.at(-1) ?? null
      }
    }
  }
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`)

  if (options.mode === 'perf' && p95Ms > options.p95BudgetMs) {
    throw new Error(`Tauri terminal runtime p95 ${p95Ms}ms exceeds ${options.p95BudgetMs}ms`)
  }
  console.log(`Tauri terminal ${options.mode} evidence written to ${outputPath}`)
  return report
}

function runProcess(spawn, executable, args, env) {
  const result = spawn(executable, args, { cwd: root, stdio: 'inherit', env })
  if (result.error) {
    throw result.error
  }
  if (result.status !== 0) {
    throw new Error(`${executable} ${args.join(' ')} failed with ${result.status}`)
  }
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) {
    return Number.POSITIVE_INFINITY
  }
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]
}

function command(name) {
  return process.platform === 'win32' ? `${name}.cmd` : name
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runTerminalEvidence()
}
