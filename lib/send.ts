import { and, eq, inArray, isNotNull, isNull, lte, or, sql as raw } from 'drizzle-orm'
import { db, sql } from '../db/index.ts'
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
import { deliver, isConfigured, messageIdFor, Refused } from './gmail.ts'
import {
  afterFailure,
  allowanceNow,
  daysSince,
  domainAllowance,
  isSendingDay,
  maySend,
  shouldHalt,
  warmupCap,
} from './rules.ts'
import { tuning } from './settings.ts'
import { note, pairs, stillWarming } from './warmup.ts'
import { suppressionIndex } from './suppression.ts'

/** Rule 3: at most one send per mailbox per tick, so a backlog can never burst. */
const PER_TICK = 1

/**
 * The operator's timezone. Required, and deliberately without a default: a
 * default is precisely how the sending window came to follow whichever clock the
 * container happened to be started with. Read at the call rather than at import,
 * so a module that only needs the pure helpers can be loaded without it.
 */
export function sendTz(): string {
  const tz = process.env.SEND_TZ
  if (!tz) {
    throw new Error('SEND_TZ is not set — the sending window has no timezone to follow')
  }
  return tz
}

/**
 * Wall-clock fields in a named zone.
 *
 * `Intl` is the only thing in the platform that knows a zone's offset *on a
 * given date*, which is what makes the two helpers below correct across a DST
 * change rather than an hour out for half the year. An unknown zone throws here,
 * loudly, rather than quietly falling back to the server's own.
 */
function zoned(now: Date, tz: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(now)
  return Object.fromEntries(parts.map((p) => [p.type, p.value])) as Record<string, string>
}

/**
 * Minutes since midnight in the operator's zone — the number the window is
 * checked against.
 *
 * This read `Date.getHours()`, i.e. the Node process's timezone. The standard
 * production shape is a container in UTC and an operator in IST, where a
 * configured 09:00–17:00 window fired at 14:30–22:30 local: into the recipients'
 * evening, which is the one thing the window exists to prevent.
 */
export function minuteOfDay(now: Date, tz: string): number {
  const at = zoned(now, tz)
  return Number(at.hour) * 60 + Number(at.minute)
}

/**
 * The daily cap is a local-calendar-day cap, so the counters compare against a
 * local date string rather than a UTC instant.
 *
 * The old comment here said "assumes app and database share a timezone" and
 * nothing enforced it; `assertDbTimezone()` now does, at boot. If they disagree
 * the counters reset at the wrong instant and a cap is briefly double-spendable
 * across the boundary.
 */
export function localDay(now: Date, tz: string): string {
  const at = zoned(now, tz)
  return `${at.year}-${at.month}-${at.day}`
}

/**
 * Refuse to start if the database is not keeping the operator's calendar.
 *
 * The counters filter on `sent_at::date`, and that cast uses the *session's*
 * timezone — so a database in UTC rolls its day over at 05:30 IST while the app
 * believes the day turned at midnight. Nothing about that is visible; it shows up
 * as a cap that was briefly spendable twice. Cheaper to not boot.
 */
