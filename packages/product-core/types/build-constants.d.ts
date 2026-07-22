// Ambient declarations for compile-time constants substituted by the build
// configs. The telemetry constants are injected by the desktop Vite build;
// contributor / `pnpm dev` / third-party builds substitute literal `null`,
// so native telemetry treats them as unofficial builds and console-mirrors only.
//
// The CI release workflow (and only the CI release workflow) provides real
// values via GitHub Actions secrets. There is no runtime env-var fallback;
// the substitution happens at compile time so a curious contributor cannot
// spoof transmission with a shell export.
//
declare const PEBBLE_BUILD_IDENTITY: 'stable' | 'rc' | null
declare const PEBBLE_POSTHOG_WRITE_KEY: string | null

// Diagnostic-bundle upload endpoint for Mode 3 (telemetry-error-tracking.md
// §Endpoint contract). Substituted by CI; `null` in contributor builds, at
// which point the upload IPC handler returns "endpoint not configured"
// rather than POSTing to a placeholder. The dev escape hatch is the
// `PEBBLE_DIAGNOSTICS_TOKEN_URL` env var, which env wins so a developer can
// point a packaged build at a staging server without re-running the
// release pipeline.
declare const PEBBLE_DIAGNOSTICS_TOKEN_URL: string | null
