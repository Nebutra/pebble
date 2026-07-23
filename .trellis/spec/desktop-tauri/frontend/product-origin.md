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
- Diagnostics token: `GET https://pebble.nebutra.com/diagnostics/token`.
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
- Human-facing GET pages may redirect at the edge. JSON, media, diagnostics,
  and feedback routes must be mirrored or reverse-proxied during migration;
  clients must not depend on redirects preserving methods, bodies, or headers.

### 4. Validation & Error Matrix

- Legacy origin in shipping source/public docs -> fail the product URL residue
  check and update the caller to the canonical origin.
- Canonical origin followed by a repeated product path segment -> fail; remove
  the stale path prefix.
- GitHub updater/release URL moved to the product origin -> fail; signed release
  artifacts remain GitHub-owned.
- Machine endpoint implemented only as a redirect -> deployment is not ready.
- DNS/TLS route unavailable -> block public release; do not add a client-side
  legacy fallback.

### 5. Good/Base/Bad Cases

- Good: new clients request canonical machine endpoints directly while legacy
  origins reverse-proxy them for one complete desktop/mobile release cycle.
- Base: public docs and download links resolve directly on the product origin.
- Bad: redirecting `POST /v1/feedback` and assuming every client preserves the
  request body or authorization headers.
- Bad: restoring the `/pebble` path prefix on the dedicated product subdomain.

### 6. Tests Required

- `updater-changelog-selection.test.ts`: canonical product changelog URLs map to
  the matching GitHub release tag.
- `tauri-release-workflow.test.mjs`: diagnostics compilation uses the canonical
  token endpoint.
- Runtime and renderer/mobile focused tests assert canonical changelog, media,
  feedback, docs, privacy, and product URLs.
- `verify-tauri-mainline.mjs` pins changelog/nudge, feedback/crash,
  diagnostics, Homebrew, and release-note contracts.
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
