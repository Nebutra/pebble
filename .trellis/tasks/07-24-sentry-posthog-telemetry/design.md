# Sentry and PostHog telemetry design

## Architecture

PostHog and Sentry remain separate trust and data planes.

```text
typed product events -> Tauri telemetry command -> PostHog capture API

local crash sources -> Pebble crash journal -> Sentry reporting adapter
                                              |-> automatic gated event
                                              `-> explicit reviewed submission

release build -> hidden renderer source maps -> Sentry artifact upload
              `-> split native debug files  -> Sentry debug-file upload
```

The renderer does not embed either vendor SDK. Product event validation stays in
Rust. Renderer errors already cross a typed Tauri command, so Rust can normalize
them into Sentry protocol events while keeping one consent owner and one SDK
client in the process tree.

## Runtime boundaries

### Consent owner

`commands::telemetry` remains the source of truth for effective automatic
telemetry consent. It exposes a narrow internal query and notifies the Sentry
runtime after successful opt-in/acknowledge persistence or before opt-out
completion. `DO_NOT_TRACK`, `PEBBLE_TELEMETRY_DISABLED`, and CI always win.

Manual crash submission bypasses the automatic-capture flag because the Send
action is explicit, scoped consent. It still requires a configured Sentry DSN.

### Sentry client

A focused `commands::sentry_reporting` module owns:

- SDK initialization and shutdown guard;
- configured release/environment/distribution metadata;
- the atomic automatic-capture state;
- release-health session and startup transaction lifecycle;
- sanitized event construction, renderer stack parsing, attachments, and flush.

The SDK is compiled without its panic integration. Pebble's existing panic hook
continues to persist the local report first and then calls the adapter. This
prevents two competing panic hooks and preserves recovery behavior.

### Error capture

- Rust panic: stable exception type, sanitized panic message, thread/location
  tags, SDK-attached native stack, and existing bounded context.
- Native/runtime/WebView failure: source/process/reason tags plus bounded detail
  context from the local `CrashReportRecord`.
- React boundary: exception type/message and a parsed V8/WebKit stack. Unknown
  stack lines are retained as bounded extra text rather than guessed frames.
- Breadcrumbs: translate only the already-sanitized local breadcrumb ring.

Every event uses `pebble@<app-version>` as release and the release workflow's
explicit `<channel>-<target-triple>` distribution. Grouping is based on crash
source, process type, reason, and boundary ID rather than install identity.

### Manual submission and attachments

`crash_reports_submit` keeps the existing state machine. It builds the reviewed
report and optional redacted NDJSON exactly as today, then gives both to the
Sentry adapter. The adapter uses an isolated scope so optional identity and the
attachment cannot leak into later automatic events. The local report becomes
`sent` only after the SDK accepts and flushes the event within a bounded timeout.

Normal sidebar feedback continues to call `/v1/feedback`. Independent diagnostic
preview/upload/delete continues to use the documented Pebble API. Only the crash
submission branch moves to Sentry.

## Performance and release health

When automatic telemetry becomes enabled, start one application session and a
sampled `pebble.desktop.startup` transaction. Finish the transaction at Tauri's
Ready event and end the session on a clean exit or opt-out. The initial trace
sample rate is intentionally low and configured in code; no broad command or DOM
auto-instrumentation is added in this task.

## Build and CI

The release workflow passes public runtime configuration to the Tauri build:

- `PEBBLE_SENTRY_DSN`
- `PEBBLE_SENTRY_DIST`
- existing `PEBBLE_BUILD_IDENTITY`
- existing `PEBBLE_POSTHOG_WRITE_KEY`

Renderer production builds emit hidden source maps only when Sentry release
credentials are complete. A Node release helper invokes the repository-local
Sentry CLI, uploads with the matching release/distribution, and deletes `.map`
files before Tauri packages `dist`.

Cargo release profiles retain split line-table debug information. After each
matrix build, a second helper asks Sentry CLI to scan the relevant target release
directory and upload supported debug files. Missing management credentials on a
configured release build are fatal; local builds remain no-op.

## Compatibility

- All runtime behavior is platform-neutral; platform metadata comes from Rust
  constants and the explicit target triple.
- SSH workflows are unaffected because telemetry never assumes a local project
  path and does not capture remote command content.
- GitHub is only the current release CI host. Runtime event contracts and error
  metadata contain no GitHub-only review semantics.
- Unconfigured development and test builds perform no network delivery.

## Rollout and rollback

Roll out first to an RC release, verify one synthetic renderer event, one native
event, startup transaction, session health, source-map symbolication, and native
debug-file recognition, then promote the same configuration to stable.

Rollback is configuration-first: remove the DSN/project key secrets to compile
no-op transports. Code rollback is isolated to the Sentry adapter, crash-submit
transport call, release helpers, dependency/profile entries, and workflow env.
Local crash persistence and PostHog remain usable independently.
