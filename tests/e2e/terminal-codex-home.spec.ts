import { test, expect } from './helpers/pebble-app'
import {
  execInTerminal,
  getTerminalContent,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'

type CodexHomeProbe = {
  codexHome: string | null
  pebbleCodexHome: string | null
}

function readCodexHomeProbe(pageContent: string, marker: string): CodexHomeProbe | null {
  const match = new RegExp(`${marker}:(\\{[^\\r\\n]+\\})`).exec(pageContent)
  if (!match) {
    return null
  }
  return JSON.parse(match[1] ?? 'null') as CodexHomeProbe | null
}

test.describe('Terminal Codex runtime home', () => {
  test.beforeEach(async ({ pebblePage }) => {
    await waitForSessionReady(pebblePage)
    await waitForActiveWorktree(pebblePage)
    await ensureTerminalVisible(pebblePage)
  })

  test('terminal process receives the Pebble-managed Codex home', async ({ pebblePage }) => {
    await waitForActiveTerminalManager(pebblePage)
    const ptyId = await waitForActivePanePtyId(pebblePage)
    const marker = `__PEBBLE_CODEX_HOME_E2E_${Date.now()}__`
    const command = [
      'node -e',
      `"console.log('${marker}:' + JSON.stringify({codexHome: process.env.CODEX_HOME || null, pebbleCodexHome: process.env.PEBBLE_CODEX_HOME || null}))"`
    ].join(' ')

    await execInTerminal(pebblePage, ptyId, command)

    let probe: CodexHomeProbe | null = null
    await expect
      .poll(
        async () => {
          probe = readCodexHomeProbe(await getTerminalContent(pebblePage), marker)
          return Boolean(
            probe?.codexHome &&
            probe.pebbleCodexHome &&
            probe.codexHome === probe.pebbleCodexHome &&
            /[\\/]codex-runtime-home[\\/]home$/.test(probe.codexHome)
          )
        },
        { timeout: 15_000, message: 'Terminal did not expose Pebble-managed Codex home env' }
      )
      .toBe(true)

    expect(probe?.codexHome).toBe(probe?.pebbleCodexHome)
  })
})
