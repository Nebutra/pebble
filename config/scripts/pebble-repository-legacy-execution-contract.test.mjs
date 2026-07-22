import { describe, expect, it } from 'vitest'
import {
  findForbiddenLockfilePackages,
  findForbiddenManifestDependencies,
  findLegacyExecutionReferences,
  isExecutableOwnershipPath
} from './pebble-repository-legacy-execution-contract.mjs'

describe('Pebble repository legacy execution contract', () => {
  it('rejects Electron and Stably dependencies from every manifest group', () => {
    expect(
      findForbiddenManifestDependencies([
        [
          'apps/desktop/package.json',
          {
            dependencies: { electron: '1.0.0' },
            devDependencies: {
              '@nebutra/playwright-test': 'npm:@stablyai/playwright-test@1.0.0'
            }
          }
        ]
      ])
    ).toEqual([
      'forbidden dependency electron in apps/desktop/package.json (dependencies)',
      'forbidden dependency @nebutra/playwright-test in apps/desktop/package.json (devDependencies)'
    ])
  })

  it('rejects exact legacy lockfile packages without rejecting browser compatibility data', () => {
    expect(
      findForbiddenLockfilePackages({
        packages: {
          '@stablyai/playwright-test@2.1.14': {},
          'electron@42.3.3': {},
          'electron-to-chromium@1.5.351': {}
        }
      })
    ).toEqual([
      'forbidden lockfile package: @stablyai/playwright-test@2.1.14',
      'forbidden lockfile package: electron@42.3.3'
    ])
  })

  it('rejects executable legacy paths, projects, APIs, commands, and environment names', () => {
    const source = [
      'npx electron-vite build migration/electron-reference',
      '--project electron-headless',
      'ElectronApplication _electron',
      'BrowserWindow ipcMain powerSaveBlocker evaluateInElectronMain',
      'PEBBLE_ELECTRON_CAPTURE_PATH',
      'node_modules/.bin/electron PEBBLE_APP_EXECUTABLE_NEEDS_APP_ROOT',
      '@nebutra/playwright-test'
    ].join('\n')

    expect(findLegacyExecutionReferences([['tests/e2e/legacy.spec.ts', source]])).toEqual([
      'legacy Electron reference path: tests/e2e/legacy.spec.ts',
      'Electron Vite command: tests/e2e/legacy.spec.ts',
      'Electron Playwright project: tests/e2e/legacy.spec.ts',
      'Electron Playwright application API: tests/e2e/legacy.spec.ts',
      'Electron main-process test API: tests/e2e/legacy.spec.ts',
      'legacy Stably Playwright package: tests/e2e/legacy.spec.ts',
      'legacy Electron evidence environment: tests/e2e/legacy.spec.ts',
      'legacy Electron executable path: tests/e2e/legacy.spec.ts',
      'legacy Electron app-root environment: tests/e2e/legacy.spec.ts'
    ])
  })

  it('allows historical task records and explicit negative regression fixtures', () => {
    expect(isExecutableOwnershipPath('.trellis/tasks/07-20-migration/prd.md')).toBe(false)
    expect(
      isExecutableOwnershipPath('config/scripts/tauri-approved-pixel-baselines.test.mjs')
    ).toBe(false)
    expect(isExecutableOwnershipPath('tests/e2e/e2e-ownership.test.mjs')).toBe(false)
    expect(
      findLegacyExecutionReferences([['docs/reference/history.md', 'electron-headless']])
    ).toEqual([])
  })

  it('keeps ordinary Playwright and browser compatibility dependencies allowed', () => {
    expect(
      findForbiddenManifestDependencies([
        [
          'package.json',
          {
            devDependencies: { '@playwright/test': '1.59.1' },
            dependencies: { 'electron-to-chromium': '1.5.351' }
          }
        ]
      ])
    ).toEqual([])
  })
})
