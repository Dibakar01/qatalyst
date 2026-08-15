/**
 * Where a tracked link is allowed to land.
 *
 * `/r/:token` builds `new URL(destination, req.url)`, and an absolute URL beats
 * the base — so an unvalidated destination turns a link inside our own email
 * into an open redirect that also hands over the reader's signed token in the
 * query string. That is the most phishing-shaped thing an email can do, and
 * secure email gateways quarantine on exactly that pattern.
 *
 * So a destination must be somewhere we control. Checked when it is *stored*
 * rather than when it is followed: a bad value should be refused by the person
 * typing it, not discovered by a reader mid-redirect.
 */

/** Hosts a tracked link may point at, from the environment. */
export function allowedHosts(): string[] {
  const raw = [process.env.SITE_ORIGINS, process.env.UNSUBSCRIBE_BASE_URL]
    .filter(Boolean)
    .join(',')

  return [
    ...new Set(
      raw
        .split(',')
        .map((value) => {
          try {
            return new URL(value.trim()).hostname.toLowerCase()
          } catch {
            return ''
          }
        })
        .filter(Boolean),
    ),
  ]
}

/**
 * A destination we are willing to store, or null.
 *
 * Null means the built-in enquiry form, which is also what every letter written
 * before campaigns had a destination keeps doing — so refusing is always safe.
 */
export function safeDestination(
  value: string | null | undefined,
  hosts = allowedHosts(),
): string | null {
  const trimmed = (value ?? '').trim()
  if (!trimmed) return null

  // A relative path is always ours by definition.
  if (trimmed.startsWith('/') && !trimmed.startsWith('//')) return trimmed

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }

  // Only the two schemes a browser will follow to a web page. `javascript:`
  // and `data:` are the reason this is an allowlist rather than a blocklist.
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null

  const host = url.hostname.toLowerCase()
  // Exact host, or a subdomain of one we listed. Compared with a leading dot
  // so `qalakaar.com.evil.com` cannot pass as `qalakaar.com`.
  const ours = hosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))
  return ours ? url.toString() : null
}
