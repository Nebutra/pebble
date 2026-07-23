# Pebble Product Origin Migration

## Canonical Contract

- Product origin: `https://pebble.nebutra.com`
- Product paths use the host root: `/download`, `/docs/*`,
  `/whats-new/{changelog,nudge}.json`, `/media/*`, `/diagnostics/token`, and
  `/v1/feedback`.
- GitHub Releases, tag pages, release artifacts, and `releases.atom` remain on
  `github.com/nebutra/pebble`.

## Repository Owners

- Rust commands own changelog/nudge, feedback, crash reporting, and diagnostics
  runtime endpoints.
- The Tauri release workflow injects the official diagnostics token URL.
- Renderer/shared and mobile packages own docs, privacy, and product-page links.
- README variants and Homebrew casks own public discovery/download links.
- `verify-tauri-mainline.mjs` owns focused release/runtime URL assertions.

## Deployment Boundary

Repository changes do not configure DNS, TLS, CDN, or provider routing. Before
release, the new host must serve every route and legacy origins must retain
compatibility. Human GET pages may redirect. Machine JSON, media, diagnostics,
and feedback routes must be mirrored or reverse-proxied; feedback POST bodies
and headers must reach the handler without redirect-dependent behavior.
