# Product Origin

## Scenario: Pebble Canonical Web Origin

### 1. Scope / Trigger

- Trigger: changing product, docs, download, changelog, media, diagnostics,
  feedback, privacy, or release-note URLs in runtime code, workflows, mobile,
  renderer/shared packages, package metadata, or public documentation.
- The canonical origin is `https://pebble.nebutra.com`; product routes do not
  use the former `/pebble` path prefix.

### 2. Signatures

- Changelog: `GET https://pebble.nebutra.com/whats-new/changelog.json`.
- Nudge feed: `GET https://pebble.nebutra.com/whats-new/nudge.json`.
- Media: `GET https://pebble.nebutra.com/media/*`.
- Diagnostics token: `POST https://pebble.nebutra.com/diagnostics/token`
  with JSON `{"bundle_submission_id":"<id>","bytes":<integer>}`; response
  JSON is `{"token":"<bearer>","upload_url":"https://pebble.nebutra.com/diagnostics/upload","max_bytes":4194304}`.
- Diagnostics upload: `POST https://pebble.nebutra.com/diagnostics/upload`
  with `Authorization: Bearer <token>`,
  `Content-Type: application/x-ndjson`, exact `Content-Length`, and the NDJSON
  bundle body; response JSON is `{"ticket_id":"<ticketId>"}`.
- Diagnostics deletion:
  `POST https://pebble.nebutra.com/diagnostics/delete/:ticketId` with `{}`.
- Feedback and crash reports: `POST https://pebble.nebutra.com/v1/feedback`.
- Public docs: `https://pebble.nebutra.com/docs/*`.

### 3. Contracts

- GitHub Releases, tags, updater assets, and `releases.atom` remain under
  `https://github.com/nebutra/pebble`.
- Runtime constants, release workflow environment, mobile links,
  renderer/shared links, Homebrew metadata, and README variants use the same
  canonical origin.
- Legacy product origins may appear only in ROADMAP compatibility guidance, not
  in shipping source, public links, or code-spec examples.
- CDN/edge owns the product root, download, docs, privacy, changelog pages,
  changelog/nudge JSON, and media. A Nebutra-owned API service owns diagnostics
  and feedback; one service is sufficient and no microservice split is required.
- Human-facing GET pages may redirect at the edge. Machine JSON, media,
  diagnostics, and feedback routes must return their final response without a
  redirect. Legacy compatibility may use mirroring or an internal reverse proxy.
- A server-issued diagnostics upload URL must use HTTP(S), remain HTTPS when
  the token endpoint is HTTPS, and have the same host and effective port as the
  token endpoint. The desktop rejects cross-host upload URLs.
- Diagnostic NDJSON is redacted before upload and may not exceed the client or
  server-issued 4 MiB cap. The upload response's `ticket_id` becomes the
  renderer-facing `ticketId` used by the deletion workflow.
- The feedback handler accepts JSON feedback with
  `submissionType: "feedback"`, JSON crash reports with
  `submissionType: "crash"`, and multipart crash submissions when
  `diagnosticBundleFile` is attached. Optional identity and diagnostic contents
  remain private support data and must not be copied into public trackers,
  analytics, or unredacted access logs.
- Current clients remain path-based on `pebble.nebutra.com`. Deploy
  `status.pebble.nebutra.com` and `staging.pebble.nebutra.com`; reserve `app`,
  `cloud`, `relay`, `telemetry`, `assets`, and optional `api` subdomains under
  `pebble.nebutra.com` without moving current routes implicitly.
- Minimum production ownership is CDN/edge, one API service, managed Postgres,
  private object storage, isolated staging, monitoring, and an independently
  reachable status page. Release artifacts remain GitHub-owned.
- Unless an approved operating policy replaces them, baseline operations use a
  10-minute diagnostic token, 4 MiB cap, and 30-day retention; enforce rate and
  body limits, redacted logs, deletion across records/objects/backups, tested
  backups and point-in-time recovery, privacy/telemetry consent, support access
  control, incident response, and data-subject request handling.
- Hosted web client, cloud account/control plane, managed server, relay/tunnel,
  APNs/FCM, billing/licensing, and team/admin/audit are ecosystem-completion
  milestones, but they do not block the first desktop public release.

### 4. Validation & Error Matrix

- Legacy origin in shipping source/public docs -> fail the product URL residue
  check and update the caller to the canonical origin.
- Canonical origin followed by a repeated product path segment -> fail; remove
  the stale path prefix.
- GitHub updater/release URL moved to the product origin -> fail; signed release
  artifacts remain GitHub-owned.
- Machine endpoint implemented only as a redirect -> deployment is not ready.
- Diagnostics token requested with `GET` -> fail; the desktop sends JSON with
  `POST`.
- Token response issues a cross-host upload URL or a cap above policy -> reject
  the response or block deployment.
- Feedback/crash data lands in public or PII-unsafe storage/logging -> block
  deployment.
- DNS/TLS route unavailable -> block public release; do not add a client-side
  legacy fallback.

### 5. Good/Base/Bad Cases

- Good: new clients request canonical machine endpoints directly while legacy
  origins reverse-proxy them for one complete desktop/mobile release cycle.
- Base: public docs and download links resolve directly on the product origin.
- Good: token, upload, deletion, and feedback share the canonical public host
  while edge routing forwards dynamic requests internally to the API service.
- Bad: redirecting `POST /v1/feedback` and assuming every client preserves the
  request body or authorization headers.
- Bad: returning an object-storage presigned URL on a different host; the
  current client intentionally rejects it.
- Bad: restoring the `/pebble` path prefix on the dedicated product subdomain.

### 6. Tests Required

- `updater-changelog-selection.test.ts`: canonical product changelog URLs map to
  the matching GitHub release tag.
- `tauri-release-workflow.test.mjs`: diagnostics compilation uses the canonical
  token endpoint.
- Runtime and renderer/mobile focused tests assert canonical changelog, media,
  feedback, docs, privacy, and product URLs.
- `verify-tauri-mainline.mjs` pins changelog/nudge, feedback/crash,
  diagnostics token/upload/delete, Homebrew, and release-note contracts.
- `diagnostics.rs` tests pin `POST` token/upload/delete behavior, same-host URL
  validation, the 4 MiB cap, bearer NDJSON headers, and ticket response parsing.
- Feedback and crash-report tests pin JSON feedback/crash bodies, multipart
  crash diagnostics, anonymity, redaction, and field/body limits.
- Residue scans require legacy origins only in ROADMAP and reject a canonical
  origin followed by `/pebble`; run relevant lint/typecheck and
  `git diff --check`.

### 7. Wrong vs Correct

#### Wrong

```ts
const DOCS_URL = 'https://legacy.example/pebble/docs'
```

#### Correct

```ts
const DOCS_URL = 'https://pebble.nebutra.com/docs'
```

The dedicated host is the product namespace, so retaining `/pebble` creates a
second, drift-prone routing convention.
