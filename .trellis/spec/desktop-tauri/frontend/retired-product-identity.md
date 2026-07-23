# Retired Product Identity

## Scope

Apply this contract when removing a superseded product name, path, executable,
or developer-tool integration from Pebble.

## Scanner Contract

- `config/scripts/legacy-brand-identifier-scan.mjs` scans tracked and unignored
  working-tree paths and UTF-8 source text.
- It rejects standalone, CamelCase, environment-prefix, and hidden-directory
  forms of the retired identity.
- The scanner, tests, task history, and documentation receive no exemptions.
- Ordinary identifiers that merely contain the same letters inside a larger
  word remain valid and must not be renamed.

## Required Cases

- Good: build retired-name fixtures from fragments and assert rejection.
- Base: keep ordinary identifiers such as `ForCandidate` unchanged.
- Bad: preserve the retired name in a negative fixture or historical task file.

## Tests

- Run `node config/scripts/legacy-brand-identifier-scan.mjs`.
- Run `node_modules/.bin/vitest run config/scripts/legacy-brand-identifier-scan.test.mjs`.
- Run `node config/scripts/verify-tauri-mainline.mjs`.

## Wrong Vs Correct

Wrong: exempt scanner-owned files or task history from identity checks.

Correct: construct the retired name from fragments so every source file is
subject to the same repository rule.
