import assert from 'node:assert/strict'
import test from 'node:test'

import { evaluateWindowLifecycleEvidence } from './window-lifecycle-evidence.mjs'

const macEvidence = {
  firstFrameMs: 900,
  minimizeObserved: true,
  minimizeMs: 80,
  resumeObserved: true,
  resumeFocused: true,
  resumeMs: 120,
  monitorCount: 1,
  multiDisplayRestore: 'unavailable'
}

test('accepts measured macOS lifecycle evidence within budget', () => {
  assert.equal(evaluateWindowLifecycleEvidence(macEvidence, 'darwin').passed, true)
})

test('rejects slow or incomplete macOS lifecycle transitions', () => {
  const result = evaluateWindowLifecycleEvidence(
    { ...macEvidence, firstFrameMs: 6_000, resumeFocused: false, resumeMs: 2_000 },
    'darwin'
  )
  assert.equal(result.passed, false)
  assert.equal(result.failures.length, 2)
})

test('does not forge multi-display restore evidence on a single-display host', () => {
  const result = evaluateWindowLifecycleEvidence(
    { ...macEvidence, multiDisplayRestore: 'passed' },
    'darwin'
  )
  assert.equal(result.passed, false)
})

test('requires relaunch proof when a macOS runner has multiple displays', () => {
  const result = evaluateWindowLifecycleEvidence(
    { ...macEvidence, monitorCount: 2, multiDisplayRestore: 'requires-relaunch' },
    'darwin'
  )
  assert.equal(result.passed, false)
  assert.match(result.failures[0], /persisted restore/)
})

test('leaves Windows and Linux evidence to their native release runners', () => {
  for (const platform of ['win32', 'linux']) {
    const result = evaluateWindowLifecycleEvidence(null, platform)
    assert.equal(result.passed, true)
    assert.equal(result.validated, false)
  }
})
