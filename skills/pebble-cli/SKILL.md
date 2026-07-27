---
name: pebble-cli
description: >-
  Use the public `pebble` CLI to operate Pebble-managed worktrees, folder contexts, terminals, repos, automations, worktree comments, and the browser embedded inside the Pebble app. Use when the user says "$pebble-cli", "use pebble cli", "Pebble worktree", "child worktree", "cardStatus", "spawn codex/claude in a worktree", "read/wait/send Pebble terminal", "terminal send", "full handoff", "handover", "give this to another agent", "another worktree", "Pebble browser", or "control the browser inside Pebble". Prefer this over raw `git worktree`, ad hoc PTYs, Playwright, or Computer Use when the task touches Pebble-managed state. Use Computer Use for browser windows, webviews, or desktop UI outside Pebble's embedded browser.
---

# pebble-cli

This is a discovery stub. Pebble keeps the full guide with the installed CLI so
the instructions cannot drift from the binary that will execute them.

Resolve the executable once for this session. Use the value of
`PEBBLE_CLI_COMMAND` when it is set, use `pebble-dev` inside a Pebble source
checkout, and otherwise use `pebble`. Reuse that executable for every command;
do not silently fall through to another build after an error.

Before using this skill, run:

```text
PEBBLE skills get pebble-cli
```

Here `PEBBLE` is a placeholder for the executable selected above, not a shell
variable. Read the returned version-matched guide before choosing subcommands or
flags, and prefer `--json` for agent-driven calls when the command supports it.

If the selected binary explicitly reports that `skills get` is unknown, report
that the installed Pebble predates bundled guides. Do not guess a newer command
surface or switch binaries automatically.
