import { sql as raw } from 'drizzle-orm'
import { db } from '../db/index.ts'
import { shouldHalt, type Tuning } from './rules.ts'

/**
 * The three questions worth asking.
 *
 *   by source   is what I am paying for producing anything?
 *   by mailbox  is it safe to keep sending today?
 *   by letter   is the writing landing?
 *
 * Everything is derived from rows that already exist — `contacts.source`
 * records provenance on import, `events` records clicks and enquiries. Nothing
 * here is a counter that could drift out of step with the thing it counts.
 */

const pct = (part: number, whole: number) => (whole > 0 ? part / whole : 0)

/* ── by source ────────────────────────────────────────────────────────────── */

export type SourceRow = {
  source: string
  contacts: number
  sendable: number
  written: number
  sent: number
  clicked: number
  enquired: number
  /** Enquiries per thousand sent. The number that decides renewal. */
  yieldPerThousand: number
  /** Days between the first send and the first enquiry, or null if none yet. */
  daysToFirst: number | null
}

/**
 * The funnel per source, and the drop-off at each hop.
 *
 * A source that imports ten thousand contacts of which none are sendable is
 * worse than one that imports fifty verified ones, and only this shows that.
 */
export async function bySource(): Promise<SourceRow[]> {
  const rows = await db.execute<{
    source: string
    contacts: number
    sendable: number
    written: number
    sent: number
    clicked: number
    enquired: number
    days_to_first: number | null
  }>(raw`
    select
      coalesce(c.source, 'unknown')                                          as source,
      count(distinct c.id)                                                   as contacts,
      count(distinct c.id) filter (
        where c.email_status in ('verified','catch_all') and c.erased_at is null
      )                                                                      as sendable,
      count(distinct m.id)                                                   as written,
      count(distinct m.id) filter (where m.status in ('sent','bounced','replied')) as sent,
      count(distinct e.id) filter (where e.type = 'click')                   as clicked,
      count(distinct q.id)                                                   as enquired,
      extract(day from min(q.created_at) - min(m.sent_at))                   as days_to_first
    from contacts c
    left join messages  m on m.contact_id = c.id
    left join events    e on e.contact_id = c.id
    left join enquiries q on q.contact_id = c.id
    group by 1
    order by count(distinct c.id) desc
  `)

  return rows.map((r) => ({
    source: r.source,
    contacts: Number(r.contacts),
    sendable: Number(r.sendable),
    written: Number(r.written),
    sent: Number(r.sent),
    clicked: Number(r.clicked),
    enquired: Number(r.enquired),
    yieldPerThousand: pct(Number(r.enquired), Number(r.sent)) * 1000,
    daysToFirst: r.days_to_first === null ? null : Number(r.days_to_first),
  }))
}

/* ── by mailbox ───────────────────────────────────────────────────────────── */

export type MailboxRow = {
  email: string
  cap: number
  sentToday: number
  sentEver: number
  bounced: number
  bounceRate: number
  catchAllShare: number
  halted: boolean
  /** How close to the halt line, 0–1. Above 0.7 is worth looking at. */
  towardHalt: number
}

export async function byMailbox(rules: Required<Tuning>): Promise<MailboxRow[]> {
  const rows = await db.execute<{
    email: string
    daily_cap: number
    sent_today: number
    sent_ever: number
    bounced: number
    catch_all: number
  }>(raw`
    select
      b.email,
      b.daily_cap,
      count(*) filter (where m.status = 'sent' and m.sent_at::date = current_date) as sent_today,
      count(*) filter (where m.status = 'sent')                                    as sent_ever,
      count(*) filter (where m.status = 'bounced')                                 as bounced,
      count(*) filter (where m.status = 'sent' and c.email_status = 'catch_all')   as catch_all
    from mailboxes b
    left join messages m on m.mailbox_id = b.id
    left join contacts c on c.id = m.contact_id
    group by b.id, b.email, b.daily_cap
    order by b.email
  `)

  return rows.map((r) => {
    const sent = Number(r.sent_ever)
    const bounced = Number(r.bounced)
    const attempts = sent + bounced
    const rate = pct(bounced, attempts)
    return {
      email: r.email,
      cap: Number(r.daily_cap),
      sentToday: Number(r.sent_today),
      sentEver: sent,
      bounced,
      bounceRate: rate,
      catchAllShare: pct(Number(r.catch_all), sent),
      halted: shouldHalt(sent, bounced, rules),
      // Below the sample minimum the rate means nothing, so the gauge stays at
      // zero rather than showing alarming noise on four sends.
      towardHalt:
        attempts < rules.bounceMinimum ? 0 : Math.min(rate / (rules.bounceThreshold / 10_000), 1),
    }
  })
}

/* ── by letter ────────────────────────────────────────────────────────────── */

export type LetterRow = {
  id: string
  name: string
  status: string
  written: number
  flagged: number
  /** Share the readers objected to. High means the prompt is inventing things. */
  flagRate: number
  approved: number
  sent: number
  clicked: number
  replied: number
  clickRate: number
  replyRate: number
}

export async function byLetter(): Promise<LetterRow[]> {
  const rows = await db.execute<{
    id: string
    name: string
    status: string
    written: number
    flagged: number
    approved: number
    sent: number
    clicked: number
    replied: number
  }>(raw`
    select
      k.id::text, k.name, k.status::text,
      count(m.id)                                                     as written,
      count(m.id) filter (where m.status = 'flagged'
                            or jsonb_array_length(m.validator_flags) > 0) as flagged,
      count(m.id) filter (where m.status = 'approved')                as approved,
      count(m.id) filter (where m.status in ('sent','bounced','replied')) as sent,
      count(distinct e.id) filter (where e.type = 'click')            as clicked,
      count(distinct q.id)                                            as replied
    from campaigns k
    left join messages  m on m.campaign_id = k.id
    left join events    e on e.message_id  = m.id
    left join enquiries q on q.campaign_id = k.id
    group by k.id, k.name, k.status
    order by k.created_at desc
  `)

  return rows.map((r) => {
    const written = Number(r.written)
    const sent = Number(r.sent)
    return {
      id: r.id,
      name: r.name,
      status: r.status,
      written,
      flagged: Number(r.flagged),
      flagRate: pct(Number(r.flagged), written),
      approved: Number(r.approved),
      sent,
      clicked: Number(r.clicked),
      replied: Number(r.replied),
      clickRate: pct(Number(r.clicked), sent),
      replyRate: pct(Number(r.replied), sent),
    }
  })
}

/* ── the list's health ────────────────────────────────────────────────────── */

/**
 * How fast the list is being burned.
 *
 * Suppressions only ever grow, so the rate they grow at is the honest measure
 * of whether the outreach is working or annoying people. Nothing else surfaces
 * it, and by the time it is obvious it is usually too late.
 */
export async function listHealth() {
  const [row] = await db.execute<{
    total: number
    last7: number
    last30: number
    unsubscribed: number
    bounced: number
  }>(raw`
    select
      count(*)                                                          as total,
      count(*) filter (where created_at > now() - interval '7 days')    as last7,
      count(*) filter (where created_at > now() - interval '30 days')   as last30,
      count(*) filter (where reason = 'unsubscribed')                   as unsubscribed,
      count(*) filter (where reason = 'bounced')                        as bounced
    from suppressions
  `)
  return {
    total: Number(row.total),
    last7: Number(row.last7),
    last30: Number(row.last30),
    unsubscribed: Number(row.unsubscribed),
    bounced: Number(row.bounced),
  }
}
