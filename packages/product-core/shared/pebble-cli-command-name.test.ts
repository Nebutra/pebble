import { describe, expect, it } from 'vitest'
import { getPebbleCliCommandNameForPlatform } from './pebble-cli-command-name'
import { getTuiAgentDetectCommands, TUI_AGENT_CONFIG } from './tui-agent-config'

describe('Pebble CLI command name', () => {
  it.each([
    ['darwin', 'pebble'],
    ['linux', 'pebble'],
    ['win32', 'pebble.cmd']
  ] as const)('uses the canonical command on %s', (platform, expected) => {
    expect(getPebbleCliCommandNameForPlatform(platform)).toBe(expected)
  })

  it('keeps the former Linux name as detection-only compatibility', () => {
    expect(getTuiAgentDetectCommands(TUI_AGENT_CONFIG['claude-agent-teams'])).toEqual([
      'pebble',
      'pebble-dev',
      'pebble-ide'
    ])
  })
})
