---
name: pebble-emulator-android
description: >-
  Control an Android emulator / device from inside Pebble using the `pebble` CLI. Use for listing/booting AVDs, taps, swipes, typing, hardware buttons (incl. Back and Recents), rotation, app install/launch, runtime permissions, the accessibility tree, and logcat — driving a real adb-connected device or emulator. Cross-platform (Windows, Linux, macOS). Complements the pebble-emulator (iOS) and pebble-cli skills.
---

# pebble-emulator-android

This is a discovery stub. Pebble keeps the full guide with the installed CLI so
the instructions cannot drift from the binary that will execute them.

Resolve the executable once for this session. Use the value of
`PEBBLE_CLI_COMMAND` when it is set, use `pebble-dev` inside a Pebble source
checkout, and otherwise use `pebble`. Reuse that executable for every command;
do not silently fall through to another build after an error.

Before using this skill, run:

```text
PEBBLE skills get pebble-emulator-android
```

Here `PEBBLE` is a placeholder for the executable selected above, not a shell
variable. Read the returned version-matched guide before choosing subcommands or
flags, and prefer `--json` for agent-driven calls when the command supports it.

If the selected binary explicitly reports that `skills get` is unknown, report
that the installed Pebble predates bundled guides. Do not guess a newer command
surface or switch binaries automatically.
