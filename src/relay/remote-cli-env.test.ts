import { describe, expect, it } from 'vitest'
import { pickRemoteCliEnv } from './remote-cli-env'

describe('pickRemoteCliEnv', () => {
  it('forwards SSH Pebble terminal and worktree context for remote CLI calls', () => {
    expect(
      pickRemoteCliEnv({
        PEBBLE_TERMINAL_HANDLE: 'term_ssh',
        PEBBLE_WORKTREE_ID: 'repo::remote',
        PEBBLE_USER_DATA_PATH: '/tmp/pebble',
        PATH: '/usr/bin',
        SECRET_TOKEN: 'nope'
      })
    ).toEqual({
      PEBBLE_TERMINAL_HANDLE: 'term_ssh',
      PEBBLE_WORKTREE_ID: 'repo::remote',
      PEBBLE_USER_DATA_PATH: '/tmp/pebble',
      PATH: '/usr/bin'
    })
  })
})
