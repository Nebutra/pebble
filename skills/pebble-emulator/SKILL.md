---
name: pebble-emulator
description: >-
  Control a mobile (iOS) emulator / simulator stream from inside Pebble using the `pebble` CLI. Use for taps, gestures, typing, hardware buttons, camera injection, permissions, accessibility tree, and more — all while seeing the live view in Pebble's emulator pane. Prefer this over raw `npx serve-sim` or direct simctl when running agents inside Pebble (the pebble surface handles device scoping, helper lifecycle, and worktree context). Complements the pebble-cli skill for terminals, worktrees, and the built-in browser.
---

# pebble-emulator

This is a discovery stub. Pebble keeps the full guide with the installed CLI so
the instructions cannot drift from the binary that will execute them.

Resolve the executable once for this session. Use the value of
`PEBBLE_CLI_COMMAND` when it is set, use `pebble-dev` inside a Pebble source
checkout, and otherwise use `pebble`. Reuse that executable for every command;
do not silently fall through to another build after an error.

Before using this skill, run:

```text
PEBBLE skills get pebble-emulator
```

Here `PEBBLE` is a placeholder for the executable selected above, not a shell
variable. Read the returned version-matched guide before choosing subcommands or
flags, and prefer `--json` for agent-driven calls when the command supports it.

If the selected binary explicitly reports that `skills get` is unknown, report
that the installed Pebble predates bundled guides. Do not guess a newer command
surface or switch binaries automatically.
