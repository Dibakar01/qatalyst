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
export const eventType = pgEnum('event_type', [
  'sent',
  'bounce',
  'reply',
  'unsubscribe',
  'complaint',
  // The funnel does not end at "sent". A tracked link that gets clicked and a
  // form that gets filled are the other half of the distribution system.
  'click',
  'enquiry',
])

/** Where contacts come from. Each is a source Qatalyst can be pointed at. */
export const connectorKind = pgEnum('connector_kind', ['csv', 'apollo', 'linkedin'])

/**
 * How a campaign reaches someone. Email is the only one built.
 *
 * This exists so the sender dispatches on a column rather than assuming, which
 * makes a second channel an adapter beside lib/gmail.ts instead of a migration.
 */
export const channel = pgEnum('channel', ['email'])

/**
 * Who started it. `outbound` is us writing first.
 *
 * `response` is reserved for a campaign an enquiry triggers — deliberately not
 * built, but the column is here so adding it later is not a migration of every
 * existing row.
 */
export const campaignKind = pgEnum('campaign_kind', ['outbound', 'response'])

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
  channel: channel('channel').notNull().default('email'),
  kind: campaignKind('kind').notNull().default('outbound'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * The sending rules, as data rather than constants.
 *
 * These were `const` in lib/rules.ts, which meant the one thing a person most
 * needs to control while warming a domain — how hard to push — could only be
 * changed by editing code. One row, always id 1: this is configuration for a
 * single installation, not a per-tenant table pretending to be one.
 *
 * Every value is clamped on write. Being able to tune the bounce threshold is
 * not the same as being able to set it to 50% and burn the domain.
 */
export const settings = pgTable('settings', {
  id: integer('id').primaryKey().default(1),
  /** Minutes past midnight, local. */
  windowStart: integer('window_start').notNull().default(9 * 60),
  windowEnd: integer('window_end').notNull().default(17 * 60),
  /** Percent, stored as basis points so it needs no float. 300 = 3.00%. */
  bounceThreshold: integer('bounce_threshold').notNull().default(300),
  /** Attempts before the threshold means anything at all. */
  bounceMinimum: integer('bounce_minimum').notNull().default(20),
  catchAllCap: integer('catch_all_cap').notNull().default(10),
  draftBatch: integer('draft_batch').notNull().default(25),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
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

/**
 * A configured source, optionally belonging to one campaign.
 *
 * A campaign can have several — Apollo for the search, a LinkedIn export for
 * the list you built by hand — which is what makes this a distribution system
 * rather than a mailer. `config` is per-kind and deliberately loose: an Apollo
 * connector holds its search, a LinkedIn one holds which exporter's columns to
 * expect.
 */
export const connectors = pgTable(
  'connectors',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Null means account-wide: a source that feeds the contact list itself
    // rather than one campaign.
    campaignId: uuid('campaign_id').references(() => campaigns.id, { onDelete: 'cascade' }),
    kind: connectorKind('kind').notNull(),
    name: text('name').notNull(),
    config: jsonb('config').$type<Record<string, string>>().notNull().default({}),
    active: boolean('active').notNull().default(true),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    lastResult: text('last_result'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('connectors_campaign_idx').on(t.campaignId)],
)

/**
 * The other end of the funnel: someone wrote back through the website.
 *
 * Nullable everywhere it points, because an enquiry from a stranger who was
 * never on the list is still an enquiry — and is in fact the outcome the whole
 * system exists to produce.
 */
export const enquiries = pgTable(
  'enquiries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    contactId: uuid('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
    messageId: uuid('message_id').references(() => messages.id, { onDelete: 'set null' }),
    campaignId: uuid('campaign_id').references(() => campaigns.id, { onDelete: 'set null' }),
    name: text('name'),
    email: text('email').notNull(),
    company: text('company'),
    body: text('body').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('enquiries_campaign_idx').on(t.campaignId)],
)

export type Contact = typeof contacts.$inferSelect
export type NewContact = typeof contacts.$inferInsert
export type Campaign = typeof campaigns.$inferSelect
export type Message = typeof messages.$inferSelect
export type Mailbox = typeof mailboxes.$inferSelect
export type Connector = typeof connectors.$inferSelect
export type Enquiry = typeof enquiries.$inferSelect
export type Settings = typeof settings.$inferSelect
