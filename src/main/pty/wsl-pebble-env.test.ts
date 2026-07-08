import { describe, expect, it } from 'vitest'
import { addPebbleWslInteropEnv } from './wsl-pebble-env'

describe('addPebbleWslInteropEnv', () => {
  it('marks the Pebble terminal handle for Windows to WSL env import', () => {
    const env: Record<string, string> = { PEBBLE_TERMINAL_HANDLE: 'term_wsl' }

    addPebbleWslInteropEnv(env)

    expect(env.WSLENV).toBe('PEBBLE_TERMINAL_HANDLE/u')
  })

  it('preserves existing WSLENV entries and does not duplicate the handle entry', () => {
    const env: Record<string, string> = {
      WSLENV: 'FOO/u:PEBBLE_TERMINAL_HANDLE/u:BAR/p'
    }

    addPebbleWslInteropEnv(env)

    expect(env.WSLENV).toBe('FOO/u:PEBBLE_TERMINAL_HANDLE/u:BAR/p')
  })

  it('marks OMP status and hook env for Windows to WSL import', () => {
    const env: Record<string, string> = {
      PEBBLE_TERMINAL_HANDLE: 'term_wsl',
      PEBBLE_OMP_STATUS_EXTENSION:
        'C:\\Users\\jin\\.omp\\agent\\extensions\\pebble-agent-status.ts',
      PEBBLE_PANE_KEY: 'tab-1:leaf-1',
      PEBBLE_TAB_ID: 'tab-1',
      PEBBLE_WORKTREE_ID: 'repo::\\\\wsl.localhost\\Ubuntu\\home\\jin\\repo',
      PEBBLE_AGENT_HOOK_PORT: '4567',
      PEBBLE_AGENT_HOOK_TOKEN: 'token',
      PEBBLE_AGENT_HOOK_ENV: 'dev',
      PEBBLE_AGENT_HOOK_VERSION: '1'
    }

    addPebbleWslInteropEnv(env)

    expect(env.WSLENV).toContain('PEBBLE_TERMINAL_HANDLE/u')
    expect(env.WSLENV).toContain('PEBBLE_OMP_STATUS_EXTENSION/p')
    expect(env.WSLENV).toContain('PEBBLE_PANE_KEY/u')
    expect(env.WSLENV).toContain('PEBBLE_TAB_ID/u')
    expect(env.WSLENV).toContain('PEBBLE_WORKTREE_ID/u')
    expect(env.WSLENV).toContain('PEBBLE_AGENT_HOOK_PORT/u')
    expect(env.WSLENV).toContain('PEBBLE_AGENT_HOOK_TOKEN/u')
    expect(env.WSLENV).toContain('PEBBLE_AGENT_HOOK_ENV/u')
    expect(env.WSLENV).toContain('PEBBLE_AGENT_HOOK_VERSION/u')
  })

})
