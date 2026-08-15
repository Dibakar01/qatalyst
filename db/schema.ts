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

/**
 * What happened on the other side, after the click.
 *
 * Your product owns signup and billing and posts these back — the same shape
 * as an ad platform's server-side conversions API. No pixel, no cross-domain
 * cookie, and it still works when somebody subscribes three months later.
 */
export const conversionEvent = pgEnum('conversion_event', ['visited', 'signed_up', 'subscribed'])

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

/**
 * How far along a person is, in order.
 *
 * One stage each, and they move forward. The system advances what it actually
 * knows — writing to someone makes them `contacted`, an enquiry makes them
 * `replied` — so the pipeline reflects what happened rather than what somebody
 * remembered to type. The last two are judgements and stay manual.
 */
export const stage = pgEnum('stage', ['new', 'contacted', 'replied', 'qualified', 'customer'])

export const STAGES = stage.enumValues

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
    /**
     * Overlapping named groups: "SaaS founders", "met at PyCon".
     *
     * ponytail: a text[] with a GIN index rather than a segments table and a
     * join. Segments carry no attributes beyond a name, so two tables would be
     * two tables to keep in step for nothing. Renaming one rewrites the rows
     * that have it — fine to a few hundred thousand contacts; promote to real
     * tables if a segment ever needs to own anything.
     */
    segments: text('segments').array().notNull().default(sql`'{}'::text[]`),
    stage: stage('stage').notNull().default('new'),
    stageAt: timestamp('stage_at', { withTimezone: true }).notNull().defaultNow(),
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
    index('contacts_stage_idx').on(t.stage),
    // Containment queries (segments @> '{x}') need GIN, not btree.
    index('contacts_segments_idx').using('gin', t.segments),
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
  /**
   * Who this letter is for. Empty means everyone sendable, which is what a
   * campaign written before segments existed still means.
   */
  audienceSegments: text('audience_segments').array().notNull().default(sql`'{}'::text[]`),
  audienceStages: text('audience_stages').array().notNull().default(sql`'{}'::text[]`),
  channel: channel('channel').notNull().default('email'),
  /**
   * Where a tracked link lands. Null means the built-in enquiry form.
   *
   * Resolved at redirect time rather than baked into the body, so changing it
   * fixes letters already sitting in inboxes — which is the whole reason the
   * body stores `/r/<token>` and never the destination.
   */
  destinationUrl: text('destination_url'),
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
  /**
   * Basis points of sends that opt out before a mailbox stops itself.
   *
   * Google judges on spam complaints under 0.3%, and that figure lives only in
   * Postmaster Tools. Opt-outs are the leading indicator we can actually see.
   */
  unsubscribeThreshold: integer('unsubscribe_threshold').notNull().default(200),
  /**
   * Practice: run everything, deliver nothing.
   *
   * Separate from whether a Gmail key exists. A key can be present and correct
   * and this still holds the post, so the whole flow can be exercised without
   * one real email leaving. It can only ever make sending safer.
   */
  practice: boolean('practice').notNull().default(false),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * A sending domain, and where its Google credential is found.
 *
 * Cold outbound spreads across several domains so the primary one survives:
 * volume is split, each is warmed separately, and one burning does not stop
 * the others. Google's domain-wide delegation is per-Workspace, so a domain in
 * its own Workspace needs its own service account.
 *
 * `credentialKey` names an environment variable — `QALAKAAR` reads
 * `GOOGLE_SA_QALAKAAR`. The key itself is never stored here, so a database
 * backup never contains a Workspace-wide private key.
 */
