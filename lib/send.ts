import { and, eq, inArray, isNotNull, isNull, lte, or, sql as raw } from 'drizzle-orm'
import { db } from '../db/index.ts'
import {
  campaigns,
  contacts,
  domains,
  events,
  mailboxes,
  messages,
  warmups,
  type Domain,
  type Mailbox,
} from '../db/schema.ts'
import { deliver, isConfigured } from './gmail.ts'
import {
  afterFailure,
  allowanceNow,
  daysSince,
  domainAllowance,
  maySend,
  shouldHalt,
  warmupCap,
} from './rules.ts'
import { tuning } from './settings.ts'
import { note, pairs, stillWarming } from './warmup.ts'
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

/**
 * What each domain has already sent today, across all of its mailboxes.
 *
 * The counters above are per mailbox, and a domain's reputation is not — so
 * this is the number the domain ceiling is checked against.
 */
export async function domainSentToday(now = new Date()): Promise<Map<string, number>> {
  const rows = await db
    .select({
      domainId: mailboxes.domainId,
      sent: raw<number>`count(*) filter (
        where ${messages.sentAt}::date = ${localDay(now)}::date and ${messages.status} = 'sent'
      )`.mapWith(Number),
    })
    .from(messages)
    .innerJoin(mailboxes, eq(mailboxes.id, messages.mailboxId))
    .where(isNotNull(mailboxes.domainId))
    .groupBy(mailboxes.domainId)

  return new Map(rows.map((r) => [r.domainId!, r.sent]))
}

/**
 * A mailbox that has never sent has zeroes, not a missing row.
 *
 * A function rather than a shared constant, deliberately. Callers count sends
 * against these numbers within a tick, and a single shared object would carry
 * one mailbox's tally into the next — and, being module-level, into every
 * later tick as well. Each caller gets its own.
 */
export const noStats = (): MailboxStats => ({
  sentToday: 0,
  catchAllToday: 0,
  sentEver: 0,
  bouncedEver: 0,
})

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
  const perDomain = await domainSentToday(now)

  // And one queue for the whole tick.
  //
  // This select used to sit inside the mailbox loop, but nothing in it depends
  // on the mailbox — the candidates are the same whichever box carries them.
  // At two mailboxes that was invisible; at twenty-five it is twenty-five round
  // trips a minute, about twelve thousand a day, nearly all returning nothing.
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
    // already failed. This used to order by `error`, and Postgres sorts NULLs
    // last on ASC — which put the failures at the *front* and let one
    // undeliverable message block a mailbox indefinitely.
    .orderBy(messages.attempts, messages.id)
    .limit(200)

  // Claimed as they are handed out, so two mailboxes in the same tick never
  // take the same message.
  const taken = new Set<string>()

  for (const { mailbox, domain } of boxes) {
    // A domain paused by hand stops every mailbox on it at once — which is the
    // point of grouping them: one bad domain does not take the others down.
    if (domain && !domain.active) continue

    const counts = stats.get(mailbox.id) ?? noStats()

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
    // The tighter of the two ceilings wins. A mailbox can have personal
    // allowance left while its domain is spent for the day — and in that case
    // nothing goes out, because the reputation at risk is the domain's.
    const domainLeft = domain
      ? domainAllowance(domain.dailyCap, perDomain.get(domain.id) ?? 0)
      : Number.POSITIVE_INFINITY
    if (domainLeft <= 0) {
      result.detail.push(`${domain?.name}: at its daily ceiling, holding`)
      continue
    }

    const allowance = Math.min(
      allowanceNow(cap, counts.sentToday, minuteOfDay(now), rules),
      domainLeft,
      PER_TICK,
    )
    if (allowance <= 0) continue

    let sentHere = 0
    for (const { message, contact } of queue) {
      if (taken.has(message.id)) continue
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
        taken.add(message.id)
        // Within the tick too, or several mailboxes on one domain would each
        // read the same stale total and together overshoot the ceiling.
        if (domain) perDomain.set(domain.id, (perDomain.get(domain.id) ?? 0) + 1)
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

  // Whatever allowance the real post did not use, spent on earning the new
  // domains their reputation. After the loop deliberately: campaign mail always
  // takes precedence, and warm-up only ever fills what is left.
  await warmTick(boxes, stats, perDomain, rules, now, result)

  return result
}

/**
 * Our own mailboxes writing to each other while a domain is young.
 *
 * `warmupCap` decides how *little* a new domain may send. It cannot make
 * anyone want our mail, and a domain whose entire history is cold outreach to
 * strangers has nothing good on its record. This is the other half.
 *
 * It spends the same allowance rather than sitting beside it — published
 * guidance counts warm-up inside the 30–50 daily ceiling, so traffic that did
 * not consume allowance would quietly push a mailbox past its safe limit,
 * which is the opposite of the point.
 */
async function warmTick(
  boxes: { mailbox: Mailbox; domain: Domain | null }[],
  stats: Map<string, MailboxStats>,
  perDomain: Map<string, number>,
  rules: Awaited<ReturnType<typeof tuning>>,
  now: Date,
  result: TickResult,
) {
  const warming = boxes.filter(
    ({ mailbox, domain }) =>
      mailbox.active &&
      domain?.active &&
      stillWarming(daysSince(domain.warmingSince ?? null, now)),
  )
  if (warming.length === 0) return

  // Everyone active is a possible correspondent, not only those warming — a
  // young domain writing to an established one is the better signal.
  const everyone = boxes
    .filter(({ mailbox }) => mailbox.active)
    .map(({ mailbox }) => ({ email: mailbox.email, domainId: mailbox.domainId }))

  // Rotates with the hour, so the same two do not correspond forever.
  const round = Math.floor(now.getTime() / 3_600_000)
  const plan = new Map(pairs(everyone, round).map((p) => [p.from, p.to]))

  for (const { mailbox, domain } of warming) {
    const to = plan.get(mailbox.email)
    if (!to) continue

    const counts = stats.get(mailbox.id) ?? noStats()
    const cap = warmupCap(mailbox.dailyCap, daysSince(domain?.warmingSince ?? null, now))
    const mine = allowanceNow(cap, counts.sentToday, minuteOfDay(now), rules)
    const theirs = domain
      ? domainAllowance(domain.dailyCap, perDomain.get(domain.id) ?? 0)
      : Number.POSITIVE_INFINITY
    if (Math.min(mine, theirs) <= 0) continue

    const { subject, body } = note(mailbox.email, to, round)
    try {
      const delivery = await deliver(
        mailbox.email,
        to,
        subject,
        body,
        domain?.credentialKey,
        rules.practice,
      )
      await db.insert(warmups).values({
        fromMailbox: mailbox.email,
        toMailbox: to,
        messageIdHeader: delivery.messageIdHeader,
      })
      // Counted against the same allowance the real post draws on.
      counts.sentToday++
      if (domain) perDomain.set(domain.id, (perDomain.get(domain.id) ?? 0) + 1)
      result.detail.push(`${mailbox.email} -> ${to} (warming)`)
    } catch (cause) {
      // A warm-up failure must never stop the real post.
      result.detail.push(`${mailbox.email}: warm-up failed, ${cause instanceof Error ? cause.message : cause}`)
    }
  }
}
