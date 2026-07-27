---
name: orchestration
description: >-
  Use Pebble orchestration for structured multi-agent coordination: threaded messages, blocking ask/reply flows, task dispatch, worker_done/escalation waits, task DAGs, decision gates, coordinator loops, or decomposing work across agents. Use `pebble-cli` instead for full ownership handoffs, including requests phrased as "hand off", "handoff", "handover", "give this to another agent", or "another worktree" when the user did not explicitly ask to supervise, monitor, wait for results, or coordinate a DAG. Use `pebble-cli` for ordinary terminal control, lightweight terminal prompts, shell commands, Pebble worktree management, reading or waiting on terminals, and automation of the browser embedded inside Pebble. Use Computer Use for browser windows, webviews, Pebble app UI, or desktop UI outside Pebble's embedded browser.
---

# orchestration

This is a discovery stub. Pebble keeps the full guide with the installed CLI so
the instructions cannot drift from the binary that will execute them.

Resolve the executable once for this session. Use the value of
`PEBBLE_CLI_COMMAND` when it is set, use `pebble-dev` inside a Pebble source
checkout, and otherwise use `pebble`. Reuse that executable for every command;
do not silently fall through to another build after an error.

Before using this skill, run:

```text
PEBBLE skills get orchestration
```

Here `PEBBLE` is a placeholder for the executable selected above, not a shell
variable. Read the returned version-matched guide before choosing subcommands or
flags, and prefer `--json` for agent-driven calls when the command supports it.

If the selected binary explicitly reports that `skills get` is unknown, report
that the installed Pebble predates bundled guides. Do not guess a newer command
surface or switch binaries automatically.
