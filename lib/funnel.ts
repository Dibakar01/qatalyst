import { and, count, desc, eq, isNotNull, sql as raw } from 'drizzle-orm'
import { db } from '../db/index.ts'
import { campaigns, contacts, conversions, enquiries, events, messages } from '../db/schema.ts'
import { isValidEmail, normalise } from './email.ts'
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

export async function recordClick(trace: Trace) {
  const messageId = await messageFor(trace)
  await db.insert(events).values({
    contactId: trace.contactId,
    messageId,
    type: 'click',
    payload: { campaignId: trace.campaignId },
  })
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
  if (contactId) await advance(contactId, 'replied')

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
 * Matching is by address, which is the only durable key across two systems —
 * and it is why the tracked link carries a token but does not need to: someone
 * who forwards the email to a colleague who then signs up is attributed to the
 * colleague, correctly.
 */
export async function recordConversion(input: {
  email: string
  event: ConversionEvent
  value?: number | null
  currency?: string | null
  at?: Date
}) {
  const email = normalise(input.email)
  if (!isValidEmail(email)) throw new Error('a valid email address is required')

  const [contact] = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(eq(contacts.email, email))
    .limit(1)

  // The most recent thing we sent them is what gets the credit. Last-touch,
  // stated plainly rather than dressed up as a model — with one letter per
  // person per campaign there is rarely anything to argue about.
  const [last] = contact
    ? await db
        .select({ id: messages.id, campaignId: messages.campaignId })
        .from(messages)
        .where(and(eq(messages.contactId, contact.id), isNotNull(messages.sentAt)))
        .orderBy(desc(messages.sentAt))
        .limit(1)
    : []

  const [row] = await db
    .insert(conversions)
    .values({
      contactId: contact?.id ?? null,
      campaignId: last?.campaignId ?? null,
      messageId: last?.id ?? null,
      event: input.event,
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
  if (contact && input.event === 'subscribed') await advance(contact.id, 'customer')

  return { recorded: Boolean(row), attributed: Boolean(last), contact: Boolean(contact) }
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
