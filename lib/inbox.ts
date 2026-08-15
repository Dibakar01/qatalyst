import { and, eq, inArray, isNotNull, sql as raw } from 'drizzle-orm'
import { db } from '../db/index.ts'
import { contacts, events, mailboxes, messages } from '../db/schema.ts'
import { tokenFor } from './gmail.ts'
import { classify, type Headers } from './replies.ts'
import { suppress } from './suppression.ts'

/**
 * The read pass: what came back.
 *
 * This is the half that was missing. Outbound wrote `sent` and stopped, so
 * `bounced` and `replied` were never written by anything — which meant the
 * bounce halt could not fire and the reply rate was always zero.
 *
 * Matching is on the Message-ID Gmail assigned us, which is captured on every
 * send and has had an index waiting for it since the day it was added.
 */

const LIST = 'https://gmail.googleapis.com/gmail/v1/users/me/messages'

/** Only look at what arrived since we last looked, with a day of overlap. */
const LOOK_BACK_DAYS = 2

type Result = {
  read: number
  bounced: number
  replied: number
  auto: number
  detail: string[]
}

async function fetchJson(url: string, token: string) {
  const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } })
  if (!response.ok) {
    const body = await response.text()
    // The likeliest failure by far, and worth naming precisely: the scope has
    // not been granted yet, which is a Workspace admin action, not a bug.
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        `not authorised to read this mailbox — add gmail.readonly to the domain-wide delegation (${response.status})`,
      )
    }
    throw new Error(`gmail read failed: ${response.status} ${body}`)
  }
  return response.json()
}

/** Header list → a plain object, which is all the pure code wants. */
function headersOf(payload: { headers?: { name: string; value: string }[] }): Headers {
  const out: Headers = {}
  for (const h of payload.headers ?? []) out[h.name] = h.value
  return out
}

/**
 * Read one mailbox and record what it found.
 *
 * Deliberately does not mark anything as read or touch labels — the scope is
 * read-only and this must never disturb a mailbox a person also uses.
 */
export async function readMailbox(
  mailbox: { id: string; email: string },
  credentialKey: string | null | undefined,
  result: Result,
) {
  const token = await tokenFor(mailbox.email, credentialKey)
  if (!token) {
    result.detail.push(`${mailbox.email}: no credentials`)
    return
  }

  const after = Math.floor((Date.now() - LOOK_BACK_DAYS * 86_400_000) / 1000)
  const list = (await fetchJson(
    `${LIST}?q=${encodeURIComponent(`after:${after} -from:me`)}&maxResults=100`,
    token,
  )) as { messages?: { id: string }[] }

  for (const { id } of list.messages ?? []) {
    const full = (await fetchJson(
      `${LIST}/${id}?format=metadata&metadataHeaders=In-Reply-To&metadataHeaders=References&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Content-Type&metadataHeaders=Auto-Submitted&metadataHeaders=Precedence`,
      token,
    )) as { payload?: { headers?: { name: string; value: string }[] }; snippet?: string }

    result.read++
    const verdict = classify(headersOf(full.payload ?? {}), full.snippet ?? '')
    if (verdict.kind === 'ignore' || verdict.answering.length === 0) continue

    // Which of our sends this answers. The Message-ID is unique, so this is a
    // direct hit rather than a guess.
    const [ours] = await db
      .select({ id: messages.id, contactId: messages.contactId, status: messages.status })
      .from(messages)
      .where(
        and(
          inArray(messages.messageIdHeader, verdict.answering),
          isNotNull(messages.messageIdHeader),
        ),
      )
      .limit(1)
    if (!ours) continue

    // Already settled: a thread that keeps going must not count twice.
    if (ours.status === 'replied' || ours.status === 'bounced') continue

    if (verdict.kind === 'bounce') {
      await db.update(messages).set({ status: 'bounced' }).where(eq(messages.id, ours.id))
      await db.insert(events).values({
        contactId: ours.contactId,
        messageId: ours.id,
        type: 'bounce',
        payload: { hard: verdict.hard, mailbox: mailbox.email },
      })

      // A permanent failure means never write to this address again. A
      // temporary one — a full mailbox — is not the person's fault and must
      // not cost us the contact.
      if (verdict.hard && ours.contactId) {
        const [who] = await db
          .select({ email: contacts.email })
          .from(contacts)
          .where(eq(contacts.id, ours.contactId))
          .limit(1)
        if (who?.email) await suppress(who.email, 'bounced')
      }
      result.bounced++
      result.detail.push(`${mailbox.email}: bounce${verdict.hard ? ' (permanent)' : ' (temporary)'}`)
      continue
    }

    if (verdict.kind === 'auto') {
      // Recorded but not counted. An out-of-office is not engagement, and
      // letting it inflate the reply rate would corrupt the one number this
      // whole system is judged on.
      result.auto++
      continue
    }

    await db.update(messages).set({ status: 'replied' }).where(eq(messages.id, ours.id))
    await db.insert(events).values({
      contactId: ours.contactId,
      messageId: ours.id,
      type: 'reply',
      payload: { mailbox: mailbox.email },
    })
    if (ours.contactId) {
      const { advance } = await import('./segments.ts')
      await advance(ours.contactId, 'replied')
    }
    result.replied++
    result.detail.push(`${mailbox.email}: reply`)
  }
}

/** Every active mailbox, once. Called from the worker beside the send tick. */
export async function readTick(): Promise<Result> {
  const result: Result = { read: 0, bounced: 0, replied: 0, auto: 0, detail: [] }

  const boxes = await db
    .select({
      id: mailboxes.id,
      email: mailboxes.email,
      credentialKey: raw<string | null>`(select d.credential_key from domains d where d.id = ${mailboxes.domainId})`,
    })
    .from(mailboxes)
    .where(eq(mailboxes.active, true))

  for (const box of boxes) {
    try {
      await readMailbox(box, box.credentialKey, result)
    } catch (cause) {
      // One mailbox failing to read must not stop the others, and must never
      // stop sending.
      result.detail.push(`${box.email}: ${cause instanceof Error ? cause.message : cause}`)
    }
  }

  return result
}
