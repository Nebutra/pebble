# Telemetry Operations

Pebble uses vendor-hosted observability and does not require a Pebble-owned
telemetry ingestion service.

## Service ownership

| Concern | Owner | Initial configuration |
| --- | --- | --- |
| Anonymous product events, funnels, retention | PostHog Cloud | US project, person profiles disabled |
| Desktop errors and crash issues | Sentry Cloud | Rust project `pebble-desktop` |
| Startup performance and release health | Sentry Cloud | 5% startup trace sample, application sessions |
| Session replay | None | Disabled; no renderer replay SDK is bundled |
| Ordinary user feedback | Platform API | `POST https://api.nebutra.com/pebble/v1/feedback` |
| Reviewed standalone diagnostic uploads | Pebble API and private storage | `/diagnostics/token`, `/upload`, and `/delete/:ticketId` |

`telemetry.pebble.nebutra.com` remains reserved for a future first-party proxy or
self-hosted migration. No DNS record or server is required for the current
PostHog/Sentry deployment.

## Project setup

Create these production projects:

- PostHog project name: `Pebble Production` in the US region. Copy its project
  key, keep person profiles disabled, and do not enable autocapture or replay.
- Sentry project: platform Rust, project name `Pebble Desktop`, recommended slug
  `pebble-desktop`. Keep default PII disabled and do not enable replay.

Use one Sentry project for macOS, Windows, and Linux. Events carry platform,
architecture, channel, app version, and distribution tags; separate projects
would make cross-platform release health and issue comparison harder.

## GitHub configuration

Repository secrets:

- `PEBBLE_POSTHOG_WRITE_KEY`: PostHog project key used only by stable/RC builds.
- `PEBBLE_SENTRY_DSN`: public Sentry DSN compiled into stable/RC clients.
- `SENTRY_AUTH_TOKEN`: organization token with project/release write access for
  source-map and debug-file upload. It is CI-only and must not enter artifacts.

Repository variables:

- `SENTRY_ORG`: Sentry organization slug.
- `SENTRY_PROJECT`: `pebble-desktop` unless the created project uses another slug.

The release workflow blocks stable and RC builds when either vendor or any
required Sentry upload credential is missing. It reports variable names only,
never values.

## Runtime privacy contract

Automatic PostHog and Sentry delivery share the existing Pebble telemetry
preference and are suppressed by user opt-out, `DO_NOT_TRACK`,
`PEBBLE_TELEMETRY_DISABLED`, and CI detection.

Automatic events exclude repository paths, prompts, terminal contents, source
code, command output, request bodies, and account identity. Sentry receives only
bounded crash metadata and the already-sanitized breadcrumb allowlist.

The crash dialog's Send action is separate, explicit consent. It can send a
reviewed crash and optional redacted NDJSON attachment directly to Sentry even
when automatic telemetry is off. GitHub login/email is included only when the
user leaves anonymous submission disabled.

## Release artifacts

Release identity is `pebble@<version>`. Distribution identity is
`<stable-or-rc>-<target-triple>`.

- Vite emits hidden renderer source maps only for configured stable/RC builds.
- Postbuild uploads minified files and maps with the matching release/dist, then
  deletes every `.map` before Tauri packages the renderer.
- Cargo release builds retain split line-table debug information.
- Each platform runner uploads debug files only from its explicit Cargo target
  release directory.

Source maps and debug uploads are CI-owned build artifacts, not user telemetry.
They may contain Pebble source metadata needed for symbolication, remain private
to the Sentry project, and must follow its project-access and retention policy.

Sentry release-health sessions carry release and environment. Sentry's session
protocol does not carry a distribution; target-specific distribution is present
on error events, startup transactions, source maps, and native debug files.

The first RC after configuration must prove a React boundary event resolves to
original TypeScript and a native event resolves through the uploaded debug file.

## Initial dashboards and alerts

PostHog:

- New-user activation funnel based on the existing typed events.
- D1/D3/D7 return behavior using `app_opened` and the rollout boundaries in
  `telemetry-availability.md`.
- Release/channel event-volume and invalid-property monitoring.

Sentry:

- Unresolved desktop errors by release, platform, and channel.
- Application sessions, error-associated sessions, and regressions for stable
  versus RC.
- `pebble.desktop.startup` p50/p95 by platform and release.
- Alerts for a new fatal issue, an issue marked regression, and a material
  session-health drop. Route alerts to the engineering incident channel, not
  end users.

## Quota budget

Vendor pricing must be rechecked before launch. As of 2026-07-24, the planning
baseline is PostHog's first 1,000,000 product events per month and Sentry
Developer's 5,000 errors, 5,000,000 spans, and 50 replays. Pebble does not use
the replay allowance. The 5% startup trace sample and existing PostHog event
budgets are the initial free-tier controls.

Review usage weekly during RC rollout. Prefer lowering trace sampling, tightening
duplicate grouping, or removing low-value product events before buying capacity;
never silently drop crash classes or weaken privacy filters to manage quota.

## RC rollout checklist

1. Confirm GitHub preflight recognizes all five service values without printing
   them.
2. Release one RC and confirm PostHog receives `app_opened` with the RC channel.
3. Trigger a synthetic renderer failure and verify TypeScript symbolication.
4. Trigger a synthetic native test event and verify debug-file recognition.
5. Confirm startup transaction and release-health session counts.
6. Opt out, relaunch, and confirm no automatic events are delivered.
7. Submit one anonymous reviewed crash with diagnostics and verify the Sentry
   attachment contains redacted NDJSON.
8. Promote the same configuration to stable only after all checks pass.
