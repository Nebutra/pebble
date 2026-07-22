import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  parseArgs,
  rendererUnitArgs,
  runTerminalEvidence,
  terminalRendererEvidenceModes
} from './run-tauri-terminal-evidence.mjs'

describe('Tauri terminal evidence ownership', () => {
  it('uses distinct renderer evidence for golden, release, and perf modes', () => {
    expect(Object.keys(terminalRendererEvidenceModes)).toEqual(['golden', 'release', 'perf'])
    expect(terminalRendererEvidenceModes.release.specs).toEqual(
      expect.arrayContaining([
        'packages/product-core/renderer/src/components/terminal-pane/hidden-output-restore-scheduler.test.ts',
        'packages/product-core/renderer/src/components/terminal-pane/terminal-visibility-resume.test.ts'
      ])
    )
    expect(terminalRendererEvidenceModes.perf.specs).toEqual([
      'packages/product-core/renderer/src/components/terminal-pane/pty-input-write-queue.test.ts',
      'packages/product-core/renderer/src/components/terminal-pane/hidden-output-restore-scheduler.test.ts'
    ])
  })

  it('uses renderer unit contracts without claiming browser-native execution', () => {
    expect(rendererUnitArgs('golden')).toEqual(
      expect.arrayContaining(['exec', 'vitest', 'run', '--maxWorkers=1'])
    )
    expect(rendererUnitArgs('perf')).not.toContain('playwright')
  })

  it('rejects unsupported modes and invalid native sample counts', () => {
    expect(() => parseArgs(['--mode', 'electron'])).toThrow('Unknown mode: electron')
    expect(() => parseArgs(['--mode', 'perf', '--runs', '0'])).toThrow(
      '--runs must be a positive integer'
    )
  })

  it('runs renderer unit contracts before separate native Tauri evidence in perf mode', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pebble-terminal-evidence-contract-'))
    const output = join(directory, 'report.json')
    const evidenceDir = join(directory, 'captures')
    const calls = []
    const spawn = (executable, args, options) => {
      calls.push({ executable, args })
      if (options.env.PEBBLE_REAL_RUNTIME_REPORT_PATH) {
        writeFileSync(
          options.env.PEBBLE_REAL_RUNTIME_REPORT_PATH,
          JSON.stringify({ status: 'passed', durationMs: 10 })
        )
      }
      return { status: 0 }
    }

    try {
      const report = runTerminalEvidence(
        ['--mode', 'perf', '--runs', '1', '--output', output, '--evidence-dir', evidenceDir],
        spawn
      )
      expect(calls.map((call) => call.args[0])).toEqual(['exec', 'verify:tauri-real-runtime'])
      expect(report.renderer).toMatchObject({
        owner: 'renderer-unit-supporting-evidence',
        specs: terminalRendererEvidenceModes.perf.specs
      })
      expect(report.native).toMatchObject({ owner: 'tauri-real-runtime' })
      expect(JSON.parse(readFileSync(output, 'utf8')).schemaVersion).toBe(2)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
