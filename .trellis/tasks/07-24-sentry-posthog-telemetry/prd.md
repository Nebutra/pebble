# Integrate PostHog and Sentry telemetry

## Goal

Give Pebble production-grade product analytics and error observability without
operating a dedicated telemetry backend. PostHog owns anonymous product usage;
Sentry owns desktop errors, crashes, startup performance, and release health.

## Background

- Product events already flow from the renderer through the Tauri command in
  `apps/desktop/src-tauri/src/commands/telemetry.rs` to PostHog.
- Pebble already persists bounded local crash records and lets users review,
  dismiss, copy, or submit them.
- Release builds already distinguish `stable` and `rc` and inject the PostHog
  project key through GitHub Actions.
- GitHub currently has no PostHog or Sentry secrets configured.
- The service consoles are not currently reachable through an automated browser
  session, so remote project creation may require a user login/2FA handoff.

## Requirements

### R1. Vendor responsibilities

- PostHog remains the only product analytics destination.
- Sentry is the only automatic error, crash, performance, and release-health
  destination.
- Pebble must not introduce a self-hosted telemetry collector or proxy.
- Full session replay is disabled.

### R2. Consent and privacy

- Automatic PostHog and Sentry delivery must honor the existing persisted
  telemetry preference, `DO_NOT_TRACK`, `PEBBLE_TELEMETRY_DISABLED`, and CI
  suppression.
- A user clicking Send on a crash report is a one-time explicit submission and
  remains available even when automatic telemetry is disabled.
- Automatic events must not include repository paths, terminal contents,
  prompts, source code, command output, account identity, or request bodies.
- Existing bounded breadcrumbs, redaction, dedupe, and rate/event budgets remain
  in force.
- GitHub identity is sent with a manual crash submission only when the user did
  not choose anonymous submission.

### R3. PostHog

- Preserve the current Rust-owned PostHog transport and renderer event allowlist.
- Release builds receive a PostHog project key through
  `PEBBLE_POSTHOG_WRITE_KEY`; local and unconfigured builds remain no-op.
- Configure a Pebble PostHog project with person profiles disabled for the
  existing anonymous install ID model.

### R4. Sentry runtime

- Initialize the official Rust Sentry SDK only in configured `stable` and `rc`
  builds, with release, distribution, platform, architecture, and environment.
- Do not install Sentry's automatic panic hook. Pebble's existing panic hook and
  local crash journal remain authoritative, then forward a sanitized event when
  automatic telemetry is enabled.
- Forward bounded React error-boundary, WebView-process, native process, and Rust
  panic reports to Sentry with stable grouping tags and parsed renderer frames.
- Record a sampled desktop-startup transaction and application release-health
  session while automatic telemetry is enabled.
- Flush queued events on normal application shutdown without delaying shutdown
  indefinitely.

### R5. Manual crash submission

- Keep the existing crash dialog, local history, sent/dismissed states, copyable
  report text, and duplicate-submission protection.
- Send the reviewed crash event and optional redacted diagnostic NDJSON directly
  to Sentry instead of `POST /v1/feedback`.
- Return a deterministic configuration or transport error when Sentry is absent
  or unavailable; do not mark the local report sent on failure.
- Ordinary user feedback and the standalone diagnostics preview/upload/delete
  workflow remain on their existing Pebble endpoints.

### R6. Release artifacts and credentials

- Renderer production builds generate hidden source maps, upload them to the
  matching Sentry release/distribution, and remove them before bundling.
- Release builds retain split native line-table debug information and upload
  debug files from each platform build to Sentry after bundling.
- `PEBBLE_SENTRY_DSN`, `PEBBLE_POSTHOG_WRITE_KEY`, `SENTRY_AUTH_TOKEN`,
  `SENTRY_ORG`, and `SENTRY_PROJECT` are provided by GitHub Actions secrets or
  variables without logging their values.
- Sentry's DSN and PostHog's project key may be compiled into clients; management
  API tokens must never be compiled into artifacts.

### R7. Operations and documentation

- Document the vendor split, consent behavior, release secrets, source-map/debug
  upload, quotas, and dashboard ownership in repository docs and Roadmap.
- Create/configure Pebble projects in PostHog and Sentry when authenticated
  console access is available.

## Acceptance Criteria

- [x] Automatic product events still reach only PostHog and preserve the event
      allowlist, anonymous install ID, consent checks, and event budgets.
- [x] Automatic Sentry capture is disabled by consent/environment/CI gates and
      can be enabled or disabled without restarting Pebble.
- [x] Rust panic, native process, WebView, and React boundary paths create local
      reports and produce sanitized Sentry events when enabled.
- [x] A manual crash submission succeeds through Sentry with an optional
      diagnostic attachment and no Pebble telemetry server dependency.
- [x] Startup performance uses the same release/distribution identifiers as
      uploaded artifacts; release-health sessions use the same release and
      environment because Sentry sessions have no distribution field.
- [x] Release CI uploads renderer source maps and native debug files, fails on a
      configured-but-incomplete Sentry setup, and never prints secret values.
- [ ] Focused Rust, renderer, workflow, release-script, typecheck, formatting,
      and diff checks pass.
- [ ] GitHub contains the required PostHog/Sentry configuration after the remote
      projects have been created.
- [x] Documentation clearly states remaining server-owned feedback/diagnostic
      responsibilities and does not claim that all support infrastructure was
      removed.

## Out Of Scope

- Session replay, autocaptured DOM interaction, user profiles, feature flags,
  experimentation, and broad automatic performance instrumentation.
- Replacing the normal feedback form or the independent reviewed diagnostic
  upload/delete workflow.
- Self-hosting PostHog, Sentry, or an observability proxy.
- Building production dashboards beyond documenting the initial recommended
  funnel, retention, error, and release-health views.
