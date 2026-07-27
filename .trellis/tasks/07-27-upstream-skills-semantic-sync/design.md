# Upstream skills semantic sync design

## Architecture

The implementation has two related but independently testable systems:

1. A Pebble hybrid-skill runtime that packages localized guides with the application and serves the guide matching the installed Pebble version through `pebble skills get`.
2. A repository automation pipeline that observes upstream refs, produces semantic evidence, and maintains review work without changing protected branches.

## Skill source and generated artifacts

- `skill-guides/<name>.md` is the canonical full Pebble guide for the current source revision.
- `skill-stubs/<name>.md` is the canonical routing body used by the installable package.
- `skills/<name>/SKILL.md` is generated from frontmatter plus the corresponding routing body.
- `resources/skills/current-manifest.json` records current revisions, provenance, digests, and packaged files.
- `resources/skills/release-mapping.json` maps Pebble application versions to guide revisions.
- `resources/skills/snapshot-registry.json` retains immutable revision metadata needed to resolve older releases.
- A generated Go source module embeds guide content and mappings into `pebble-control`; this keeps retrieval offline and avoids platform-specific resource-path discovery.

Generation is deterministic: normalized UTF-8 Markdown and canonical JSON ordering produce stable SHA-256 digests. Verification rebuilds artifacts in memory and compares them with checked-in output.

## CLI contract

`pebble skills get <name>` writes only the selected Markdown guide to stdout. `--json` returns a structured envelope containing skill name, requested app version, resolved revision, provenance, fallback reason, and content. The installed app version is the default; development may override it with a documented flag for tests and release preparation.

Resolution order:

1. Exact application-version mapping.
2. Highest mapped version with the same stable/prerelease lineage that is not newer than the requested version.
3. Current bundled revision, accompanied by an explicit fallback reason.

Retired command aliases are localized at the CLI boundary only where they help existing migrated installations. Canonical manifests contain Pebble names.

The Tauri packaged CLI recognizes `skills` as a native control command and forwards it to the sibling `pebble-control` binary. The command does not require the Pebble runtime to be running, so it works locally, over SSH shells, and in CI.

## Localization rules

Semantic adaptation is performed per guide:

- Command examples use `pebble` and `pebble-dev`.
- Runtime selection uses Pebble's `PEBBLE_*` contracts.
- Electron daemon, main, and preload instructions become Go runtime, Tauri host, or renderer instructions according to ownership.
- Legacy pairing-scheme compatibility is mentioned only where Pebble deliberately accepts migrated URLs.
- Platform-dependent commands and paths remain separated and Windows examples avoid POSIX-only assumptions.
- Remote and SSH execution state which machine owns the desktop, runtime, emulator, repository, and credentials.

## Semantic-sync data flow

1. A local Node script fetches or reads the configured upstream git remote and release metadata.
2. The collector compares the persisted checkpoint with the requested upstream ref.
3. A classifier assigns commits and changed paths to ownership boundaries and risk tiers using checked-in rules.
4. The reporter writes canonical JSON and Markdown artifacts.
5. A publication script uses GitHub's API in batches to find canonical issue markers and create or update issues idempotently.
6. The checkpoint advances only after report generation succeeds; publication failure leaves the previous committed checkpoint intact.
7. A scheduled/manual GitHub Action uploads reports and publishes issues. Draft PR generation is a separate opt-in job restricted to allow-listed deterministic transformations.

Issue identity uses hidden stable markers derived from upstream repository, range, release/commit identity, and report schema version. This prevents the duplicate creation seen during the initial manual audit.

## Risk classification

- Low: documentation, localized skill text, deterministic generated metadata, and pure renderer/shared changes with matching Pebble ownership.
- Medium: build/release, mobile, provider integrations, or behavior spanning multiple Pebble packages.
- High: Electron main/preload, daemon/relay/runtime, process lifecycle, security, authentication, data migration, or changes whose upstream architecture does not exist in Pebble.

Only low-risk allow-listed transformations may become draft PR candidates. Medium and high risk always remain issues/reports until explicitly implemented.

## Compatibility

- The install URL and eight public Pebble skill names remain stable.
- The guide command is independent of a running desktop runtime.
- The generator and analyzer use Node standard-library APIs and git commands available on macOS, Linux, and Windows; paths are built with `path` APIs.
- GitHub publication is isolated from the analyzer so GitLab users can consume reports without a GitHub dependency and a future publisher can target another provider.

## Rollout and rollback

- Land generated skill infrastructure and tests before replacing full installable skills with stubs.
- Verify every stub can retrieve its guide using the built development CLI.
- Add automation in report-only mode first; issue publication is enabled after an idempotence dry run.
- Draft PR generation remains disabled by default.
- Rollback consists of restoring standalone skill files and removing the `skills` CLI command; sync reports and checkpoint files are additive repository data and do not affect application runtime.
