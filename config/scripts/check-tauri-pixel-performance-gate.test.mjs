import assert from 'node:assert/strict'
import test from 'node:test'
import { PNG } from 'pngjs'
import {
  evaluateTauriPixelPerformanceGate,
  percentile
} from './check-tauri-pixel-performance-gate.mjs'

const image = () => PNG.sync.write(new PNG({ width: 2, height: 2 }))
const sample = (switchDurationMs, maxLongTaskMs = 0, longTaskCount = 0) => ({
  switchDurationMs,
  maxLongTaskMs,
  longTaskCount,
  totalLongTaskMs: maxLongTaskMs
})

test('nearest-rank percentile is deterministic for release samples', () => {
  assert.equal(percentile([3, 1, 2, 5, 4], 0.95), 5)
})

test('gate passes images and samples within explicit budgets', () => {
  const bytes = image()
  const result = evaluateTauriPixelPerformanceGate({
    referenceBytes: bytes,
    candidateBytes: bytes,
    samples: [sample(100), sample(120)],
    budgets: { settingsSwitchP95Ms: 150, maxLongTaskMs: 60, maxLongTaskCount: 0 }
  })
  assert.equal(result.passed, true)
})

test('gate reports every exceeded performance budget', () => {
  const bytes = image()
  const result = evaluateTauriPixelPerformanceGate({
    referenceBytes: bytes,
    candidateBytes: bytes,
    samples: [sample(400, 120, 1)],
    budgets: { settingsSwitchP95Ms: 350, maxLongTaskMs: 100, maxLongTaskCount: 0 }
  })
  assert.equal(result.passed, false)
  assert.equal(result.failures.length, 3)
})
