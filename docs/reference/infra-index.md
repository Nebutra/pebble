# Infra index — Pebble on Nebutra platform hosts

Single source of truth for **where Pebble traffic actually lands**. The Nebutra
platform topology is authoritative; this file records how Pebble maps onto it.
Anything in `ROADMAP.md` that predates this file is aspirational — when the two
disagree, this file wins.

Platform-side counterpart: `docs/DOMAINS.md` in `Nebutra/Nebutra-Sailor`.

Frozen: 2026-07-27 (issue #41). Live cutover: 2026-07-30 — brand front on **ECS** (CF A → origin); API on ECS `/pebble/*`.

---

## 1. Live platform topology

```
Cloudflare (DNS · CDN · WAF · edge Workers, :443)
  ├─ Vercel / Workers — marketing landing, sailor-docs
  └─ ECS origin 106.15.4.31 — app / auth / api / sso / router / forge / **pebble**
```

| Host | Role | Runtime | Port |
|------|------|---------|------|
| `www.nebutra.com` / apex | Brand / marketing | Vercel | 443 |
| `docs.nebutra.com` | Docs | Cloudflare Worker (OpenNext) | 443 |
| `api.nebutra.com` | API (CF → ECS) | ECS PM2 | 443 |
| `status.nebutra.com` | Status page | — | 443 |
| `app.nebutra.com` | App RP | ECS PM2 | 443 |
| `auth.nebutra.com` | Login / session authority | ECS PM2 | 443 |
| `sso.nebutra.com` | OIDC issuer — **no path prefix, do not casually migrate** | ECS PM2 | 443 |
| `pebble.nebutra.com` | **Pebble brand front** — landing / download / feeds / docs redirect | **ECS PM2 :3017** (CF A `106.15.4.31` proxied) | 443 |

The ECS origin IP is never exposed to clients; all public traffic terminates at
Cloudflare.

---

## 2. Pebble host mapping

Pebble does **not** get a parallel origin stack. Only the brand front is a
Pebble-owned host; everything transactional runs on shared platform hosts.

| Capability | Host + path | Notes |
|------------|-------------|-------|
| Landing / download | `https://pebble.nebutra.com` | Next brand front on ECS (`apps/pebble` in Sailor monorepo). No product DB. |
| Docs / help | `https://docs.nebutra.com/pebble/…` | Canonical. `pebble.nebutra.com/docs/*` nginx-301s here |
| Feedback | `POST https://api.nebutra.com/pebble/v1/feedback` | Direct handler, no redirect. Brand host also reverse-proxies `POST /v1/feedback` for legacy clients. |
| Diagnostics | `POST https://api.nebutra.com/pebble/diagnostics/{token,upload,delete/:ticketId}` | Same host for token + upload. Brand host proxies `/diagnostics/*` for legacy. |
| Status | `https://status.nebutra.com` | Must stay reachable when `api` is impaired |
| Changelog / nudge feeds | `https://pebble.nebutra.com/whats-new/{changelog,nudge}.json` | Served by brand front (no client redirects). Release *artifacts* stay on GitHub. |
| Staging | **no host** | Env / secrets / project isolation, not a subdomain |

**Do not** create `api.pebble.*`, `status.pebble.*`, `staging.pebble.*`,
`cloud.pebble.*`, `relay.pebble.*`, or `telemetry.pebble.*`. The reserved-host
list in `ROADMAP.md` is superseded by this table.

### API path style — frozen: prefixed

```
✅ api.nebutra.com/pebble/v1/feedback
✅ api.nebutra.com/pebble/diagnostics/upload
❌ api.nebutra.com/v1/feedback          ← flat; rejected
```

`api.nebutra.com` is shared by every Nebutra product, so `/v1/*` stays unclaimed
and each product owns `/<product>/v1/*`. This keeps gateway routing, rate-limit
buckets, and per-product metering separable without a later namespace split.

Machine-consumed routes (`POST` JSON, multipart uploads, feed JSON, media) must
return their final response **without redirects**. Only human-facing `GET` pages
may 301.

---

## 3. Auth constraints (platform-owned, do not redesign)

- Session is held on **`auth.nebutra.com`**; it is the session authority.
- **`app.nebutra.com`** is a relying party — unauthenticated requests redirect to
  `https://auth.nebutra.com/sign-in?returnTo=…`.
- `AUTH_COOKIE_DOMAIN=.nebutra.com`, and `BETTER_AUTH_SECRET` **must be identical**
  on both ends or sessions silently fail to round-trip.
- **`sso.nebutra.com`** is the OIDC issuer URL. Never add a path prefix, never
  migrate it casually — the issuer string is baked into every registered client.

Pebble consumes these; it does not own or reimplement them.

---

## 4. Ports

| Surface | Port | Bind |
|---------|------|------|
| Local `pebble-runtime` | **17777** | `127.0.0.1` |
| `pebble serve` / pairing | **6768** | `127.0.0.1` |
| SSH | **22** | — |
| Public product surface | **443** (80 → 443) | — |

Remote access is by SSH tunnel, not by exposing the local ports:

```bash
ssh -L 17777:127.0.0.1:17777 user@host
ssh -L 6768:127.0.0.1:6768 user@host
```

---

## 5. Client origin configuration

Origins are **build-time configurable**, not hardcoded. Source of truth:
`packages/product-core/shared/product-origins.ts`.

| Export | Build constant | Default |
|--------|----------------|---------|
| `PRODUCT_ORIGIN` | `PEBBLE_PRODUCT_ORIGIN` | `https://pebble.nebutra.com` |
| `PRODUCT_HOST` | — | hostname of `PRODUCT_ORIGIN` |
| `DOCS_ORIGIN` | `PEBBLE_DOCS_ORIGIN` | `https://docs.nebutra.com` |
| `DOCS_BASE_URL` | — | `${DOCS_ORIGIN}/pebble` |
| `API_ORIGIN` | `PEBBLE_API_ORIGIN` | `https://api.nebutra.com` |
| `API_BASE_URL` | — | `${API_ORIGIN}/pebble` |
| `STATUS_ORIGIN` | `PEBBLE_STATUS_ORIGIN` | `https://status.nebutra.com` |

The `PEBBLE_*_ORIGIN` constants follow the same idiom as `PEBBLE_BUILD_IDENTITY`
and `PEBBLE_DIAGNOSTICS_TOKEN_URL`: ambient declarations in
`packages/product-core/types/build-constants.d.ts`, substituted by the Vite
`define` blocks, `null` in an ordinary build so the production defaults apply.
`apps/desktop/vite.config.ts` reads the matching env var at build time, so a
fork or staging build retargets by exporting it — never by editing a call site.
`config/vitest.config.ts` pins them to `null` so tests assert the defaults.

Consumers that must route through this module rather than a literal:

- `packages/product-core/shared/feature-wall-tiles.ts` — docs base
- `packages/product-core/shared/feature-wall-workflows.ts` — docs base
- `packages/product-core/renderer/src/lib/telemetry.ts` — privacy URL
- `packages/product-core/renderer/src/components/sidebar/SidebarSettingsHelpMenu.tsx` — docs URL
- `packages/product-core/shared/updater-changelog-selection.ts` — changelog host
- `package.json` `homepage`

---

## 6. Non-goals

- Redesigning Better Auth or the OIDC issuer URL.
- Exposing the ECS origin IP publicly.
- Pairing / LAN discovery (tracked separately).
- A Pebble-specific staging subdomain.
