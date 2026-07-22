import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const root = resolve(import.meta.dirname, '../..')
const workflow = parse(readFileSync(resolve(root, '.github/workflows/e2e.yml'), 'utf8'))

describe('desktop E2E workflow', () => {
  it('runs browser renderer coverage as a PR-visible Chromium job', () => {
    expect(workflow.on.pull_request.paths).toEqual(
      expect.arrayContaining([
        '.github/workflows/e2e.yml',
        'tests/e2e/**',
        'tests/playwright.config.ts',
        'packages/product-core/renderer/**',
        'apps/desktop/src-tauri/**',
        'runtime/go/**',
        'config/scripts/run-tauri-real-runtime-gate.mjs',
        'config/scripts/run-tauri-terminal-evidence.mjs'
      ])
    )

    const steps = workflow.jobs['browser-renderer'].steps
    expect(steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ run: 'pnpm exec playwright install --with-deps chromium' }),
        expect.objectContaining({ run: 'pnpm test:e2e:browser' })
      ])
    )
    expect(steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          uses: 'actions/cache@v5',
          with: expect.objectContaining({ path: '~/.cache/ms-playwright' })
        }),
        expect.objectContaining({
          name: 'Upload browser E2E failure evidence',
          if: 'failure()',
          uses: 'actions/upload-artifact@v7'
        })
      ])
    )
  })

  it('keeps native Tauri functional coverage in a separate platform matrix', () => {
    expect(workflow.jobs['browser-renderer']['runs-on']).toBe('ubuntu-latest')
    expect(workflow.jobs['tauri-functional'].strategy.matrix.include).toEqual([
      { os: 'ubuntu-latest', platform: 'linux' },
      { os: 'macos-15', platform: 'macos' },
      { os: 'windows-latest', platform: 'windows' }
    ])
    const nativeRuns = workflow.jobs['tauri-functional'].steps
      .map((step) => step.run)
      .filter((run) => typeof run === 'string')
    expect(nativeRuns).toContain(
      'xvfb-run --auto-servernum dbus-run-session -- pnpm verify:tauri-real-runtime'
    )
    expect(nativeRuns).toContain('pnpm verify:tauri-real-runtime')
  })
})
