# Upstream semantic sync

Pebble tracks a retired upstream project semantically rather than cherry-picking its
Electron implementation. The pipeline records source evidence, classifies architectural
risk, and maintains review issues. It never merges code automatically.

## Bundled skills

The eight canonical full guides live in `skill-guides/`. Installed skill packages under
`skills/` contain discovery stubs. The installed CLI returns the full guide that belongs
to its bundled release:

```text
pebble skills get pebble-cli
pebble skills get --json computer-use
```

After changing a guide, regenerate and verify checked-in artifacts:

```text
node config/scripts/generate-bundled-skill-guides.mjs --write
node config/scripts/generate-bundled-skill-guides.mjs
pnpm exec vitest run --config config/vitest.config.ts config/scripts/generate-bundled-skill-guides.test.mjs
```

The generator owns the installable stubs, skill manifests, revision snapshots, release
mapping, and Go source used for offline retrieval. Do not edit generated files directly.

## Local upstream audit

Use an existing upstream git clone when available:

```text
node config/scripts/upstream-semantic-sync.mjs \
  --repo /path/to/upstream-clone \
  --output-dir artifacts/upstream-semantic-sync
```

Use `--fetch` to create a temporary partial clone from the neutral repository metadata in
`config/upstream-sync/state.json`. Override `--from` or `--to` to review a specific range.
The command writes `report.json` and `report.md`; it does not require GitHub credentials.

The checked-in checkpoint advances only after maintainers have reviewed or implemented the
range and updated `lastAudited`. A failed report or issue publication must not advance it.

## Automation

`.github/workflows/upstream-semantic-sync.yml` runs twice weekly and on demand. It generates
an artifact and creates or updates one canonical issue per audited range using a hidden
stable marker. Publication lists open sync issues once and then performs only the required
create/update call to conserve API quota.

High-risk desktop-host, preload, daemon, relay, and runtime changes always require a manual
Go/Tauri semantic port. Draft PR generation is intentionally disabled until an allow-list
of deterministic transformations is reviewed. Auto-merge is not part of this pipeline.

## Mention safety

Anything written into a sync issue must be mention-safe. GitHub treats `@token` as a
notification, not as an inert citation, so a pasted upstream changelog pages contributors
who never opted into this fork. Pebble is an independent product; upstream authors are not
reviewers here and must not be summoned into these threads.

Rules for anyone — human or agent — filing or updating a sync issue:

- Attribute with a plain username or a link, never `@handle`: write `by someone in
  <pull-request-url>`, not `by @someone in ...`.
- Prefer linking a compare, release, or pull-request URL over pasting a whole
  "What's Changed" block, which is where handles arrive in bulk.
- Cross-repository issue references need the full `owner/repo#123` form. A bare `#123`
  resolves against Pebble and silently points at the wrong thing.
- Scoped package names keep their `@` but belong in a code span: `` `@scope/pkg` ``.
  Bare, they render as an organisation mention.

`neutralizeMentions` in `config/scripts/publish-upstream-semantic-issue.mjs` enforces this
for the automated path, because upstream commit subjects carry both handles and scoped
package names. It cannot cover text written by hand — that part is a review obligation.
