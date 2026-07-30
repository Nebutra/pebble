# Quality Guidelines

> Code quality standards for frontend development.

---

## Overview

These checks protect the desktop renderer's earliest startup boundary.

## Scenario: Tauri Renderer Bootstrap Entry

### 1. Scope / Trigger

- Trigger: changing `apps/desktop/index.html`, `apps/desktop/src/main.tsx`, or
  the desktop Vite root.

### 2. Signatures

- HTML entry: `<script type="module" src="/src/main.tsx"></script>`.
- Bootstrap export loaded dynamically: `startPebbleTauriRenderer(): boolean`.

### 3. Contracts

- The HTML entry must load the Tauri-owned bootstrap below the Vite root.
- `src/main.tsx` installs bootstrap diagnostics before dynamically importing
  `src/renderer-entry.ts`.
- Shared renderer sources are reached through Vite aliases from
  `renderer-entry.ts`, not through an HTML path outside the desktop root.

### 4. Validation & Error Matrix

- Missing `/src/main.tsx` -> Vite module-load error and empty `#root`.
- Direct shared-renderer HTML entry -> Tauri preload installation is bypassed.
- Renderer dynamic-import failure -> bootstrap failure surface must render.

### 5. Good/Base/Bad Cases

- Good: `/src/main.tsx` installs diagnostics and mounts the full shell.
- Base: a dynamic import fails and the visible bootstrap failure surface renders.
- Bad: `../../packages/product-core/renderer/src/main.tsx` normalizes to an
  unreachable `/packages/...` URL under the desktop Vite server.

### 6. Tests Required

- `npm run verify:mainline` must assert the desktop HTML entry contract.
- `npx vitest run src/tauri-renderer-bootstrap-diagnostics.test.ts` must verify
  failure rendering and bounded diagnostic reporting.
- `npm run build` must resolve the production entry and bootstrap chunks.

### 7. Wrong vs Correct

#### Wrong

```html
<script type="module" src="../../packages/product-core/renderer/src/main.tsx"></script>
```

#### Correct

```html
<script type="module" src="/src/main.tsx"></script>
```

---

## Forbidden Patterns

- Do not reference repository-external renderer source files directly from the
  desktop HTML entry.

---

## Required Patterns

- Keep diagnostics installation ahead of the heavyweight renderer dynamic import.

---

## Testing Requirements

- Run the scenario-specific checks above when changing renderer entry paths.

## Scenario: Browser Supporting Evidence And Native Tauri Ownership

### 1. Scope / Trigger

- Trigger: changing `tests/e2e/e2e-ownership.mjs`, Playwright projects, Tauri
  functional gates, terminal evidence runners, or browser preload mocks.

### 2. Signatures

- Browser project source: `browserPlaywrightProjects`.
- Renderer replacement source: `rendererSpecEvidence`.
- Native replacement source: `nativeSpecEvidence`.
- Native gate command: `node config/scripts/run-tauri-real-runtime-gate.mjs`.
- Combined evidence command: `node config/scripts/run-tauri-terminal-evidence.mjs --mode <mode>`.

### 3. Contracts

- Every application spec has exactly one owner: browser Playwright, an exact
  renderer contract, or an exact Rust/Go/Tauri contract.
- Browser ownership is an allowlist proven green as whole files in ordinary
  Chrome; static native markers are forbidden there.
- Browser Playwright proves renderer behavior only and is labeled
  `browser-renderer-supporting-evidence` in combined reports.
- Tauri process lifecycle, child webviews, native input, runtime sidecars, and
  platform integration are owned by Rust/Go tests or the real-runtime gate.
- Terminal combined evidence runs focused renderer unit contracts before the
  real Tauri runtime gate; it does not use Chrome to imitate a PTY or sidecar.
- Browser fixtures may mock typed API boundaries needed by a renderer contract,
  but must not claim that the corresponding native command executed.

### 4. Validation & Error Matrix

- Listed spec absent from every project -> ownership test failure.
- Spec listed in multiple ownership planes -> ownership test failure.
- Browser spec contains a native marker -> ownership test failure.
- Browser report labeled native -> evidence contract failure.
- Browser-only test requires a real child webview/runtime -> reclassify or add a
  real native gate; do not emulate the native implementation in DOM code.
- Native gate produces no report or exits nonzero -> combined evidence fails.

### 5. Good/Base/Bad Cases

- Good: browser renderer assertions run in Chrome and native lifecycle evidence
  runs separately in a packaged Tauri process.
- Good: a legacy renderer scenario that cannot initialize through the browser
  harness points to an exact component/store test instead of staying red in CI.
- Base: a browser fixture reopens onboarding through the public persisted API and
  renderer event, without mocking the component itself.
- Bad: a normal DOM element is presented as proof that a Tauri child webview
  preserved page state.

### 6. Tests Required

- `node --test tests/e2e/e2e-ownership.test.mjs` asserts project consumption.
- `node --test config/scripts/run-tauri-terminal-evidence.test.mjs` asserts owner labels.
- Run the complete browser allowlist after changing classification; a static
  marker scan alone is insufficient because hydration can still overwrite fixtures.
- Run the affected Playwright project with `--workers=1` for shared Git fixtures.
- Run `node config/scripts/run-tauri-real-runtime-gate.mjs` for native ownership.

### 7. Wrong vs Correct

#### Wrong

```ts
browserRendererSpecs.push('terminal-panes.spec.ts')
```

#### Correct

```ts
nativeSpecEvidence['terminal-panes.spec.ts'] = [exactPtyContract, realRuntimeContract]
```

## Scenario: Packaged CLI Runtime Discovery

### 1. Scope / Trigger

- Trigger: changing packaged CLI dispatch, Go runtime authentication, installers,
  or the keep-awake controller.

### 2. Signatures

- Credential owner: `runtime/go/internal/runtimeauth`.
- CLI entry: `pebble-control` or packaged desktop command forwarding.
- GUI activation inputs: no args, deep links, and macOS `-psn_*` only.

### 3. Contracts

- The runtime publishes a loopback endpoint and token through an owner-only,
  atomically replaced credential file.
- CLI calls discover that credential unless endpoint/token are explicitly supplied.
- Command-shaped input never falls through to GUI activation.
- Keep-awake state is Tauri/Rust-owned and follows current, non-replayed agent work.

### 4. Validation & Error Matrix

- Stale or foreign PID -> reject credential.
- Non-loopback endpoint -> reject credential.
- Public but unsupported command -> exit 2, never open the GUI.
- Missing required sidecar -> deterministic packaged smoke failure.

### 5. Good/Base/Bad Cases

- Good: `pebble status` discovers the running local runtime securely.
- Base: explicit endpoint/token override discovery.
- Bad: unknown command text opens the desktop window.

### 6. Tests Required

- Go runtimeauth and `pebble-control` tests.
- Rust `packaged_cli` tests.
- `node --test config/scripts/smoke-packaged-cli.test.mjs`.
- Rust `agent_awake` tests.

### 7. Wrong vs Correct

#### Wrong

```rust
Some(args) => launch_gui(args)
```

#### Correct

```rust
Some(args) => dispatch_cli_or_exit_two(args)
```

---

## Code Review Checklist

- Confirm the HTML entry remains below the configured desktop Vite root.
- Confirm failures before React mount still produce a visible error surface.
