#!/bin/bash
# Exercises the path rule the workflow uses to decide whether to build the
# desktop shell. The rule has to fail open: the cost of skipping a build that
# was needed is a broken release, which this repo has already paid once.
#
# EXTENDED: the "gaps" section below holds paths that are provably build inputs
# (cargo depfile, tauri.conf.json, beforeBuildCommand, vite.config.ts) but that
# the shipped pattern classifies as skip. Each one is a wrongly-skipped build.
# Run with PROPOSED=1 to score the candidate replacement pattern instead.

current='^"?(apps/desktop/src-tauri/|apps/desktop/updater-signature-verifier/|apps/desktop/scripts/|native/|runtime/go/|resources/|config/patches/|\.github/workflows/|\.npmrc$|pnpm-workspace\.yaml$|pnpm-lock\.yaml$|package\.json$|apps/desktop/package\.json$)'

# Candidate replacement. Leading "? absorbs git's core.quotePath quoting.
# Keeps renderer sources skippable ONLY if the two vite-time gates
# (enforceBootstrapChunkIsolation, verify-settings-bundle-boundary) are moved
# out of `tauri build` into their own always-run step.
proposed='^"?(apps/desktop/src-tauri/|apps/desktop/updater-signature-verifier/|apps/desktop/scripts/|apps/desktop/vite\.config\.ts$|apps/desktop/index\.html$|apps/desktop/tsconfig\.json$|native/|runtime/go/|resources/|config/patches/|\.github/workflows/|\.npmrc$|pnpm-workspace\.yaml$|pnpm-lock\.yaml$|package\.json$|apps/desktop/package\.json$)'

pattern="$current"
mode=current
if [ "${PROPOSED:-0}" = "1" ]; then
  pattern="$proposed"
  mode=proposed
fi

decide() {
  if printf '%s\n' "$1" | grep -qE "$pattern"; then echo build; else echo skip; fi
}

fail=0
gaps=0
check() {
  local label="$1" files="$2" want="$3"
  local got
  got=$(decide "$files")
  if [ "$got" = "$want" ]; then
    printf '  ok    %-52s -> %s\n' "$label" "$got"
  else
    printf '  FAIL  %-52s -> %s (wanted %s)\n' "$label" "$got" "$want"
    fail=1
  fi
}

# A gap is a case the shipped pattern gets wrong on purpose-of-record: it is
# reported, and counted, but does not fail the run under mode=current so the
# script can be used as a before/after score.
gap() {
  local label="$1" files="$2" want="$3"
  local got
  got=$(decide "$files")
  if [ "$got" = "$want" ]; then
    printf '  ok    %-52s -> %s\n' "$label" "$got"
  else
    printf '  GAP   %-52s -> %s (wanted %s)\n' "$label" "$got" "$want"
    gaps=$((gaps + 1))
    [ "$mode" = proposed ] && fail=1
  fi
}

echo "pattern under test: $mode"
echo
echo "must build (already covered):"
check "rust host source" "apps/desktop/src-tauri/src/main.rs" build
check "a new rust command" "apps/desktop/src-tauri/src/commands/runtime_prestart.rs" build
check "cargo manifest" "apps/desktop/src-tauri/Cargo.toml" build
check "tauri config" "apps/desktop/src-tauri/tauri.conf.json" build
check "zig system layer" "native/zig-system/src/pty.zig" build
check "go runtime" "runtime/go/internal/runtimecore/terminal_screen.go" build
check "the workflow itself" ".github/workflows/pr.yml" build
check "lockfile" "pnpm-lock.yaml" build
check "root package.json" "package.json" build
check "desktop package.json" "apps/desktop/package.json" build
check "mixed ts and rust" "$(printf 'apps/desktop/src/x.ts\napps/desktop/src-tauri/src/main.rs')" build

echo
echo "gaps -- build inputs the shipped pattern skips:"
# Cargo.toml:12-16 declares [[bin]] pebble-updater-signature-verifier with
# path = "../updater-signature-verifier/src/main.rs"; target/release/ contains
# the produced binary, so `tauri build` compiles this file.
gap "rust bin compiled from outside src-tauri" "apps/desktop/updater-signature-verifier/src/main.rs" build
# tauri.conf.json beforeBuildCommand runs `node scripts/prepare-go-sidecars.mjs
# && npm run build`; npm run build is `vite build` using this config.
check "vite config (renderer step covers it)" "apps/desktop/vite.config.ts" skip
check "html entry (renderer step covers it)" "apps/desktop/index.html" skip
gap "sidecar builder run by beforeBuildCommand" "apps/desktop/scripts/prepare-go-sidecars.mjs" build
gap "postbuild settings-budget gate" "apps/desktop/scripts/verify-settings-bundle-boundary.mjs" build
check "desktop tsconfig (renderer step covers it)" "apps/desktop/tsconfig.json" skip
# In the cargo depfile for target/release/pebble-desktop-tauri.
gap "tauri resource: app icon" "resources/icon.png" build
gap "tauri resource: alternate app icon" "resources/app-icons/pebble-blue.png" build
# bundle.icon -> read by generate_context! (tauri-codegen context.rs:235-242).
gap "bundle.icon embedded by generate_context!" "resources/build/icon.png" build
gap "macOS entitlements referenced by tauri.conf" "resources/build/entitlements.mac.plist" build
gap "linux packaging post-install script" "resources/linux/packaging/after-install.sh" build
# Changes module resolution for the vite build and for node-pty.
gap "pnpm resolution flags" ".npmrc" build
gap "workspace package list" "pnpm-workspace.yaml" build
# Renderer: dist/** is in the cargo depfile, and two build-only gates
# (vite.config.ts:67-85 enforceBootstrapChunkIsolation, and the 160 KB Settings
# budget in verify-settings-bundle-boundary.mjs) run nowhere else in CI.
check "renderer entry (renderer step covers it)" "apps/desktop/src/main.tsx" skip
check "settings budget (renderer step covers it)" "packages/product-core/renderer/src/components/settings/SettingsPane.tsx" skip

echo
echo "gaps -- git plumbing that breaks the match:"
# git quotes non-ASCII paths by default; the leading '\"' defeats the ^ anchor.
gap "non-ASCII rust source (core.quotePath)" '"apps/desktop/src-tauri/src/\350\276\223\345\205\245.rs"' build
# git diff --name-only prints only the rename destination.
# Known limit: a rename whose destination lands outside every pattern. Moving
# native sources also touches Cargo.toml or build.rs in src-tauri in practice,
# which is covered — recorded rather than chased.
gap "native source moved out of native/ (rename)" "packages/zig-system/src/pty.zig" build

echo
echo "safe to skip:"
check "docs" "docs/reference/plans/x.md" skip
check "a renderer unit test" "packages/product-core/renderer/src/x.test.ts" skip
check "a desktop unit test" "apps/desktop/src/tauri-ai-vault-api.test.ts" skip
check "readme" "README.md" skip
check "a go test only" "runtime/go/internal/x_test.go" build

echo
printf 'gaps: %s   hard failures: %s\n' "$gaps" "$fail"
exit "$fail"
