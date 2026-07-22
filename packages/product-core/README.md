# Pebble Product Core

This package owns Pebble's canonical React renderer and the TypeScript contracts used by the
desktop, mobile, CLI, and remote runtime surfaces.

- `renderer/`: product UI shared by the Tauri desktop shell and web client
- `shared/`: cross-surface types and behavior
- `cli/`: Pebble CLI
- `relay/`: legacy Node relay pending full Go runtime retirement
- `agent-hooks/`: managed agent hook installers

Shipping desktop shell and native bridge code belongs in `apps/desktop`. Product Core must not
depend on an alternate desktop-shell implementation from its CLI, relay, or hook packages.
