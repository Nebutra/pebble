import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const ENVIRONMENT_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['environment', 'add'],
    summary: 'Save a remote Pebble runtime environment from a pairing code',
    usage: 'pebble environment add --name <name> --pairing-code <code> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'name'],
    examples: ['pebble environment add --name work-laptop --pairing-code pebble://pair?code=...']
  },
  {
    path: ['environment', 'list'],
    summary: 'List saved Pebble runtime environments',
    usage: 'pebble environment list [--json]',
    allowedFlags: [...GLOBAL_FLAGS]
  },
  {
    path: ['environment', 'show'],
    summary: 'Show one saved Pebble runtime environment',
    usage: 'pebble environment show --environment <selector> [--json]',
    allowedFlags: [...GLOBAL_FLAGS]
  },
  {
    path: ['environment', 'rm'],
    summary: 'Remove one saved Pebble runtime environment',
    usage: 'pebble environment rm --environment <selector> [--json]',
    allowedFlags: [...GLOBAL_FLAGS]
  }
]
