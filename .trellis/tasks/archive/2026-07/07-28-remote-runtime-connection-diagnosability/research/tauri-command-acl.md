# Research: Tauri capability / ACL requirements for a new command

- **Query**: what must be declared in `gen/schemas/*.json` / capability files for a new command to be callable from the renderer?
- **Scope**: internal (repo config + vendored `tauri 2.11.5` source)
- **Date**: 2026-07-28

## Answer

**Nothing.** App-defined `#[tauri::command]` functions registered through `generate_handler!` need **no capability entry, no permission file, and no `gen/schemas` regeneration** — as long as (a) the app does not define its own ACL manifest and (b) the invoke originates from a local (bundled) origin. Both hold for this repo.

## Findings

### Files Found

| File Path | Description |
|---|---|
| `apps/desktop/src-tauri/capabilities/main.json` | The single capability file (`identifier: "main-window"`), windows/webviews `["main","optimized"]` |
| `apps/desktop/src-tauri/gen/schemas/acl-manifests.json` | Generated; top-level keys are `core`, `core:app`, `core:event`, `core:image`, `core:menu`, `core:path`, `core:resources`, `core:tray`, `core:webview`, `core:window`, `deep-link`, `notification`, `process`, `updater` |
| `apps/desktop/src-tauri/gen/schemas/capabilities.json` | Generated capability set |
| `apps/desktop/src-tauri/gen/schemas/{desktop,macOS,windows}-schema.json` | Generated JSON Schemas for capability authoring |
| `apps/desktop/src-tauri/src/main.rs:339-341` | Where `runtime_environments_*` are registered in `invoke_handler` |

`grep -c runtime_environments apps/desktop/src-tauri/gen/schemas/*.json` → **0 in every file**. None of the ~20 existing app commands appear in the ACL artifacts. That is the empirical proof.

`apps/desktop/src-tauri/permissions/` **does not exist**, so there is no app-level ACL manifest.

### Why, from the Tauri source

`tauri-2.11.5/src/webview/mod.rs`, in the invoke path (~`:1794-1830`):

```rust
let (resolved_acl, has_app_acl_manifest) = {
    let runtime_authority = manager.runtime_authority.lock().unwrap();
    let acl = runtime_authority.resolve_access(&request.cmd, /* window */, /* webview */, &acl_origin);
    (acl, runtime_authority.has_app_manifest())
};
…
let plugin_command = request.cmd.strip_prefix("plugin:").map(…);

// Check ACL on plugin commands, when the app defined its ACL manifest,
// or when the request comes from a non-local (remote) origin.  This
// ensures remote content can never reach custom commands unless an
// explicit `remote` capability has been configured for them.
if (plugin_command.is_some() || has_app_acl_manifest || !is_local)
    && request.cmd != FETCH_CHANNEL_DATA_COMMAND
    && invoke.acl.is_none()
{
    /* reject */
}
```

So the gate fires only when at least one of these is true:

1. The command name starts with `plugin:` — app commands don't.
2. `has_app_acl_manifest()` — true only when the generated ACL contains `APP_ACL_KEY = "__app-acl__"` (`tauri-utils-2.9.3/src/acl/mod.rs:50, :349`), which is produced when `src-tauri/permissions/` exists. It doesn't here.
3. The webview origin is remote. Pebble loads `frontendDist: "../dist"` in production and `devUrl: "http://127.0.0.1:5174"` in dev (`tauri.conf.json`), both treated as local.

`has_app_manifest()` is `tauri-2.11.5/src/ipc/authority.rs:132-134`; `resolve_access` is `:439-469`.

### What the existing capability file *is* for

`capabilities/main.json` lists only `core:*` and plugin permissions (`notification:default`, `process:default`, `updater:default`, `deep-link:default`). Those are the things that genuinely need declaring. Adding a new app command changes none of it.

### Checklist for adding `runtime_environments_update_endpoint` (or similar)

1. Write the `#[tauri::command] pub fn …` in `apps/desktop/src-tauri/src/commands/runtime_environments.rs`.
2. Add it to `tauri::generate_handler![…]` in `apps/desktop/src-tauri/src/main.rs` — next to line 340.
3. Call it from the renderer with `invoke('runtime_environments_update_endpoint', { input: { … } })`.
4. **Do not** touch `capabilities/main.json` or anything under `gen/schemas/`.

`gen/schemas/*` regenerate on build and are currently showing as modified in `git status` — that's incidental churn from the build, not something this task needs to drive.

### Argument-shape convention in this repo

Every runtime-environment command takes a single `input:` object deserialized into a `#[serde(rename_all = "camelCase")]` struct — e.g. `RuntimeEnvironmentSelectorInput` (`runtime_environments.rs:45-49`). The renderer mirrors it: `invoke('runtime_environments_resolve', { input: { selector } })` (`apps/desktop/src/pebble-tauri-runtime-control-api.ts:251-254`). Follow that shape.

### Where the renderer contract lives

- Type: `packages/product-core/shared/preload-api-types.ts:2481-2516` (`PreloadApi['runtimeEnvironments']`)
- Tauri impl: `apps/desktop/src/pebble-tauri-runtime-control-api.ts:241-297` (`createPebbleRuntimeEnvironmentsApi`)
- Web impl: `packages/product-core/renderer/src/web/web-preload-api.ts:1083` (`addFromPairingCode` and siblings)

A new command can also be invoked *raw* without touching `PreloadApi` — that is what `apps/desktop/src/tauri-ephemeral-vm-api.ts:218` does for `runtime_environments_update_pairing_code`. But a settings-UI affordance shared with the web build should go through `PreloadApi` so the web target gets a compile error rather than a runtime one.

## Caveats / Not Found

- Behavior verified against `tauri 2.11.5` in the local cargo registry; `Cargo.toml` pins `tauri = { version = "2", … }`, so a future minor could tighten this. The source comment ("Check ACL on plugin commands, when the app defined its ACL manifest, or when the request comes from a non-local origin") plus the `// TODO: Remove this special check in v3` marker nearby suggests the app-command exemption is intentional through v2 and may change in v3.
- If the app ever adds `src-tauri/permissions/`, **every** app command would suddenly need an ACL entry. Worth a note in the design doc.
