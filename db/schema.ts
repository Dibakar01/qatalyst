import { sql } from 'drizzle-orm'
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

export const emailStatus = pgEnum('email_status', ['unverified', 'verified', 'catch_all', 'invalid'])
export const consentStatus = pgEnum('consent_status', ['none', 'opted_in'])
export const suppressionReason = pgEnum('suppression_reason', [
  'unsubscribed',
  'bounced',
  'complained',
  'customer',
  'competitor',
  'manual',
])
export const campaignStatus = pgEnum('campaign_status', ['draft', 'ready', 'sending', 'done'])
export const messageStatus = pgEnum('message_status', [
  'draft',
  'flagged',
  'approved',
  'sent',
  'bounced',
  'replied',
])
export const eventType = pgEnum('event_type', ['sent', 'bounce', 'reply', 'unsubscribe', 'complaint'])

export const contacts = pgTable(
  'contacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    firstName: text('first_name'),
    lastName: text('last_name'),
    email: text('email'),
    emailStatus: emailStatus('email_status').notNull().default('unverified'),
    company: text('company'),
    title: text('title'),
    linkedinUrl: text('linkedin_url'),
    source: text('source'),
    consentStatus: consentStatus('consent_status').notNull().default('none'),
    context: jsonb('context').$type<Record<string, string>>().notNull().default({}),
    erasedAt: timestamp('erased_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // NULLs are distinct in Postgres, so emailless / erased rows don't collide.
    // Both indexes are what makes re-importing the same CSV a no-op.
    uniqueIndex('contacts_email_lower_key').on(sql`lower(${t.email})`),
    uniqueIndex('contacts_linkedin_url_key').on(t.linkedinUrl),
    index('contacts_company_idx').on(t.company),
  ],
)

/**
 * Hash only, never the address: a contact row can be erased on request while the
 * suppression survives. No delete path for these, by design.
 */
export const suppressions = pgTable(
  'suppressions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    emailHash: text('email_hash'),
    domain: text('domain'),
    reason: suppressionReason('reason').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('suppressions_email_hash_key').on(t.emailHash),
    uniqueIndex('suppressions_domain_key').on(t.domain),
  ],
)

export const campaigns = pgTable('campaigns', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  subjectTemplate: text('subject_template').notNull().default(''),
  // Must contain {{personalised}} — the one slot the model writes. Everything
  // else is fixed text, which is what makes the validators exact.
  bodyTemplate: text('body_template').notNull().default(''),
  prompt: text('prompt').notNull().default(''),
  status: campaignStatus('status').notNull().default('draft'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const mailboxes = pgTable('mailboxes', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  dailyCap: integer('daily_cap').notNull().default(35),
  sendsCatchAll: boolean('sends_catch_all').notNull().default(false),
  active: boolean('active').notNull().default(true),
})

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'cascade' }),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    subject: text('subject').notNull().default(''),
    body: text('body').notNull().default(''),
    status: messageStatus('status').notNull().default('draft'),
    validatorFlags: jsonb('validator_flags').$type<string[]>().notNull().default([]),
    mailboxId: uuid('mailbox_id').references(() => mailboxes.id),
    // RFC 5322 Message-ID of the sent mail. Without it, replies and bounces
    // cannot be matched back to what we sent (phase 4).
    messageIdHeader: text('message_id_header'),
    error: text('error'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('messages_campaign_contact_key').on(t.campaignId, t.contactId),
    index('messages_message_id_header_idx').on(t.messageIdHeader),
  ],
)

export const events = pgTable(
  'events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    contactId: uuid('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
    messageId: uuid('message_id').references(() => messages.id, { onDelete: 'set null' }),
    type: eventType('type').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('events_contact_idx').on(t.contactId)],
)

export type Contact = typeof contacts.$inferSelect
export type NewContact = typeof contacts.$inferInsert
export type Campaign = typeof campaigns.$inferSelect
export type Message = typeof messages.$inferSelect
export type Mailbox = typeof mailboxes.$inferSelect
