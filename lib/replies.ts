/**
 * Reading the post that comes back.
 *
 * Everything here is pure: given the headers of an inbox message, decide what
 * it is and which of our sends it answers. The network and the database live in
 * `lib/inbox.ts`, so all of this is testable with a literal object.
 *
 * The whole system was deaf before this. Nothing ever wrote `bounced`, so the
 * halt rule — the one protection against burning a domain — was fed zero
 * forever. Nothing wrote `replied`, so the reply rate was structurally zero and
 * a follow-up could go to somebody who had already answered.
 */

export type Headers = Record<string, string>

/** Case-insensitive, because mail headers are and half the world forgets. */
export function header(headers: Headers, name: string) {
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase())
  return key ? headers[key] : undefined
}

/**
 * The Message-IDs an inbound message is answering.
 *
 * `In-Reply-To` is the direct parent; `References` is the whole thread. Both
 * are checked because a reply three deep in a thread carries our original only
 * in `References` — matching on `In-Reply-To` alone silently misses every
 * conversation that ran longer than one exchange.
 */
export function answers(headers: Headers): string[] {
  const raw = `${header(headers, 'in-reply-to') ?? ''} ${header(headers, 'references') ?? ''}`
  return [...raw.matchAll(/<[^<>\s]+>/g)].map((m) => m[0])
}

/**
 * Is this a bounce, and for whom?
 *
 * Delivery Status Notifications are the reliable signal — RFC 3464 gives them
 * a `multipart/report; report-type=delivery-status` content type, and Gmail
 * sends them from mailer-daemon. Subject text is checked too because plenty of
 * servers still send a plain human-readable rejection.
 */
export function isBounce(headers: Headers) {
  const from = (header(headers, 'from') ?? '').toLowerCase()
  const subject = (header(headers, 'subject') ?? '').toLowerCase()
  const type = (header(headers, 'content-type') ?? '').toLowerCase()

  if (type.includes('report-type=delivery-status')) return true
  if (/mailer-daemon|postmaster/.test(from)) return true
  return /^(undeliverable|delivery status notification|returned mail|mail delivery)/.test(subject)
}

/**
 * A hard bounce is permanent; a soft one is not.
 *
 * It matters because the two deserve opposite treatment: a permanent failure
 * should suppress the address so we never write again, and a full mailbox
 * should not. Treating every bounce as permanent throws away good contacts;
 * treating none as permanent is how a list rots and a domain follows it.
 */
export function isHardBounce(text: string) {
  // 5.x.x is permanent, 4.x.x is temporary — RFC 3463 enhanced status codes.
  const status = text.match(/\b([45])\.\d{1,3}\.\d{1,3}\b/)
  if (status) return status[1] === '5'
  return /user unknown|no such user|does not exist|address rejected|mailbox unavailable/i.test(text)
}

/**
 * Ours, or someone else's?
 *
 * An auto-reply is not a reply. Counting "out of office" as engagement would
 * corrupt the one number the whole system is judged on, and these headers are
 * how a well-behaved autoresponder announces itself.
 */
export function isAutoReply(headers: Headers) {
  const auto = (header(headers, 'auto-submitted') ?? '').toLowerCase()
  if (auto && auto !== 'no') return true
  if (header(headers, 'x-autoreply') || header(headers, 'x-autorespond')) return true
  const precedence = (header(headers, 'precedence') ?? '').toLowerCase()
  if (['bulk', 'auto_reply', 'junk'].includes(precedence)) return true
  return /^(auto(matic)?[- ]?reply|out of (the )?office|away from)/i.test(
    header(headers, 'subject') ?? '',
  )
}

export type Verdict =
  | { kind: 'bounce'; answering: string[]; hard: boolean }
  | { kind: 'reply'; answering: string[] }
  | { kind: 'auto'; answering: string[] }
  | { kind: 'ignore' }

/**
 * What one inbox message means for us.
 *
 * Order matters: a bounce is checked before a reply because a Mailer-Daemon
 * notification *is* a reply to our message by threading, and reading it as
 * engagement would be exactly backwards.
 */
export function classify(headers: Headers, body = ''): Verdict {
  const answering = answers(headers)
  if (isBounce(headers)) {
    return { kind: 'bounce', answering, hard: isHardBounce(`${header(headers, 'subject') ?? ''} ${body}`) }
  }
  // Only mail that answers something of ours is ours to interpret.
  if (answering.length === 0) return { kind: 'ignore' }
  if (isAutoReply(headers)) return { kind: 'auto', answering }
  return { kind: 'reply', answering }
}
