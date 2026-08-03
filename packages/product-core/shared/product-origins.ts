/**
 * Product origins — the only place Pebble names a public host.
 *
 * Pebble runs on Nebutra platform hosts rather than a parallel origin stack:
 * `pebble.nebutra.com` is a brand front (landing / download / docs redirect)
 * with no backend, docs are canonically served from `docs.nebutra.com/pebble`,
 * and machine endpoints live under `api.nebutra.com/pebble/*`.
 *
 * See `docs/reference/infra-index.md` for the frozen topology and the reasoning
 * behind the `/pebble` API prefix.
 *
 * Each origin is a compile-time constant (`PEBBLE_*_ORIGIN`, substituted by the
 * Vite configs, `null` by default) so a fork, self-host, or staging build can
 * retarget without touching call sites. Staging is an env/project concern — it
 * never gets its own subdomain.
 */

// Why redeclared here: tsgo under `types: ['node']` does not always pick up
// ambient injects from packages/product-core/types/build-constants.d.ts for this
// module; keep the same compile-time contract the Vite defines substitute.
declare const PEBBLE_PRODUCT_ORIGIN: string | null
declare const PEBBLE_DOCS_ORIGIN: string | null
declare const PEBBLE_API_ORIGIN: string | null
declare const PEBBLE_STATUS_ORIGIN: string | null

const DEFAULT_PRODUCT_ORIGIN = 'https://pebble.nebutra.com'
const DEFAULT_DOCS_ORIGIN = 'https://docs.nebutra.com'
const DEFAULT_API_ORIGIN = 'https://api.nebutra.com'
const DEFAULT_STATUS_ORIGIN = 'https://status.nebutra.com'

/** Path namespace owned by Pebble on the shared docs + API hosts. */
const PRODUCT_NAMESPACE = 'pebble'

function resolveOrigin(injected: string | null, fallback: string): string {
  const trimmed = injected?.trim()
  return trimmed ? trimmed.replace(/\/+$/, '') : fallback
}

/** Brand front: landing, download, marketing. Serves no API. */
export const PRODUCT_ORIGIN = resolveOrigin(PEBBLE_PRODUCT_ORIGIN, DEFAULT_PRODUCT_ORIGIN)

/**
 * Bare hostname of the brand front. Release metadata validates changelog URLs
 * against this — legacy origins are rewritten at the edge, never trusted here.
 */
export const PRODUCT_HOST = PRODUCT_ORIGIN.replace(/^https?:\/\//, '').toLowerCase()

/** Docs host. Pebble's docs live under the `/pebble` path on it. */
export const DOCS_ORIGIN = resolveOrigin(PEBBLE_DOCS_ORIGIN, DEFAULT_DOCS_ORIGIN)

/** Canonical docs base — link here directly rather than via a brand-front redirect. */
export const DOCS_BASE_URL = `${DOCS_ORIGIN}/${PRODUCT_NAMESPACE}`

/** Shared platform API host. */
export const API_ORIGIN = resolveOrigin(PEBBLE_API_ORIGIN, DEFAULT_API_ORIGIN)

/**
 * Pebble's API namespace. The prefix is deliberate: `api.nebutra.com` is shared
 * across products, so `/v1/*` stays unclaimed and each product owns
 * `/<product>/v1/*`.
 */
export const API_BASE_URL = `${API_ORIGIN}/${PRODUCT_NAMESPACE}`

/** Status page — must stay reachable when the API host is impaired. */
export const STATUS_ORIGIN = resolveOrigin(PEBBLE_STATUS_ORIGIN, DEFAULT_STATUS_ORIGIN)

/** Build a canonical docs URL from a path relative to the Pebble docs root. */
export function docsUrl(path = ''): string {
  const suffix = path.replace(/^\/+/, '')
  return suffix ? `${DOCS_BASE_URL}/${suffix}` : DOCS_BASE_URL
}

/** Build an API URL from a path relative to Pebble's API namespace. */
export function apiUrl(path: string): string {
  return `${API_BASE_URL}/${path.replace(/^\/+/, '')}`
}
