import { and, count, desc, eq, isNotNull, sql as raw } from 'drizzle-orm'
import { db } from '../db/index.ts'
import { campaigns, contacts, conversions, enquiries, events, messages } from '../db/schema.ts'
import { isValidEmail, normalise } from './email.ts'
import { attribute } from './attribute.ts'
import { advance } from './segments.ts'
import type { Trace } from './token.ts'

/**
 * The inbound half.
 *
 * Outbound ends at `sent`; the funnel does not. A tracked link that gets
 * clicked and a form that gets filled are what the whole system is for, and
 * both are recorded against the campaign that caused them — which is the only
 * way to know whether any of this worked.
 *
 * Everything here runs on the public deployment, so it takes no session and
 * trusts nothing: the trace is an HMAC we signed, and the form fields are
 * treated as hostile.
 */

/** The message a trace points at. Unique by construction: one per pair. */
async function messageFor({ contactId, campaignId }: Trace) {
  const [row] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.campaignId, campaignId), eq(messages.contactId, contactId)))
    .limit(1)
  return row?.id ?? null
}

/**
 * Record the click and say where the reader should land.
 *
 * One round trip for both: the redirect is a person waiting on a blank tab, so
 * the destination arrives with the message it is being recorded against rather
 * than in a second query afterwards.
 *
 * Null destination means the built-in enquiry form, which is what every letter
 * written before campaigns had a destination will return.
 */
export async function recordClick(trace: Trace) {
  const [row] = await db
    .select({ id: messages.id, destination: campaigns.destinationUrl })
    .from(messages)
    .innerJoin(campaigns, eq(campaigns.id, messages.campaignId))
    .where(and(eq(messages.campaignId, trace.campaignId), eq(messages.contactId, trace.contactId)))
    .limit(1)

  await db.insert(events).values({
    contactId: trace.contactId,
    messageId: row?.id ?? null,
    type: 'click',
    payload: { campaignId: trace.campaignId },
  })

  return row?.destination ?? null
}



export type NewEnquiry = {
  email: string
  name?: string
  company?: string
  body?: string
  /** Present when they arrived through a tracked link; absent for a stranger. */
  trace?: Trace | null
}

/** Anything longer than this is a bot, not a sentence. */
const LIMIT = 4000

/**
 * Someone wrote back. Attribution is best-effort by design — an enquiry from a
 * stranger who was never on the list is still an enquiry, and is arguably the
 * better outcome.
 */
export async function recordEnquiry(input: NewEnquiry) {
  // The same validator the CSV import uses. An `@` on its own is not an
  // address, and this is a form on the public internet.
  const email = normalise(input.email)
  if (!isValidEmail(email)) throw new Error('a valid email address is required')

  const trace = input.trace ?? null
  const messageId = trace ? await messageFor(trace) : null

  // A traced enquiry belongs to that contact. An untraced one is matched by
  // address if we happen to know them, which is how a forward from a colleague
  // still lands on the right row.
  let contactId = trace?.contactId ?? null
  if (!contactId) {
    const [known] = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(eq(contacts.email, email))
      .limit(1)
    contactId = known?.id ?? null
  }

  const [row] = await db
    .insert(enquiries)
    .values({
      contactId,
      messageId,
      campaignId: trace?.campaignId ?? null,
      name: input.name?.slice(0, 200) || null,
      company: input.company?.slice(0, 200) || null,
      email,
      body: (input.body ?? '').slice(0, LIMIT),
    })
    .returning()

  // They wrote back — the pipeline learns that without anyone typing it.
  //
  // Only on a *traced* enquiry. An untraced one is matched on the address
  // alone, which anybody who knows a prospect's email can supply from a public
  // form: that would move a real contact to `replied` permanently, and
  // `audienceWhere` then excludes them from every future campaign. The enquiry
  // is still recorded either way — it is the stage change that needs evidence
  // stronger than "someone typed this address".
  if (contactId && trace) await advance(contactId, 'replied')

  await db.insert(events).values({
    contactId,
    messageId,
    type: 'enquiry',
    payload: { enquiryId: row.id, campaignId: trace?.campaignId ?? null },
  })

  return row
}

/** How many have written back. The number the whole system exists to move. */
export async function enquiryCount() {
  const [row] = await db.select({ total: count() }).from(enquiries)
  return row.total
}

/**
 * Everyone who wrote back, newest first, with the letter that caused it when
 * there was one. Same shape as the other paged queries, so it needs no pager
 * of its own.
 */
export async function listEnquiries({ page = 1, size = 12 } = {}) {
  const [rows, [{ total }]] = await Promise.all([
    db
      .select({ enquiry: enquiries, campaign: campaigns })
      .from(enquiries)
      .leftJoin(campaigns, eq(campaigns.id, enquiries.campaignId))
      .orderBy(desc(enquiries.createdAt))
      .limit(size)
      .offset((Math.max(page, 1) - 1) * size),
    db.select({ total: count() }).from(enquiries),
  ])
  return { rows, total, page: Math.max(page, 1), pages: Math.max(Math.ceil(total / size), 1) }
}

