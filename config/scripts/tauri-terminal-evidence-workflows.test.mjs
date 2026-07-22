import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const root = resolve(import.meta.dirname, '../..')

function workflow(path) {
  return parse(readFileSync(resolve(root, path), 'utf8'))
}

function workflowRuns(document) {
  return Object.values(document.jobs)
    .flatMap((job) => job.steps ?? [])
    .map((step) => step.run)
    .filter((run) => typeof run === 'string')
}

describe('Tauri terminal evidence workflows', () => {
  it('runs mode-specific renderer plus native evidence from release jobs', () => {
    const runs = workflowRuns(workflow('.github/workflows/release-cut.yml'))
    expect(runs.some((run) => run.includes('playwright install'))).toBe(false)
    expect(runs.some((run) => run.includes('run-tauri-terminal-evidence.mjs --mode golden'))).toBe(
      true
    )
    expect(runs.some((run) => run.includes('run-tauri-terminal-evidence.mjs --mode release'))).toBe(
      true
    )
  })

  it('keeps experimental golden and scheduled perf on the shared Tauri runner', () => {
    const goldenRuns = workflowRuns(workflow('.github/workflows/golden-e2e-experiment.yml'))
    const perfRuns = workflowRuns(workflow('.github/workflows/terminal-perf.yml'))
    expect(goldenRuns.some((run) => run.includes('playwright install'))).toBe(false)
    expect(perfRuns.some((run) => run.includes('playwright install'))).toBe(false)
    expect(
      goldenRuns.some((run) => run.includes('run-tauri-terminal-evidence.mjs --mode golden'))
    ).toBe(true)
    expect(perfRuns).toEqual(
      expect.arrayContaining([
        expect.stringContaining('run-tauri-terminal-evidence.mjs --mode perf')
      ])
    )
  })
})
