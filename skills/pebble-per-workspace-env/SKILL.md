---
name: pebble-per-workspace-env
description: >-
  Set up, review, debug, or validate Pebble per-workspace environment recipes — on-demand, disposable runtimes (cloud sandboxes, VMs, or local) created fresh for each workspace. Covers first-time setup (provider prerequisites, the reusable base snapshot, the coding-agent auth snapshot, credentials, and state), not just the per-workspace lifecycle scripts. Use to stand up per-workspace environments, fix an `environmentRecipes` entry in `pebble.yaml`, scaffold provider lifecycle scripts, or resolve an `pebble vm recipe doctor` failure.
---

# pebble-per-workspace-env

This is a discovery stub. Pebble keeps the full guide with the installed CLI so
the instructions cannot drift from the binary that will execute them.

Resolve the executable once for this session. Use the value of
`PEBBLE_CLI_COMMAND` when it is set, use `pebble-dev` inside a Pebble source
checkout, and otherwise use `pebble`. Reuse that executable for every command;
do not silently fall through to another build after an error.

Before using this skill, run:

```text
PEBBLE skills get pebble-per-workspace-env
```

Here `PEBBLE` is a placeholder for the executable selected above, not a shell
variable. Read the returned version-matched guide before choosing subcommands or
flags, and prefer `--json` for agent-driven calls when the command supports it.

If the selected binary explicitly reports that `skills get` is unknown, report
that the installed Pebble predates bundled guides. Do not guess a newer command
surface or switch binaries automatically.