/* ── conversions ──────────────────────────────────────────────────────────── */

export type ConversionEvent = 'visited' | 'signed_up' | 'subscribed'

/**
 * The other side reporting back.
 *
 * Your product owns signup and billing; it tells us when someone crossed a
 * line, and we attribute it to the letter that started them off. This is the
 * server-side conversions model rather than a pixel: it survives ad blockers,
 * cross-domain navigation, and a subscription that arrives three months after
 * the email.
 *
 * Two ways in, one rule. A server-to-server call knows the address; the pixel
 * knows the signed click id. Either identifies a conversion, and when both are
 * present `attribute()` decides — the token names the campaign, the address
 * names the person.
 *
 * The precedence lives in lib/attribute.ts rather than here, and this is the
 * only place that writes a conversion, so no caller can route around it.
 */
export async function recordConversion(input: {
  email?: string | null
  /** The signed click id from a tracked link, if the pixel had one. */
  trace?: Trace | null
  event: ConversionEvent
  /** The caller's id for this transaction — an invoice number is the natural one. */
  eventId?: string | null
  /**
   * Whether the caller proved who it is.
   *
   * A conversion report is an *observation* and anyone may make one; moving a
   * contact along the pipeline is a *decision* and only a trusted caller may.
   * The browser pixel is authenticated by a key that ships in page source, so
   * it reports and nothing more. `/api/conversion` carries a bearer secret and
   * may decide.
   *
   * Defaults to false so a new caller has to ask for the power rather than
   * inherit it by forgetting.
   */
  trusted?: boolean
  value?: number | null
  currency?: string | null
  at?: Date
}) {
  const email = input.email ? normalise(input.email) : ''
  if (email && !isValidEmail(email)) throw new Error('that is not a valid email address')
  // One or the other. Without either there is nobody to attribute this to, and
  // a conversion attached to nobody is a row that can only mislead.
  if (!email && !input.trace) throw new Error('an email address or a click id is required')

  const [known] = email
    ? await db.select({ id: contacts.id }).from(contacts).where(eq(contacts.email, email)).limit(1)
    : []

  // Last-touch: the most recent thing we actually sent whoever this is. A
  // default rather than a claim, and the token overrules it when there is one.
  const who = known?.id ?? input.trace?.contactId ?? null
  const [last] = who
    ? await db
        .select({ id: messages.id, campaignId: messages.campaignId })
        .from(messages)
        .where(and(eq(messages.contactId, who), isNotNull(messages.sentAt)))
        .orderBy(desc(messages.sentAt))
        .limit(1)
    : []

  const credit = attribute(input.trace, known?.id ?? null, last)
  const contact = credit.contactId ? { id: credit.contactId } : undefined

  const [row] = await db
    .insert(conversions)
    .values({
      contactId: credit.contactId,
      campaignId: credit.campaignId,
      messageId: credit.messageId,
      event: input.event,
      // Empty, never null — the unique key depends on it.
      eventId: input.eventId ?? '',
      value: input.value ?? null,
      currency: input.currency ?? null,
      ...(input.at ? { createdAt: input.at } : {}),
    })
    // At-least-once delivery is the norm for webhooks, so a retry must not
    // invoice us twice. The unique index does the work.
    .onConflictDoNothing()
    .returning()

  // Paying is the strongest signal the pipeline can get, and the machine
  // should not need a person to type it in.
  // Only a trusted caller moves the pipeline. `advance()` never goes backwards,
  // so an unauthenticated stranger doing this would permanently mark a real
  // contact a customer, and nothing in the app can undo it.
  if (input.trusted && contact && input.event === 'subscribed') {
    await advance(contact.id, 'customer')
  }

  return {
    recorded: Boolean(row),
    attributed: Boolean(credit.campaignId),
    contact: Boolean(credit.contactId),
    basis: credit.basis,
    forwarded: credit.forwarded,
  }
}

/** The funnel, end to end, for the reports. */
export async function conversionCounts() {
  const rows = await db.execute<{ event: string; n: number; value: number | null }>(raw`
    select event::text as event, count(*)::int as n, sum(coalesce(value, 0))::int as value
    from conversions group by 1
  `)
  const by = new Map(rows.map((r) => [r.event, r]))
  return {
    visited: Number(by.get('visited')?.n ?? 0),
    signedUp: Number(by.get('signed_up')?.n ?? 0),
    subscribed: Number(by.get('subscribed')?.n ?? 0),
    revenue: Number(by.get('subscribed')?.value ?? 0),
  }
}
