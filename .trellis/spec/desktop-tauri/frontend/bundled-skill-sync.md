# Bundled Skill And Upstream Sync Contracts

## Scenario: Version-Matched Bundled Skills

### 1. Scope / Trigger

- Trigger: changing `skill-guides/`, `skills/`, bundled skill metadata, the packaged CLI dispatcher, or `pebble-control` skill retrieval.

### 2. Signatures

- Text: `pebble skills get <skill-name>`.
- JSON: `pebble skills get --json <skill-name>`.
- Version probe: `pebble skills get --app-version <version> --json <skill-name>`.
- Generator: `node config/scripts/generate-bundled-skill-guides.mjs --write`.
- Verification: `node config/scripts/generate-bundled-skill-guides.mjs`.

### 3. Contracts

- `skill-guides/<name>.md` is the canonical full guide.
- `skills/<name>/SKILL.md`, `resources/skills/*.json`, and `runtime/go/cmd/pebble-control/bundled_skill_guides_generated.go` are generated.
- The packaged Tauri executable forwards `skills` to `pebble-control`; retrieval does not require a running runtime or network access.
- An unmapped application version returns the current bundled guide and exposes `fallbackReason` in JSON.
- Guides must describe Pebble's Go/Tauri/runtime contracts and must not reintroduce retired product identity or unsupported upstream commands.

### 4. Validation & Error Matrix

- Unknown skill -> error listing canonical available skill names.
- Missing or incomplete guide frontmatter -> generator failure.
- Generated output differs from canonical input -> verification failure.
- Unmapped version -> current guide with explicit fallback metadata.
- Missing bundled control binary -> packaged CLI reports reinstall guidance.

### 5. Good/Base/Bad Cases

- Good: edit one canonical guide, regenerate, and retrieve the same content from the Go CLI.
- Base: a development version has no mapping and receives a declared current-guide fallback.
- Bad: edit an installed stub or generated Go file directly; regeneration discards the change.
- Bad: document an upstream command before the Pebble CLI implements and tests it.

### 6. Tests Required

- Generator tests assert all eight skills produce stubs and embedded guides.
- `go test ./cmd/pebble-control` asserts text, JSON fallback, and unknown-skill behavior.
- `cargo test packaged_cli` asserts command-shaped input forwards instead of opening the GUI.
- `pnpm run lint` includes `verify:bundled-skills` so stale artifacts fail the quality gate.

### 7. Wrong vs Correct

#### Wrong

```text
Edit skills/pebble-cli/SKILL.md as the full guide.
```

#### Correct

```text
Edit skill-guides/pebble-cli.md, then run the generator with --write.
```

## Scenario: Semantic Upstream Reports

### 1. Scope / Trigger

- Trigger: changing the upstream checkpoint, path classification, scheduled audit workflow, or issue publication.

### 2. Signatures

- Local clone: `node config/scripts/upstream-semantic-sync.mjs --repo <path>`.
- Temporary fetch: `node config/scripts/upstream-semantic-sync.mjs --fetch`.
- Publisher: `node config/scripts/publish-upstream-semantic-issue.mjs [report.json] [report.md]`.

### 3. Contracts

- Analysis is credential-free and writes deterministic JSON/Markdown evidence.
- Publication is a separate GitHub adapter using `GITHUB_TOKEN` and `GITHUB_REPOSITORY`.
- Hidden range markers make repeated publication idempotent.
- High-risk desktop-host/runtime changes require manual Go/Tauri semantic ports.
- The workflow may create/update issues; it must not merge or directly modify protected branches.

### 4. Validation & Error Matrix

- No `--repo` or `--fetch` -> argument error.
- Invalid checkpoint/ref -> git error; checkpoint remains unchanged.
- Empty range -> report is written and issue publication is skipped.
- GitHub API failure -> publication fails without advancing repository state.

### 5. Good/Base/Bad Cases

- Good: scheduled run produces one canonical issue for a non-empty range.
- Base: no new commits produces an artifact and no issue churn.
- Bad: treat an Electron main/preload commit as a textual patch candidate.
- Bad: advance `lastAudited` before the range is reviewed.

### 6. Tests Required

- Classifier tests cover low-risk skills, high-risk desktop host, and unknown fallback.
- Publisher tests assert stable markers and canonical issue lookup.
- Local dry run against the audited upstream checkout proves checkpoint resolution.

### 7. Wrong vs Correct

#### Wrong

```text
Scheduled workflow cherry-picks and merges an upstream runtime commit.
```

#### Correct

```text
Scheduled workflow reports the commit as high risk and maintains a semantic-port issue.
```
