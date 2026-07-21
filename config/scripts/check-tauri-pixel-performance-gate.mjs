import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

import { compareDesktopParityScreenshots } from './compare-desktop-parity-screenshots.mjs'

export const DEFAULT_SETTINGS_SWITCH_P95_MS = 350
export const DEFAULT_MAX_LONG_TASK_MS = 100
export const DEFAULT_MAX_LONG_TASK_COUNT = 0

export function percentile(values, percentileValue) {
  if (values.length === 0) {
    throw new Error('At least one performance sample is required')
  }
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.max(0, Math.ceil(percentileValue * sorted.length) - 1)]
}

export function evaluateTauriPixelPerformanceGate(input) {
  const budgets = {
    settingsSwitchP95Ms: input.budgets?.settingsSwitchP95Ms ?? DEFAULT_SETTINGS_SWITCH_P95_MS,
    maxLongTaskMs: input.budgets?.maxLongTaskMs ?? DEFAULT_MAX_LONG_TASK_MS,
    maxLongTaskCount: input.budgets?.maxLongTaskCount ?? DEFAULT_MAX_LONG_TASK_COUNT
  }
  validateBudgets(budgets)
  const samples = input.samples.map(validateSample)
  const screenshot = compareDesktopParityScreenshots(input.referenceBytes, input.candidateBytes, {
    channelThreshold: input.channelThreshold,
    maxMismatchRatio: input.maxMismatchRatio
  })
  const metrics = {
    settingsSwitchP95Ms: percentile(
      samples.map((sample) => sample.switchDurationMs),
      0.95
    ),
    maxLongTaskMs: Math.max(...samples.map((sample) => sample.maxLongTaskMs)),
    longTaskCount: samples.reduce((sum, sample) => sum + sample.longTaskCount, 0)
  }
  const failures = []
  if (metrics.settingsSwitchP95Ms > budgets.settingsSwitchP95Ms) {
    failures.push(
      `Settings first-switch p95 ${metrics.settingsSwitchP95Ms.toFixed(1)}ms exceeds ${budgets.settingsSwitchP95Ms}ms`
    )
  }
  if (metrics.maxLongTaskMs > budgets.maxLongTaskMs) {
    failures.push(
      `maximum long task ${metrics.maxLongTaskMs.toFixed(1)}ms exceeds ${budgets.maxLongTaskMs}ms`
    )
  }
  if (metrics.longTaskCount > budgets.maxLongTaskCount) {
    failures.push(`long-task count ${metrics.longTaskCount} exceeds ${budgets.maxLongTaskCount}`)
  }
  if (!screenshot.matches) {
    failures.push(
      `screenshot mismatch ratio ${screenshot.mismatchRatio.toFixed(6)} exceeds ${screenshot.maxMismatchRatio}`
    )
  }
  return { passed: failures.length === 0, budgets, metrics, samples, screenshot, failures }
}

function validateSample(sample, index) {
  for (const key of ['switchDurationMs', 'maxLongTaskMs', 'totalLongTaskMs', 'longTaskCount']) {
    if (!Number.isFinite(sample?.[key]) || sample[key] < 0) {
      throw new Error(`sample ${index + 1} has invalid ${key}`)
    }
  }
  return sample
}

function validateBudgets(budgets) {
  for (const [key, value] of Object.entries(budgets)) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`${key} must be a non-negative number`)
    }
  }
}

function readOptions(argv) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith('--') || argv[index + 1] === undefined) {
      throw new Error('Expected --name value arguments')
    }
    values.set(argv[index].slice(2), argv[index + 1])
  }
  for (const required of ['reference', 'candidate', 'samples', 'diff', 'report']) {
    if (!values.has(required)) {
      throw new Error(`Missing --${required}`)
    }
  }
  return values
}

function optionalNumber(values, key) {
  return values.has(key) ? Number(values.get(key)) : undefined
}

function runCli() {
  const values = readOptions(process.argv.slice(2))
  const result = evaluateTauriPixelPerformanceGate({
    referenceBytes: readFileSync(values.get('reference')),
    candidateBytes: readFileSync(values.get('candidate')),
    samples: JSON.parse(readFileSync(values.get('samples'), 'utf8')),
    channelThreshold: optionalNumber(values, 'channel-threshold'),
    maxMismatchRatio: optionalNumber(values, 'max-mismatch-ratio'),
    budgets: {
      settingsSwitchP95Ms: optionalNumber(values, 'settings-switch-p95-ms'),
      maxLongTaskMs: optionalNumber(values, 'max-long-task-ms'),
      maxLongTaskCount: optionalNumber(values, 'max-long-task-count')
    }
  })
  writeFileSync(values.get('diff'), result.screenshot.diffBytes)
  writeFileSync(
    values.get('report'),
    `${JSON.stringify({ ...result, screenshot: { ...result.screenshot, diffBytes: undefined } }, null, 2)}\n`
  )
  process.stdout.write(`${result.passed ? 'PASS' : 'FAIL'}: Tauri pixel/performance release gate\n`)
  for (const failure of result.failures) {
    process.stderr.write(`- ${failure}\n`)
  }
  if (!result.passed) {
    process.exitCode = 1
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runCli()
}
