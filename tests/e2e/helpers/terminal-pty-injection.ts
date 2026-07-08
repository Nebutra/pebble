import type { Page } from '@nebutra/playwright-test'
import { expect } from '@nebutra/playwright-test'

type TerminalPtyDataInjectionWindow = Window & {
  __terminalPtyDataInjection?: {
    keys: () => string[]
  }
}

export async function waitForTerminalPtyDataInjector(
  page: Page,
  paneKey: string,
  timeoutMs = 15_000
): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate((targetPaneKey) => {
          const injector = (window as TerminalPtyDataInjectionWindow).__terminalPtyDataInjection
          return injector?.keys().includes(targetPaneKey) ?? false
        }, paneKey),
      {
        timeout: timeoutMs,
        // Why: pane routing can settle before TerminalPane's e2e-only data
        // injector effect has registered the renderer callback.
        message: `terminal PTY data injector did not register for ${paneKey}`
      }
    )
    .toBe(true)
}
