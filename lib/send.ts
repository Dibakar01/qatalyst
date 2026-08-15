import { and, eq, inArray, isNotNull, isNull, lte, or, sql as raw } from 'drizzle-orm'
import { db } from '../db/index.ts'
import { campaigns, contacts, domains, events, mailboxes, messages } from '../db/schema.ts'
import { deliver, isConfigured } from './gmail.ts'
import { afterFailure, allowanceNow, daysSince, maySend, shouldHalt, warmupCap } from './rules.ts'
import { tuning } from './settings.ts'
import { suppressionIndex } from './suppression.ts'

/** Rule 3: at most one send per mailbox per tick, so a backlog can never burst. */
const PER_TICK = 1

const minuteOfDay = (now: Date) => now.getHours() * 60 + now.getMinutes()

// The daily cap is a local-calendar-day cap, so compare against a local date
// string rather than a UTC instant. Assumes app and database share a timezone.
const localDay = (now: Date) =>
  `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`

export type TickResult = { sent: number; halted: string[]; dryRun: boolean; detail: string[] }

export type MailboxStats = {
  sentToday: number
  catchAllToday: number
  sentEver: number
  bouncedEver: number
}

/**
 * Everything the rules need to know about one mailbox at one moment. The sender
 * asks before each tick; the control centre asks to show the same numbers on
 * screen. One definition, so what you are looking at is exactly what the sender
 * will act on rather than a second opinion that drifts.
 */
/**
 * Every mailbox's counters in one query.
 *
 * `mailboxStats` used to be called once per mailbox inside the send loop — four
 * mailboxes meant four round trips a minute, and it grew with the estate. The
 * numbers are the same; they now arrive together.
 */
export async function allMailboxStats(now = new Date()): Promise<Map<string, MailboxStats>> {
  const rows = await db
    .select({
      mailboxId: messages.mailboxId,
      sentToday: raw<number>`count(*) filter (
        where ${messages.sentAt}::date = ${localDay(now)}::date and ${messages.status} = 'sent'
      )`.mapWith(Number),
      catchAllToday: raw<number>`count(*) filter (
        where ${messages.sentAt}::date = ${localDay(now)}::date
          and ${messages.status} = 'sent'
          and ${contacts.emailStatus} = 'catch_all'
      )`.mapWith(Number),
      sentEver: raw<number>`count(*) filter (where ${messages.status} = 'sent')`.mapWith(Number),
      bouncedEver: raw<number>`count(*) filter (where ${messages.status} = 'bounced')`.mapWith(Number),
    })
    .from(messages)
    .innerJoin(contacts, eq(contacts.id, messages.contactId))
    .where(isNotNull(messages.mailboxId))
    .groupBy(messages.mailboxId)

  return new Map(rows.map((r) => [r.mailboxId!, r]))
}

/** A mailbox that has never sent has zeroes, not a missing row. */
export const NO_STATS: MailboxStats = {
  sentToday: 0,
  catchAllToday: 0,
  sentEver: 0,
  bouncedEver: 0,
}

export async function mailboxStats(mailboxId: string, now = new Date()): Promise<MailboxStats> {
  const [row] = await db
    .select({
      sentToday: raw<number>`count(*) filter (
        where ${messages.sentAt}::date = ${localDay(now)}::date and ${messages.status} = 'sent'
      )`.mapWith(Number),
      catchAllToday: raw<number>`count(*) filter (
        where ${messages.sentAt}::date = ${localDay(now)}::date
          and ${messages.status} = 'sent'
          and ${contacts.emailStatus} = 'catch_all'
      )`.mapWith(Number),
      sentEver: raw<number>`count(*) filter (where ${messages.status} = 'sent')`.mapWith(Number),
      bouncedEver: raw<number>`count(*) filter (where ${messages.status} = 'bounced')`.mapWith(
        Number,
      ),
    })
    .from(messages)
    .innerJoin(contacts, eq(contacts.id, messages.contactId))
    .where(eq(messages.mailboxId, mailboxId))
  return row
}

/**
 * One pass of the sender. Call it on a timer; it decides what is allowed to go
 * out right now and sends at most that. Every path through here checks
 * suppression before delivery, and lib/gmail.ts checks again at the wire.
 */
