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
 * What the mail system actually said, per RFC 3464.
 *
 * A delivery status notification is a `multipart/report` whose middle part is
 * `message/delivery-status` — a machine-readable block of `field: value` lines
 * that states the verdict outright. This reads that block.
 *
 * Everything else here used to guess from the subject line and Gmail's snippet
 * preview, which is a human-readable summary that happens to often contain a
 * status code. The authoritative answer was never even downloaded.
 *
 *   Final-Recipient: rfc822; ada@example.com
 *   Action: failed
 *   Status: 5.1.1
 *   Diagnostic-Code: smtp; 550 5.1.1 No such user
 *
 * Written against the RFC rather than taken from a library: the one clean
 * reference implementation, artack/delivery-status-notification, was archived
 * in January 2026, and the format has not changed since 2003.
 */
export type Report = {
  /** failed is permanent-ish, delayed is explicitly not. */
  action?: string
  /** The enhanced status code: 5.x.x permanent, 4.x.x temporary (RFC 3463). */
  status?: string
  recipient?: string
  diagnostic?: string
}

export function readReport(part: string): Report {
  // Long values fold onto continuation lines beginning with whitespace.
  const unfolded = part.replace(/\r?\n[ \t]+/g, ' ')
  const field = (name: string) =>
    unfolded.match(new RegExp(`^${name}\\s*:\\s*(.+)$`, 'im'))?.[1]?.trim()

  return {
    action: field('Action')?.toLowerCase(),
    status: field('Status'),
    // `rfc822; someone@example.com` — the type prefix is not the address.
    recipient: field('Final-Recipient')?.split(';').pop()?.trim(),
    diagnostic: field('Diagnostic-Code'),
  }
}

/**
 * Permanent, or worth trying again?
 *
 * The two deserve opposite treatment, and getting it wrong is expensive in
 * both directions: read a full mailbox as permanent and a good contact is
 * suppressed forever; read a dead address as temporary and we keep writing to
 * it and damage the domain.
 *
 * The report is believed when there is one. `delayed` is never permanent —
 * it explicitly means the server has not given up — and that check comes first
 * because a delay notice can still carry a 5.x.x code for one recipient of
 * many.
 */
export function isHardBounce(text: string, report?: Report) {
  if (report?.action === 'delayed') return false
  if (report?.action === 'delivered' || report?.action === 'relayed') return false

  const code = report?.status ?? text.match(/\b([45])\.\d{1,3}\.\d{1,3}\b/)?.[0]
  if (code) return code.trim().startsWith('5')

  if (report?.action === 'failed') return true
  return /user unknown|no such user|does not exist|address rejected|mailbox unavailable/i.test(text)
}

/**
 * Somebody marked it as spam.
 *
 * Complaints arrive as ARF — RFC 5965 — which is `multipart/report` with
 * `report-type=feedback-report`, structurally the same envelope as the delivery
 * reports above. The `message/feedback-report` part carries `Feedback-Type:`,
 * of which `abuse` is the one that means a person pressed the spam button.
 *
 * This matters because it is the only complaint signal we can obtain
 * ourselves. Google judges senders on a spam rate below 0.3% and publishes
 * that figure solely through Postmaster Tools — no open-source tool can
 * produce it, because only Google holds the data. Providers that do run a
 * feedback loop send ARF, and this reads it.
 *
 * Telling it apart from a bounce is not pedantry: a complaint and a hard
 * bounce both end in suppression, but for opposite reasons — one address works
 * fine and its owner does not want us, the other does not exist. Recording the
 * wrong one makes the bounce rate lie, and the bounce rate is what halts a
 * mailbox.
 */
export function isComplaint(headers: Headers) {
  const type = (header(headers, 'content-type') ?? '').toLowerCase()
  return type.includes('report-type=feedback-report')
}

export type Complaint = {
  /** `abuse` is a spam-button press; `fraud`, `virus` and others exist. */
  feedbackType?: string
  /** Who complained, when the provider discloses it — many redact this. */
  originalRcpt?: string
  reportedBy?: string
}

export function readComplaint(part: string): Complaint {
  const unfolded = part.replace(/\r?\n[ \t]+/g, ' ')
  const field = (name: string) =>
    unfolded.match(new RegExp(`^${name}\\s*:\\s*(.+)$`, 'im'))?.[1]?.trim()

  return {
    feedbackType: field('Feedback-Type')?.toLowerCase(),
    originalRcpt: field('Original-Rcpt-To') ?? field('Original-Mail-From'),
    reportedBy: field('Reporting-MTA') ?? field('User-Agent'),
  }
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
  | { kind: 'bounce'; answering: string[]; hard: boolean; report?: Report }
  | { kind: 'complaint'; answering: string[]; complaint?: Complaint }
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
export function classify(
  headers: Headers,
  body = '',
  report?: Report,
  complaint?: Complaint,
): Verdict {
  const answering = answers(headers)

  // Before the bounce check: an ARF report is also a `multipart/report` from a
  // postmaster address, so the looser bounce test would swallow it and record
  // a complaint as a delivery failure.
  if (isComplaint(headers)) return { kind: 'complaint', answering, complaint }

  if (isBounce(headers)) {
    return {
      kind: 'bounce',
      answering,
      hard: isHardBounce(`${header(headers, 'subject') ?? ''} ${body}`, report),
      report,
    }
  }
  // Only mail that answers something of ours is ours to interpret.
  if (answering.length === 0) return { kind: 'ignore' }
  if (isAutoReply(headers)) return { kind: 'auto', answering }
  return { kind: 'reply', answering }
}
