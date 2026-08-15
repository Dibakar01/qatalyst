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
