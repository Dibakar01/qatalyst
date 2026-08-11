import { and, eq, inArray, isNull, sql as raw } from 'drizzle-orm'
import { db } from '../db/index.ts'
import { campaigns, contacts, events, mailboxes, messages } from '../db/schema.ts'
import { deliver, isConfigured } from './gmail.ts'
import { allowanceNow, CATCH_ALL_CAP, maySend, shouldHalt } from './rules.ts'
import { suppressionIndex } from './suppression.ts'

/** Rule 3: at most one send per mailbox per tick, so a backlog can never burst. */
const PER_TICK = 1

const minuteOfDay = (now: Date) => now.getHours() * 60 + now.getMinutes()

// The daily cap is a local-calendar-day cap, so compare against a local date
// string rather than a UTC instant. Assumes app and database share a timezone.
const localDay = (now: Date) =>
  `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`

export type TickResult = { sent: number; halted: string[]; dryRun: boolean; detail: string[] }

/**
 * One pass of the sender. Call it on a timer; it decides what is allowed to go
 * out right now and sends at most that. Every path through here checks
 * suppression before delivery, and lib/gmail.ts checks again at the wire.
 */
export async function sendTick(now = new Date()): Promise<TickResult> {
  const result: TickResult = { sent: 0, halted: [], dryRun: !isConfigured(), detail: [] }
  const boxes = await db.select().from(mailboxes).where(eq(mailboxes.active, true))
  if (boxes.length === 0) return result

  const suppressed = await suppressionIndex()

  for (const mailbox of boxes) {
    const [counts] = await db
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
      .where(eq(messages.mailboxId, mailbox.id))

    if (shouldHalt(counts.sentEver, counts.bouncedEver)) {
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

    const allowance = Math.min(allowanceNow(mailbox.dailyCap, counts.sentToday, minuteOfDay(now)), PER_TICK)
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
          isNull(contacts.erasedAt),
        ),
      )
      .orderBy(messages.error, messages.id)
      .limit(50)

    let sentHere = 0
    for (const { message, contact } of queue) {
      if (sentHere >= allowance) break
      if (!contact.email || !maySend(contact.emailStatus, mailbox)) continue
      if (contact.emailStatus === 'catch_all' && counts.catchAllToday >= CATCH_ALL_CAP) continue

      if (suppressed(contact.email)) {
        await db
          .update(messages)
          .set({ status: 'flagged', error: 'suppressed before sending' })
          .where(eq(messages.id, message.id))
        result.detail.push(`${contact.email}: suppressed, not sent`)
        continue
      }

      try {
        const delivery = await deliver(mailbox.email, contact.email, message.subject, message.body)
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
        await db.update(messages).set({ error }).where(eq(messages.id, message.id))
        result.detail.push(`${contact.email}: ${error}`)
      }
      break
    }
  }

  return result
}
