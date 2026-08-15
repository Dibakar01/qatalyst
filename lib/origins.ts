import { timingSafeEqual } from 'node:crypto'

/**
 * Which sites may report conversions.
 *
 * `/api/conversion` authenticates with a bearer secret, which works for
 * server-to-server and is useless in a browser: a secret shipped to a browser
 * is not a secret. The pixel gets its own door with browser-shaped auth — the
 * `Origin` header, which the browser sets and page script cannot forge.
 *
 * Pure and separate so the parsing can be tested without a request, because
 * the failure mode is quiet: a stray space or a trailing slash in the
 * environment variable silently rejects every event, and the pixel is designed
 * never to complain.
 */

/** Compare origins as origins, not as strings — trailing slashes and case. */
function canonical(value: string) {
  const trimmed = value.trim()
  if (!trimmed) return ''
  try {
    // `new URL` normalises the case of the host and drops any path, so
    // `HTTPS://Site.com/` and `https://site.com` are the same allowance.
    return new URL(trimmed).origin.toLowerCase()
  } catch {
    // Not a URL. Kept verbatim rather than dropped, so a mistake in the
    // environment shows up as "this origin is not allowed" rather than as an
    // allowlist that silently shrank.
    return trimmed.replace(/\/+$/, '').toLowerCase()
  }
}

export function parseOrigins(raw: string | undefined | null): string[] {
  if (!raw) return []
  return [...new Set(raw.split(',').map(canonical).filter(Boolean))]
}

/**
 * Whether this origin may report.
 *
 * An empty allowlist allows nothing. That is deliberate: an unset variable
 * meaning "everyone" would turn a missed deployment step into an open
 * endpoint that writes to the conversions table.
 */
export function originAllowed(origin: string | null | undefined, allowlist: string[]) {
  if (!origin || allowlist.length === 0) return false
  return allowlist.includes(canonical(origin))
}

/**
 * The public write key the pixel carries.
 *
 * `Origin` is a CSRF defence, not authentication — a browser sets it and curl
 * sets it to whatever it likes. Without a second factor `/api/collect` is an
 * open write endpoint on the internet: anyone could fabricate revenue and, until
 * `advance()` was gated, permanently mark a real contact a customer.
 *
 * This key is *not* a secret in the way `INGEST_SECRET` is — it ships in page
 * source and that is fine. What it buys is real: an untargeted prober has
 * nothing to send, and one site can be revoked without touching the others.
 */
export function parseKeys(raw: string | undefined | null): string[] {
  if (!raw) return []
  return [...new Set(raw.split(',').map((k) => k.trim()).filter(Boolean))]
}

/**
 * Whether this key is one of ours.
 *
 * Compared in constant time per candidate. A public key is not worth a timing
 * attack, but the comparison is cheap and it means nobody has to reason about
 * whether it was worth it.
 */
export function keyAllowed(key: string | null | undefined, keys: string[]) {
  if (!key || keys.length === 0) return false
  const given = Buffer.from(key)
  return keys.some((known) => {
    const candidate = Buffer.from(known)
    if (candidate.length !== given.length) return false
    return timingSafeEqual(candidate, given)
  })
}