export const domains = pgTable('domains', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull().unique(),
  credentialKey: text('credential_key'),
  /**
   * When warming began. Null means established — already warmed, so its
   * mailbox caps stand as configured.
   */
  warmingSince: timestamp('warming_since', { withTimezone: true }),
  /**
   * What the whole domain may send in a day, across every mailbox on it.
   *
   * Separate from the per-mailbox cap, and the one that protects the asset:
   * five mailboxes at 50 puts a domain at 250, eight puts it at 400, and the
   * reputation that burns belongs to the domain rather than to any one box.
   * Published guidance settles around 250; the clamp keeps it near there.
   */
  dailyCap: integer('daily_cap').notNull().default(250),
  /**
   * What Google says about this domain, from Postmaster Tools.
   *
   * The only source for the spam rate Google actually judges senders on —
   * nothing open-source can produce it, because only Google holds the data.
   * Stored as the 95% upper bound in basis points rather than the point
   * estimate: Google publishes both, and for a decision that can burn a domain
   * the honest question is "how bad could this be", not "what is the average".
   */
  spamRatio: integer('spam_ratio'),
  /** HIGH, MEDIUM, LOW or BAD, as Google categorises it. */
  reputation: text('reputation'),
  statsAt: timestamp('stats_at', { withTimezone: true }),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const mailboxes = pgTable('mailboxes', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  // Null for mailboxes that predate domains; the sender falls back to the
  // single legacy credential for those.
  domainId: uuid('domain_id').references(() => domains.id, { onDelete: 'set null' }),
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
    /**
     * How many times delivery has been tried.
     *
     * Without this a failed send stayed `approved` with only an error recorded,
     * and the queue ordered errored rows first — so one undeliverable message
     * was retried every sixty seconds forever and nothing else on that mailbox
     * ever went out. Counted so it can back off and eventually give up.
     */
    attempts: integer('attempts').notNull().default(0),
    /** Earliest next try. Null means now. */
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    sentAt: timestamp('sent_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('messages_campaign_contact_key').on(t.campaignId, t.contactId),
    index('messages_message_id_header_idx').on(t.messageIdHeader),
    // messages is the fastest-growing table and every report filters it by
    // status. Without this the reports stay fast until they all get slow at
    // once, which reads as the reports being broken rather than the schema.
    index('messages_status_idx').on(t.status),
    // The sender's queue is (status, campaign) and the daily counters are
    // (mailbox, sent_at) — both hot paths on every tick.
    index('messages_mailbox_sent_idx').on(t.mailboxId, t.sentAt),
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

/**
 * Someone got far enough to matter.
 *
 * Unique on (contact, event) so a retried webhook cannot count a subscription
 * twice — a delivery guarantee is normally at-least-once, and revenue that
 * double-counts is worse than revenue that is late.
 *
 * `value` is in minor units, which is what turns "which source is worth
 * paying for" from a count into an answer.
 */
export const conversions = pgTable(
  'conversions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    contactId: uuid('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
    campaignId: uuid('campaign_id').references(() => campaigns.id, { onDelete: 'set null' }),
    messageId: uuid('message_id').references(() => messages.id, { onDelete: 'set null' }),
    event: conversionEvent('event').notNull(),
    /**
     * The caller's own id for this transaction — an invoice number is the
     * natural one. Empty string, never null, for callers that do not send one.
     *
     * Empty rather than null on purpose. It makes the unique key below work
     * under ordinary SQL null semantics, which is what keeps two *different*
     * anonymous visitors from colliding with each other.
     */
    eventId: text('event_id').notNull().default(''),
    /** Minor units — pence, paise, cents. Null when the step carries no money. */
    value: integer('value'),
    currency: text('currency'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /**
     * A subscription is a transaction, not a funnel step: a renewal and an
     * upgrade are both revenue, and counting only the first under-reports
     * worst for exactly the best accounts. So the caller's id is part of the
     * key.
     *
     * The null semantics here need care, and the first attempt got them
     * wrong. A nullable `event_id` deduplicates nothing, because Postgres
     * treats nulls as distinct — a retried webhook from a caller sending no id
     * would double-count. But `NULLS NOT DISTINCT`, which fixes that, also
     * makes `contact_id` nulls collide: two *different* anonymous visitors
     * would silently become one, and erasing a contact could violate the
     * constraint outright.
     *
     * Defaulting `event_id` to the empty string solves both at once. No id
     * dedupes on (contact, event) as it always did; an id dedupes per
     * transaction; and an unattributed conversion keeps a null contact, which
     * stays distinct — so every stranger is counted.
     */
    uniqueIndex('conversions_contact_event_key').on(t.contactId, t.event, t.eventId),
    index('conversions_campaign_idx').on(t.campaignId),
  ],
)

/**
 * Mail our own mailboxes send each other, to earn a new domain its reputation.
 *
 * Deliberately not in `messages`. Warm-up mail has no contact and no campaign,
 * and every report counts rows in that table — so a warm-up send living there
 * would appear as a send no prospect ever received, and quietly corrupt the
 * reply and click rates the whole system is judged on.
 */
export const warmups = pgTable(
  'warmups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    fromMailbox: text('from_mailbox').notNull(),
    toMailbox: text('to_mailbox').notNull(),
    /** What Gmail assigned it, so the reply can be threaded onto it. */
    messageIdHeader: text('message_id_header'),
    sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
    /** When the other side answered. An unanswered send is a weaker signal. */
    repliedAt: timestamp('replied_at', { withTimezone: true }),
  },
  (t) => [
    index('warmups_message_id_idx').on(t.messageIdHeader),
    index('warmups_to_idx').on(t.toMailbox, t.repliedAt),
  ],
)

export type Contact = typeof contacts.$inferSelect
export type NewContact = typeof contacts.$inferInsert
export type Campaign = typeof campaigns.$inferSelect
export type Message = typeof messages.$inferSelect
export type Mailbox = typeof mailboxes.$inferSelect
export type Connector = typeof connectors.$inferSelect
export type Enquiry = typeof enquiries.$inferSelect
export type Conversion = typeof conversions.$inferSelect
export type Warmup = typeof warmups.$inferSelect
export type Settings = typeof settings.$inferSelect
export type Domain = typeof domains.$inferSelect
