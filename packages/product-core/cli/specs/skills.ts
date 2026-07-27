import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const SKILL_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['skills', 'get'],
    summary: 'Print the full guide bundled with this Pebble checkout',
    usage: 'pebble skills get <skill-name> [--app-version <version>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'name', 'app-version'],
    positionalArgs: ['name'],
    examples: [
      'pebble skills get pebble-cli',
      'pebble skills get computer-use --app-version 1.4.124-rc.8 --json'
    ]
  }
]
