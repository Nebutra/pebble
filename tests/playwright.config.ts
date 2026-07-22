import { defineConfig } from '@playwright/test'
import { resolve } from 'node:path'

import { browserPlaywrightProjects } from './e2e/e2e-ownership.mjs'

const desktopPort = 5187

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  timeout: 120_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  workers: process.env.CI ? 1 : undefined,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: `http://127.0.0.1:${desktopPort}`,
    channel: process.env.PEBBLE_PLAYWRIGHT_CHANNEL ?? 'chromium',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  },
  webServer: {
    // Why: renderer contracts mount the canonical Tauri entry with mocked IPC;
    // native lifecycle evidence remains owned by the Tauri functional gate.
    command: `./node_modules/.bin/vite --host 127.0.0.1 --port ${desktopPort} --strictPort --mode e2e`,
    cwd: resolve('apps/desktop'),
    url: `http://127.0.0.1:${desktopPort}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000
  },
  projects: Object.entries(browserPlaywrightProjects).map(([name, testMatch]) => ({
    name,
    testMatch
  }))
})
