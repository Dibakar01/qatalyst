import { and, count, desc, eq } from 'drizzle-orm'
import { db } from '../db/index.ts'
import { campaigns, contacts, enquiries, events, messages } from '../db/schema.ts'
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