export async function assertDbTimezone(): Promise<void> {
  const tz = sendTz()
  const [row] = await sql<{ TimeZone: string }[]>`show timezone`
  if (row?.TimeZone !== tz) {
    throw new Error(
      `database timezone is ${row?.TimeZone ?? 'unknown'} but SEND_TZ is ${tz} — ` +
        'the daily counters would roll over at a different instant from the window. ' +
        'Set the database session timezone to match, or correct SEND_TZ.',
    )
  }
}

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
        where ${messages.sentAt}::date = ${localDay(now, sendTz())}::date and ${messages.status} = 'sent'
      )`.mapWith(Number),
      catchAllToday: raw<number>`count(*) filter (
        where ${messages.sentAt}::date = ${localDay(now, sendTz())}::date
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

  const stats = new Map<string, MailboxStats>(
    rows.map((r) => [
      r.mailboxId!,
      {
        sentToday: r.sentToday,
        catchAllToday: r.catchAllToday,
        sentEver: r.sentEver,
        bouncedEver: r.bouncedEver,
      },
    ]),
  )

  // Warm-up counts. It is real mail from a real mailbox, and it was invisible
  // here — warm-up writes to `warmups` while every counter read `messages`, so
  // the tally lived only in the in-memory increment and died with this Map on
  // the next tick. A mailbox whose warm-up cap is 5 could therefore send one
  // per tick, all day: on the order of 480, uncounted, from the very domain
  // the warm-up exists to protect.
  const warm = await db
    .select({
      mailbox: warmups.fromMailbox,
      sent: raw<number>`count(*)`.mapWith(Number),
    })
    .from(warmups)
    .where(raw`${warmups.sentAt}::date = ${localDay(now, sendTz())}::date`)
    .groupBy(warmups.fromMailbox)

  if (warm.length > 0) {
    // `warmups` records the address; the counters are keyed by mailbox id.
    const byEmail = new Map(
      (await db.select({ id: mailboxes.id, email: mailboxes.email }).from(mailboxes)).map((m) => [
        m.email,
        m.id,
      ]),
    )
    for (const row of warm) {
      const id = byEmail.get(row.mailbox)
      if (!id) continue
      const current = stats.get(id) ?? noStats()
      stats.set(id, { ...current, sentToday: current.sentToday + row.sent })
    }
  }

  return stats
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
        where ${messages.sentAt}::date = ${localDay(now, sendTz())}::date and ${messages.status} = 'sent'
      )`.mapWith(Number),
    })
    .from(messages)
    .innerJoin(mailboxes, eq(mailboxes.id, messages.mailboxId))
    .where(isNotNull(mailboxes.domainId))
    .groupBy(mailboxes.domainId)

  const total = new Map(rows.map((r) => [r.domainId!, r.sent]))

  // And warm-up against the domain ceiling too. This is the number that
  // protects the asset: a domain's reputation does not distinguish between a
  // campaign send and one mailbox writing to another.
  const warm = await db
    .select({
      domainId: mailboxes.domainId,
      sent: raw<number>`count(*)`.mapWith(Number),
    })
    .from(warmups)
    .innerJoin(mailboxes, eq(mailboxes.email, warmups.fromMailbox))
    .where(
      and(isNotNull(mailboxes.domainId), raw`${warmups.sentAt}::date = ${localDay(now, sendTz())}::date`),
    )
    .groupBy(mailboxes.domainId)

  for (const row of warm) {
    total.set(row.domainId!, (total.get(row.domainId!) ?? 0) + row.sent)
  }

  return total
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
        where ${messages.sentAt}::date = ${localDay(now, sendTz())}::date and ${messages.status} = 'sent'
      )`.mapWith(Number),
      catchAllToday: raw<number>`count(*) filter (
        where ${messages.sentAt}::date = ${localDay(now, sendTz())}::date
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
 * Take a message out of the queue *before* anything touches the wire.
 *
 * One statement, and the `status = 'approved'` predicate is the entire mechanism:
 * Postgres serialises the two updates, so when two ticks — or two processes —
 * reach for the same row, exactly one gets a row back and the other gets nothing.
 * Nothing claimed a row before this existed, so a crash between the Gmail call
 * and the write left the row `approved` and the next tick delivered the same cold
 * email again, unbounded across restarts.
 *
 * `mailboxId` is optional and stamped here rather than only after delivery, so a
 * row stranded in `sending` still says which mailbox was holding it when the
 * process died — which is the first question anyone asks about a stranded row.
 */
export async function claimForSend(
  messageId: string,
  mailboxId?: string,
): Promise<{ claimed: boolean }> {
  const rows = await db
    .update(messages)
    .set({
      status: 'sending',
      // Counted at the claim rather than after a failure. A crash has no catch
      // block left to run, and an attempt that vanished is an attempt not
      // counted towards giving up.
      attempts: raw`${messages.attempts} + 1`,
      ...(mailboxId ? { mailboxId } : {}),
    })
    .where(and(eq(messages.id, messageId), eq(messages.status, 'approved')))
    .returning({ id: messages.id })
  return { claimed: rows.length === 1 }
}

/**
 * The key for the sender's advisory lock. Arbitrary but fixed; any other
 * advisory lock this codebase takes must use a different number.
 */
const SENDER_LOCK = 8726411

/**
 * One pass of the sender. Call it on a timer; it decides what is allowed to go
 * out right now and sends at most that. Every path through here checks
 * suppression before delivery, and lib/gmail.ts checks again at the wire.
 *
 * Only one sender may work the queue at a time. `pg_try_advisory_lock` returns
 * false rather than waiting, so a second process declines the tick instead of
 * queueing up behind the first and then acting on a queue the first has already
 * changed. `claimForSend` alone would make that safe, but two senders competing
 * for every row is a race won by luck; this makes the second one leave. The lock
 * lives on the connection, so it is released even when the process is killed —
 * which is why it is taken on a reserved connection rather than a pooled one.
 */
export async function sendTick(now = new Date()): Promise<TickResult> {
  const held = await sql.reserve()
  const [lock] = await held<{ locked: boolean }[]>`select pg_try_advisory_lock(${SENDER_LOCK}) as locked`
  if (!lock.locked) {
    held.release()
    return {
      sent: 0,
      halted: [],
      dryRun: !isConfigured(),
      detail: ['another sender holds the queue; skipping this tick'],
    }
  }
  try {
    return await runTick(now)
  } finally {
    await held`select pg_advisory_unlock(${SENDER_LOCK})`
    held.release()
  }
}

async function runTick(now: Date): Promise<TickResult> {
  const result: TickResult = { sent: 0, halted: [], dryRun: !isConfigured(), detail: [] }
  // Once per tick: every window decision in this pass must be made in the same
  // zone, and read once so it cannot change halfway through.
  const tz = sendTz()

  // Nothing goes out at the weekend, warm-up included. A mailbox sending cold
  // outreach on a Sunday at its weekday rate is a pattern no person produces,
  // and M3AAWG puts consistent human-shaped volume at the centre of how
  // reputation is judged.
  if (!isSendingDay(now, tz)) return result
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
      allowanceNow(cap, counts.sentToday, minuteOfDay(now, tz), rules),
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

      // Claim it before the wire. If this returns false another tick or another
      // process already has the row, and the only safe thing to do is leave it
      // alone — the alternative is two copies of the same cold email.
      const { claimed } = await claimForSend(message.id, mailbox.id)
      if (!claimed) {
        taken.add(message.id)
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
        // Recorded before the Message-ID is read back, not after. Gmail has
        // accepted the message by this point, so anything that goes wrong from
        // here on is a bookkeeping problem and must never look like a failed
        // send — that is what sent this mail up to three times.
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
        // Rule 6, best effort. A missing Message-ID costs one unmatched reply;
        // treating its absence as a failure cost the prospect a second email.
        if (delivery.gmailId) {
          const header = await messageIdFor(mailbox.email, delivery.gmailId, domain?.credentialKey)
          await db
            .update(messages)
            .set({ messageIdHeader: header, error: header ? null : 'sent, Message-ID not read back' })
            .where(eq(messages.id, message.id))
        }
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
        // `Refused` means Gmail is known not to have taken it, so the claim can
        // be handed back and the message tried again. Anything else leaves the
        // outcome unknown — a socket that died mid-request may still have been
        // accepted — and the row stays in `sending`: never re-selected, visible
        // to an operator, and never delivered twice.
        if (!(cause instanceof Refused)) {
          await db.update(messages).set({ error }).where(eq(messages.id, message.id))
          result.detail.push(`${contact.email}: ${error} — outcome unknown, left for review`)
          break
        }
        // `attempts` was already incremented by the claim, and afterFailure
        // computes the same number from the row this tick read, so this writes
        // the count it already holds rather than counting the try twice.
        const next = afterFailure(message.attempts ?? 0, now)
        await db
          .update(messages)
          .set({
            error,
            attempts: next.attempts,
            nextAttemptAt: next.nextAttemptAt,
            // Out of tries: hand it to a person rather than retry forever.
            status: next.giveUp ? 'flagged' : 'approved',
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
  await warmTick(boxes, stats, perDomain, rules, now, tz, result)

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
  tz: string,
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
    const mine = allowanceNow(cap, counts.sentToday, minuteOfDay(now, tz), rules)
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
        // Read back after the wire like the real post, and best effort for the
        // same reason: a warm-up that landed must never be recorded as failed.
        messageIdHeader: delivery.gmailId
          ? await messageIdFor(mailbox.email, delivery.gmailId, domain?.credentialKey)
          : delivery.messageIdHeader,
        // Stamped with the tick's clock, not the database's. The counters
        // filter on this date against the same `now`, so letting the column
        // default would let writer and reader disagree about which day a send
        // belongs to — and the send path already passes `sentAt: now` for
        // exactly this reason.
        sentAt: now,
      })
      // Kept current within the tick as well. The row written above is what
      // the next tick's `allMailboxStats` will count; this is only so several
      // mailboxes in *this* pass do not each read the same stale total.
      counts.sentToday++
      if (domain) perDomain.set(domain.id, (perDomain.get(domain.id) ?? 0) + 1)
      result.detail.push(`${mailbox.email} -> ${to} (warming)`)
    } catch (cause) {
      // A warm-up failure must never stop the real post.
      result.detail.push(`${mailbox.email}: warm-up failed, ${cause instanceof Error ? cause.message : cause}`)
    }
  }
}
