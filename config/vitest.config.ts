import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const windowsTestWorkerOptions = process.platform === 'win32' ? { maxWorkers: 4 } : {}

export default defineConfig({
  define: {
    PEBBLE_FEATURE_WALL_ENABLED: 'true'
  },
  resolve: {
    alias: {
      '@renderer': resolve('packages/product-core/renderer/src'),
      '@': resolve('packages/product-core/renderer/src')
    }
  },
  test: {
    environment: 'node',
    // Why: these files use Node's native test runner and are executed by their
    // owning release gates; Vitest otherwise executes them but finds no suites.
    exclude: [
      'config/scripts/check-tauri-pixel-performance-gate.test.mjs',
      'config/scripts/tauri-approved-pixel-baselines.test.mjs',
      'config/scripts/compare-desktop-parity-screenshots.test.mjs',
      'config/scripts/functional-gate-process-exit.test.mjs',
      'config/scripts/functional-gate-process-shutdown.test.mjs',
      'config/scripts/macos-tcc-reset-result.test.mjs',
      'config/scripts/prepare-tauri-release-config.test.mjs',
      'config/scripts/sync-tauri-release-version.test.mjs',
      'config/scripts/tauri-native-input-fixture.test.mjs',
      'config/scripts/tauri-native-input-real-runtime-contract.test.mjs',
      'config/scripts/tauri-real-runtime-capture-contract.test.mjs',
      'config/scripts/tauri-real-runtime-screenshot-evidence.test.mjs',
      'config/scripts/verify-tauri-runtime-method-coverage.test.mjs',
      'config/scripts/verify-tauri-updater-manifest.test.mjs',
      'config/scripts/verify-tauri-version-sync.test.mjs',
      'config/scripts/window-lifecycle-evidence.test.mjs'
    ],
    include: [
      'packages/product-core/**/*.test.ts',
      'packages/product-core/**/*.test.tsx',
      'apps/desktop/src/**/*.test.ts',
      'config/scripts/**/*.test.mjs',
      'tests/integration/**/*.test.ts',
      'tests/e2e/**/*.unit.test.ts'
    ],
    // Why: the full suite runs heavy TS transforms plus real git/http fixtures;
    // the Vitest 5s defaults are too tight for the slowest integration cases.
    hookTimeout: 60_000,
    testTimeout: 30_000,
    setupFiles: ['config/vitest-local-storage-compat.ts'],
    // Why: Windows process and shell startup are slower under full-suite load;
    // macOS/Linux keep Vitest's default worker parallelism.
    ...windowsTestWorkerOptions
  }
})
