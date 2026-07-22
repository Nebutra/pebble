# Native and renderer E2E

Desktop lifecycle evidence is owned by the Tauri functional shell. Run
`pnpm verify:tauri-real-runtime`; on Linux, wrap it with
`xvfb-run --auto-servernum dbus-run-session --`.

The functional gate builds an isolated profile and repository, exercises the
real Go sidecar and Tauri commands, and tears down the complete process tree.
Do not reuse a developer profile or assume a hidden WebView behaves the same
as a visible window. Renderer-only Playwright specs must use the browser
harness and typed mock bridge once classified there.

Terminal visual evidence is produced by
`node config/scripts/run-tauri-terminal-evidence.mjs --mode golden`. Refresh
evidence from Tauri only; release jobs must never launch a second desktop shell
as their comparison oracle.
