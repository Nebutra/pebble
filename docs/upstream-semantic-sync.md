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
