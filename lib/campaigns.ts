import { and, desc, eq, inArray, isNotNull, isNull, notInArray, sql as raw } from 'drizzle-orm'
import { db } from '../db/index.ts'
import { campaigns, contacts, messages, type Campaign, type Message } from '../db/schema.ts'
import { SENDABLE } from './contacts.ts'

const tally = {
  drafts: raw<number>`count(*) filter (where ${messages.status} = 'draft')`.mapWith(Number),
  flagged: raw<number>`count(*) filter (where ${messages.status} = 'flagged')`.mapWith(Number),
  approved: raw<number>`count(*) filter (where ${messages.status} = 'approved')`.mapWith(Number),
  sent: raw<number>`count(*) filter (where ${messages.status} = 'sent')`.mapWith(Number),
}

export type Counts = { drafts: number; flagged: number; approved: number; sent: number }

export async function listCampaigns() {
  return db
    .select({ campaign: campaigns, ...tally })
    .from(campaigns)
    .leftJoin(messages, eq(messages.campaignId, campaigns.id))
    .groupBy(campaigns.id)
    .orderBy(desc(campaigns.createdAt))
}

export async function getCampaign(id: string): Promise<Campaign | undefined> {
  const [row] = await db.select().from(campaigns).where(eq(campaigns.id, id))
  return row
}

export async function counts(id: string): Promise<Counts> {
  const [row] = await db.select(tally).from(messages).where(eq(messages.campaignId, id))
  return row
}

/** Contacts this campaign could still write to: sendable, not erased, not already drafted. */
export async function audienceSize(campaignId: string) {
  const [row] = await db
    .select({ total: raw<number>`count(*)`.mapWith(Number) })
    .from(contacts)
    .where(
      and(
        inArray(contacts.emailStatus, SENDABLE),
        isNull(contacts.erasedAt),
        isNotNull(contacts.email),
        notInArray(
          contacts.id,
          db.select({ id: messages.contactId }).from(messages).where(eq(messages.campaignId, campaignId)),
        ),
      ),
    )
  return row.total
}

export async function createCampaign(name: string) {
  const [row] = await db
    .insert(campaigns)
    .values({
      name,
      subjectTemplate: 'A quick question about {{company}}',
      bodyTemplate: `Hi {{first_name}},\n\n{{personalised}}\n\nWorth a short call next week?\n\nDibakar`,
      prompt: 'Say why we are writing to this person in particular.',
    })
    .returning()
  return row
}

export async function saveCampaign(id: string, patch: Partial<Campaign>) {
  await db
    .update(campaigns)
    .set({
      name: patch.name,
      subjectTemplate: patch.subjectTemplate,
      bodyTemplate: patch.bodyTemplate,
      prompt: patch.prompt,
    })
    .where(eq(campaigns.id, id))
}

export async function reviewQueue(campaignId: string, limit = 50) {
  return db
    .select({ message: messages, contact: contacts })
    .from(messages)
    .innerJoin(contacts, eq(contacts.id, messages.contactId))
    .where(
      and(eq(messages.campaignId, campaignId), inArray(messages.status, ['draft', 'flagged'])),
    )
    .orderBy(messages.status, messages.id)
    .limit(limit)
}

export async function sentMessages(campaignId: string, limit = 50) {
  return db
    .select({ message: messages, contact: contacts })
    .from(messages)
    .innerJoin(contacts, eq(contacts.id, messages.contactId))
    .where(and(eq(messages.campaignId, campaignId), eq(messages.status, 'sent')))
    .orderBy(desc(messages.sentAt))
    .limit(limit)
}

/** Statuses that mean the message has left. Phase 4 adds to this, not beside it. */
export const GONE: Message['status'][] = ['sent', 'bounced', 'replied']

/**
 * Everything that has actually gone out, across every campaign.
 *
 * Keyed off the message status rather than a `sent` boolean, so when replies
 * and bounces start arriving they land on this same surface instead of needing
 * their own. Returns the same shape as listContacts() so the pager it feeds
 * needs to know nothing about it.
 */
export async function sentLog({
  q = '',
  page = 1,
  size = 12,
}: {
  q?: string
  page?: number
  size?: number
}) {
  const where = and(
    inArray(messages.status, GONE),
    q
      ? raw`(${contacts.email} ilike ${'%' + q + '%'}
          or ${contacts.company} ilike ${'%' + q + '%'}
          or ${campaigns.name} ilike ${'%' + q + '%'})`
      : undefined,
  )

  const [rows, [{ total }]] = await Promise.all([
    db
      .select({ message: messages, contact: contacts, campaign: campaigns })
      .from(messages)
      .innerJoin(contacts, eq(contacts.id, messages.contactId))
      .innerJoin(campaigns, eq(campaigns.id, messages.campaignId))
      .where(where)
      .orderBy(desc(messages.sentAt))
      .limit(size)
      .offset((Math.max(page, 1) - 1) * size),
    db
      .select({ total: raw<number>`count(*)`.mapWith(Number) })
      .from(messages)
      .innerJoin(contacts, eq(contacts.id, messages.contactId))
      .innerJoin(campaigns, eq(campaigns.id, messages.campaignId))
      .where(where),
  ])

  return { rows, total, page: Math.max(page, 1), pages: Math.max(Math.ceil(total / size), 1) }
}

export const approveMessage = (id: string) =>
  db.update(messages).set({ status: 'approved' }).where(eq(messages.id, id))

export const rejectMessage = (id: string) =>
  db.delete(messages).where(eq(messages.id, id))

/**
 * Rule 5, encoded: bulk approval only ever touches messages that passed both
 * validators. A flagged message can still be approved, but only one at a time,
 * by someone who has looked at it.
 */
export const approveUnflagged = (campaignId: string) =>
  db
    .update(messages)
    .set({ status: 'approved' })
    .where(and(eq(messages.campaignId, campaignId), eq(messages.status, 'draft')))

export const setCampaignStatus = (id: string, status: Campaign['status']) =>
  db.update(campaigns).set({ status }).where(eq(campaigns.id, id))
