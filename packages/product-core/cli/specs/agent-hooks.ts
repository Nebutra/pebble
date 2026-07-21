import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const AGENT_HOOK_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['agent', 'hooks', 'status'],
    summary: 'Show whether Pebble-managed agent status hooks are enabled',
    usage: 'pebble agent hooks status [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    examples: ['pebble agent hooks status', 'pebble agent hooks status --json']
  },
  {
    path: ['agent', 'hooks', 'off'],
    summary: 'Disable Pebble-managed agent status hooks and remove local hook entries',
    usage: 'pebble agent hooks off [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    examples: ['pebble agent hooks off']
  },
  {
    path: ['agent', 'hooks', 'on'],
    summary: 'Enable Pebble-managed agent status hooks',
    usage: 'pebble agent hooks on [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    examples: ['pebble agent hooks on']
  }
]
