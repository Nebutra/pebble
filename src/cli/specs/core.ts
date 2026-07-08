import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'
import { SERVE_COMMAND_SPECS } from './serve'

export const CORE_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['open'],
    summary: 'Launch Pebble and wait for the runtime to be reachable',
    usage: 'pebble open [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    examples: ['pebble open', 'pebble open --json']
  },
  ...SERVE_COMMAND_SPECS,
  {
    path: ['status'],
    summary: 'Show app/runtime/graph readiness',
    usage: 'pebble status [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    examples: ['pebble status', 'pebble status --json']
  },
  {
    path: ['claude-teams'],
    summary: 'Start Claude Code Agent Teams in the current Pebble terminal',
    usage: 'pebble claude-teams [claude args...]',
    allowedFlags: [...GLOBAL_FLAGS],
    notes: [
      'Passes all following arguments through to Claude Code after enabling Agent Teams native panes.',
      'Must be run from inside an Pebble terminal. Starts Claude Code Agent Teams in the current pane and opens teammates as native Pebble splits.'
    ],
    examples: ['pebble claude-teams', 'pebble claude-teams --resume <session-id>']
  },
  {
    path: ['repo', 'list'],
    summary: 'List repos registered in Pebble',
    usage: 'pebble repo list [--json]',
    allowedFlags: [...GLOBAL_FLAGS]
  },
  {
    path: ['repo', 'add'],
    summary: 'Add a project to Pebble by filesystem path',
    usage: 'pebble repo add --path <path> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'path']
  },
  {
    path: ['repo', 'show'],
    summary: 'Show one registered repo',
    usage: 'pebble repo show --repo <selector> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'repo']
  },
  {
    path: ['repo', 'set-base-ref'],
    summary: "Set the repo's default base ref for future worktrees",
    usage: 'pebble repo set-base-ref --repo <selector> --ref <ref> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'repo', 'ref']
  },
  {
    path: ['repo', 'search-refs'],
    summary: 'Search branch/tag refs within a repo',
    usage: 'pebble repo search-refs --repo <selector> --query <text> [--limit <n>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'repo', 'query', 'limit']
  },
  {
    path: ['worktree', 'list'],
    summary: 'List Pebble-managed worktrees',
    usage: 'pebble worktree list [--repo <selector>] [--limit <n>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'repo', 'limit']
  },
  {
    path: ['worktree', 'show'],
    summary: 'Show one worktree',
    usage: 'pebble worktree show --worktree <selector> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'worktree']
  },
  {
    path: ['worktree', 'current'],
    summary: 'Show the Pebble-managed worktree for the current directory',
    usage: 'pebble worktree current [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    notes: [
      'Resolves the current shell directory to a path: selector so agents can target the enclosing Pebble worktree without spelling out $PWD.'
    ],
    examples: ['pebble worktree current', 'pebble worktree current --json']
  },
  {
    path: ['worktree', 'create'],
    summary: 'Create a new Pebble-managed worktree',
    usage:
      'pebble worktree create --name <name> [--repo <selector>|--project <id> [--host <host-id>]|--project-host-setup <id>] [--agent <id>] [--prompt <text>] [--setup run|skip|inherit] [--base-branch <ref>] [--issue <number>] [--linear-issue <identifier-or-url>] [--comment <text>] [--parent-worktree <selector>] [--no-parent] [--run-hooks] [--activate] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'repo',
      'project',
      'host',
      'project-host-setup',
      'name',
      'agent',
      'prompt',
      'base-branch',
      'issue',
      'linear-issue',
      'comment',
      'setup',
      'parent-worktree',
      'no-parent',
      'run-hooks',
      'activate'
    ],
    notes: [
      'This creates a new checkout. For a fresh agent in an existing worktree, use `pebble terminal create --worktree active --command "codex"` instead.',
      'By default, Pebble records the new worktree as a child of the caller context when it can infer one from the Pebble terminal or current directory.',
      'If --repo is omitted, Pebble infers the repo from the current Pebble-managed worktree.',
      'Use --project with --host to create on a ready project host setup without spelling the backing repo id.',
      'For related work, use the inferred parent or pass --parent-worktree active, folder:<id>, or worktree:<id> to make the relationship explicit.',
      'Use --no-parent when the new worktree should be independent of the current context.',
      '--no-parent only affects Pebble lineage; omit --base-branch to use the repo default base, or pass the default base ref explicitly for independent top-level work.',
      'By default this creates the worktree and its first terminal without switching the active Pebble view.',
      'Pass --agent to launch an agent in the first terminal; --prompt sends initial work to that agent.',
      'Repo-defined setup hooks follow the repository setup policy; pass --setup run to force them.',
      'Pass --activate when the CLI caller intentionally wants to reveal the new worktree in the app.',
      'Passing --run-hooks is kept as a legacy alias for --setup run and reveals the worktree.'
    ],
    examples: [
      'pebble worktree create --name agent-task --agent codex --prompt "hi" --json',
      'pebble worktree create --repo id:<repoId> --name related-task --json',
      'pebble worktree create --project github:nebutra/pebble --host runtime:gpu --name benchmark --json',
      'pebble worktree create --repo id:<repoId> --name linear-task --linear-issue https://linear.app/nebutra/issue/NEB-335/test-issue --json',
      'pebble worktree create --repo id:<repoId> --name agent-task --agent codex --prompt "hi" --json',
      'pebble worktree create --repo id:<repoId> --name folder-child --parent-worktree folder:<folderId> --json',
      'pebble worktree create --repo id:<repoId> --name related-task --parent-worktree active --json',
      'pebble worktree create --repo id:<repoId> --name independent-task --no-parent --json'
    ]
  },
  {
    path: ['worktree', 'set'],
    summary: 'Update Pebble metadata for a worktree',
    usage:
      'pebble worktree set --worktree <selector> [--display-name <name>] [--issue <number|null>] [--linear-issue <identifier-or-url|null>] [--comment <text>] [--workspace-status <id>] [--parent-worktree <selector>|--no-parent] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'worktree',
      'display-name',
      'issue',
      'linear-issue',
      'comment',
      'workspace-status',
      'parent-worktree',
      'no-parent'
    ],
    notes: [
      'Workspace status ids match the board columns (defaults: todo, in-progress, in-review, completed); custom statuses use their configured id.',
      'Pass --linear-issue null to clear the Linear issue link.'
    ],
    examples: [
      'pebble worktree set --worktree active --linear-issue STA-335 --json',
      'pebble worktree set --worktree active --linear-issue null --json'
    ]
  },
  {
    path: ['worktree', 'rm'],
    summary: 'Remove a worktree from Pebble and git',
    usage: 'pebble worktree rm --worktree <selector> [--force] [--run-hooks] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'worktree', 'force', 'run-hooks'],
    notes: ['Repo-defined pebble.yaml archive hooks are skipped unless --run-hooks is passed.']
  },
  {
    path: ['worktree', 'ps'],
    summary: 'Show a compact orchestration summary across worktrees',
    usage: 'pebble worktree ps [--limit <n>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'limit']
  },
  {
    path: ['terminal', 'list'],
    summary: 'List live Pebble-managed terminals',
    usage: 'pebble terminal list [--worktree <selector>] [--limit <n>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'worktree', 'limit']
  },
  {
    path: ['terminal', 'show'],
    summary: 'Show terminal metadata and preview',
    usage: 'pebble terminal show [--terminal <handle>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'terminal']
  },
  {
    path: ['terminal', 'read'],
    summary: 'Read bounded terminal output',
    usage: 'pebble terminal read [--terminal <handle>] [--cursor <n>] [--limit <n>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'terminal', 'cursor', 'limit'],
    notes: [
      'Omit --terminal to target the active terminal in the current worktree.',
      'Use --cursor with the nextCursor value from a previous read to get only new output since that read.',
      'Use --limit to request more retained lines for long agent responses; output reports oldestCursor when older lines were dropped.',
      'Useful for capturing the response to a command: read before sending, then read --cursor <prev> after waiting.'
    ],
    examples: [
      'pebble terminal read --json',
      'pebble terminal read --terminal term_abc123 --cursor 42 --limit 1000 --json'
    ]
  },
  {
    path: ['terminal', 'send'],
    summary: 'Send input to a live terminal',
    usage:
      'pebble terminal send [--terminal <handle>] [--text <text>] [--enter] [--interrupt] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'terminal', 'text', 'enter', 'interrupt']
  },
  {
    path: ['terminal', 'wait'],
    summary: 'Wait for a terminal condition',
    usage:
      'pebble terminal wait [--terminal <handle>] --for exit|tui-idle [--timeout-ms <ms>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'terminal', 'for', 'timeout-ms']
  },
  {
    path: ['terminal', 'stop'],
    summary: 'Stop terminals for a worktree',
    usage: 'pebble terminal stop --worktree <selector> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'worktree']
  },
  {
    path: ['terminal', 'create'],
    summary: 'Create a terminal session in the current worktree',
    usage:
      'pebble terminal create [--worktree <selector>] [--title <name>] [--command <text>] [--focus] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'worktree', 'command', 'title', 'focus'],
    notes: [
      'Creates a visible terminal tab without switching focus when possible; falls back to a background handle if the UI cannot adopt it. Pass --focus to switch to it.',
      'Use this, not worktree create, for a fresh agent in the current checkout.'
    ],
    examples: [
      'pebble terminal create --json',
      'pebble terminal create --worktree active --command "codex" --json',
      'pebble terminal create --worktree path:/projects/myapp --title "RUNNER" --command "opencode"',
      'pebble terminal create --worktree path:/projects/myapp --command "opencode" --focus'
    ]
  },
  {
    path: ['terminal', 'switch'],
    summary: 'Switch to a terminal tab in the UI',
    usage: 'pebble terminal switch [--terminal <handle>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'terminal'],
    examples: ['pebble terminal switch --terminal term_abc123']
  },
  {
    path: ['terminal', 'focus'],
    summary: 'Switch to a terminal tab in the UI (alias for terminal switch)',
    usage: 'pebble terminal focus [--terminal <handle>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'terminal'],
    examples: ['pebble terminal focus --terminal term_abc123']
  },
  {
    path: ['terminal', 'close'],
    summary: 'Close a terminal tab (kills PTY if running)',
    usage: 'pebble terminal close [--terminal <handle>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'terminal'],
    examples: ['pebble terminal close --terminal term_abc123']
  },
  {
    path: ['terminal', 'rename'],
    summary: 'Set or clear the title of a terminal tab',
    usage: 'pebble terminal rename [--terminal <handle>] [--title <text>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'terminal', 'title'],
    notes: ['Omit --title or pass an empty string to reset to the auto-generated title.'],
    examples: [
      'pebble terminal rename --terminal term_abc123 --title "RUNNER"',
      'pebble terminal rename --terminal term_abc123 --json'
    ]
  },
  {
    path: ['terminal', 'split'],
    summary: 'Split an existing terminal pane',
    usage:
      'pebble terminal split [--terminal <handle>] [--direction horizontal|vertical] [--command <text>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'terminal', 'direction', 'command'],
    examples: [
      'pebble terminal split --terminal term_abc123 --direction horizontal --json',
      'pebble terminal split --terminal term_abc123 --command "codex"'
    ]
  }
]