export async function sendTick(now = new Date()): Promise<TickResult> {
  const result: TickResult = { sent: 0, halted: [], dryRun: !isConfigured(), detail: [] }
  // Each mailbox arrives with its domain, because the domain decides both the
  // credential to send with and how much of its cap has been earned so far.
  const boxes = await db
    .select({ mailbox: mailboxes, domain: domains })
    .from(mailboxes)
    .leftJoin(domains, eq(domains.id, mailboxes.domainId))
    .where(eq(mailboxes.active, true))
  if (boxes.length === 0) return result

  // Read once per tick, not per mailbox: the rules must not change halfway
  // through a pass or two mailboxes would be judged by different lines.
  const rules = await tuning()
  const suppressed = await suppressionIndex()
  // One query for every mailbox's counters, rather than one per mailbox.
  const stats = await allMailboxStats(now)

  for (const { mailbox, domain } of boxes) {
    // A domain paused by hand stops every mailbox on it at once — which is the
    // point of grouping them: one bad domain does not take the others down.
    if (domain && !domain.active) continue

    const counts = stats.get(mailbox.id) ?? NO_STATS

    if (shouldHalt(counts.sentEver, counts.bouncedEver, rules)) {
      // Halt only the campaigns that actually sent through this mailbox.
      await db
        .update(campaigns)
        .set({ status: 'ready' })
        .where(
          and(
            eq(campaigns.status, 'sending'),
            inArray(
              campaigns.id,
              db
                .select({ id: messages.campaignId })
                .from(messages)
                .where(eq(messages.mailboxId, mailbox.id)),
            ),
          ),
        )
      result.halted.push(mailbox.email)
      result.detail.push(
        `${mailbox.email}: halted, ${counts.bouncedEver} bounces in ${counts.sentEver + counts.bouncedEver}`,
      )
      continue
    }

    // Warm-up can only ever lower the cap, so a young domain sends a handful a
    // day and an established one sends what it was configured for.
    const cap = warmupCap(mailbox.dailyCap, daysSince(domain?.warmingSince ?? null, now))
    const allowance = Math.min(
      allowanceNow(cap, counts.sentToday, minuteOfDay(now), rules),
      PER_TICK,
    )
    if (allowance <= 0) continue

    const queue = await db
      .select({ message: messages, contact: contacts })
      .from(messages)
      .innerJoin(contacts, eq(contacts.id, messages.contactId))
      .innerJoin(campaigns, eq(campaigns.id, messages.campaignId))
      .where(
        and(
          eq(messages.status, 'approved'),
          eq(campaigns.status, 'sending'),
          // This sender is the email channel. A second channel gets its own
          // adapter and its own filter rather than sharing this queue.
          eq(campaigns.channel, 'email'),
          isNull(contacts.erasedAt),
          // Nothing before its backoff has elapsed.
          or(isNull(messages.nextAttemptAt), lte(messages.nextAttemptAt, now)),
        ),
      )
      // Fewest attempts first, so fresh work goes before anything that has
      // already failed. This used to order by `error`, and Postgres sorts
      // NULLs last on ASC — which put the failures at the *front* and let one
      // undeliverable message block a mailbox indefinitely.
      .orderBy(messages.attempts, messages.id)
      .limit(50)

    let sentHere = 0
    for (const { message, contact } of queue) {
      if (sentHere >= allowance) break
      if (!contact.email || !maySend(contact.emailStatus, mailbox)) continue
      if (contact.emailStatus === 'catch_all' && counts.catchAllToday >= rules.catchAllCap) continue

      if (suppressed(contact.email)) {
        await db
          .update(messages)
          .set({ status: 'flagged', error: 'suppressed before sending' })
          .where(eq(messages.id, message.id))
        result.detail.push(`${contact.email}: suppressed, not sent`)
        continue
      }

      try {
        const delivery = await deliver(
          mailbox.email,
          contact.email,
          message.subject,
          message.body,
          domain?.credentialKey,
          rules.practice,
        )
        await db
          .update(messages)
          .set({
            status: 'sent',
            mailboxId: mailbox.id,
            messageIdHeader: delivery.messageIdHeader,
            sentAt: now,
            error: null,
          })
          .where(eq(messages.id, message.id))
        await db.insert(events).values({
          contactId: contact.id,
          messageId: message.id,
          type: 'sent',
          payload: { mailbox: mailbox.email, dryRun: delivery.dryRun },
        })
        result.sent++
        sentHere++
        result.detail.push(
          `${mailbox.email} -> ${contact.email}${delivery.dryRun ? ' (dry run)' : ''}`,
        )
      } catch (cause) {
        const error = cause instanceof Error ? cause.message : String(cause)
        const next = afterFailure(message.attempts ?? 0, now)
        await db
          .update(messages)
          .set({
            error,
            attempts: next.attempts,
            nextAttemptAt: next.nextAttemptAt,
            // Out of tries: hand it to a person rather than retry forever.
            ...(next.giveUp ? { status: 'flagged' as const } : {}),
          })
          .where(eq(messages.id, message.id))
        result.detail.push(
          `${contact.email}: ${error}${next.giveUp ? ' — given up after 3 tries' : ` (retry ${next.attempts}/3)`}`,
        )
      }
      break
    }
  }

  return result
}
