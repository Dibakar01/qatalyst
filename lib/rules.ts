// The sending rules, as pure functions with no database behind them, so they
// can be read and tested on their own. lib/send.ts is the only caller.
import type { Contact, Mailbox } from '../db/schema.ts'

/** Business hours, local time, in minutes past midnight. */
export const WINDOW = { start: 9 * 60, end: 17 * 60 }

/** Rule 2: catch-all addresses are capped well below the normal daily cap. */
export const CATCH_ALL_CAP = 10

const BOUNCE_THRESHOLD = 0.03
// ponytail: a 3% rate is meaningless on three sends. Twenty is the smallest
// sample where a single bounce doesn't trip the halt; raise it as volume grows.
const BOUNCE_MINIMUM = 20

/**
 * Rule 3. How many sends this mailbox is still owed at this moment — the daily
 * cap released evenly across the sending window rather than all at once.
 * Outside the window it is zero, so a worker that was down all morning cannot
 * catch up in one burst at five o'clock.
 */
export function allowanceNow(cap: number, sentToday: number, minuteOfDay: number) {
  if (minuteOfDay < WINDOW.start || minuteOfDay >= WINDOW.end) return 0
  const span = WINDOW.end - WINDOW.start
  const unlocked = Math.floor((cap * (minuteOfDay - WINDOW.start)) / span)
  return Math.max(0, Math.min(unlocked, cap) - sentToday)
}

/**
 * Rule 2. `verified` sends from any active mailbox; `catch_all` only from one
 * flagged for it; `unverified` and `invalid` never send at all.
 */
export function maySend(
  status: Contact['emailStatus'],
  mailbox: Pick<Mailbox, 'sendsCatchAll' | 'active'>,
) {
  if (!mailbox.active) return false
  if (status === 'verified') return true
  if (status === 'catch_all') return mailbox.sendsCatchAll
  return false
}

/**
 * How many drafts one `write` may ask for. Every draft is a model call, so the
 * number a person typed is never trusted straight through — anything that is
 * not a positive whole number falls back to the default, and 100 is the ceiling.
 */
export function batchSize(asked: string, fallback = 25) {
  const n = Number(asked)
  return Number.isInteger(n) && n > 0 ? Math.min(n, 100) : fallback
}

/**
 * The bar code struck on a letter's face, so one letter can be told from
 * another across the stack without reading anything.
 *
 * Any stable spread of an id would do; this is FNV-1a because it is eight lines
 * and has no collisions worth caring about at the number of campaigns a person
 * will ever have open. Returned as a positive integer under 2^24 so it survives
 * the trip to the shader as a float without losing a bit.
 */
export function frankingCode(id: string) {
  let hash = 0x811c9dc5
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 8) & 0xffffff
}

export type Tally = { drafts: number; flagged: number; approved: number; sent: number }

export type Next = {
  /** What the mark on the letter says. */
  label: string
  action: 'read' | 'hold' | 'post' | 'draft' | 'none'
  /** How many it is about. Zero means the mark shows no number. */
  count: number
}

/**
 * The one thing this letter needs next, which is what its mark says and does.
 *
 * The order is the whole design. A marked draft comes before everything because
 * it is the only state the machine cannot leave on its own — a person has to
 * look. A run already posting needs nothing except a way to stop it. After that
 * it is simply the earliest stage with anything in it.
 */
export function nextAction(
  tally: Tally,
  audience: number,
  status: string,
  batch = 25,
): Next {
  if (tally.flagged > 0) return { label: 'read the marked', action: 'read', count: tally.flagged }
  if (status === 'sending') return { label: 'hold the post', action: 'hold', count: tally.approved }
  if (tally.drafts > 0) return { label: 'read', action: 'read', count: tally.drafts }
  if (tally.approved > 0) return { label: 'put it in the post', action: 'post', count: tally.approved }
  if (audience > 0) return { label: 'draft', action: 'draft', count: Math.min(audience, batch) }
  return { label: tally.sent > 0 ? 'all posted' : 'nobody to write to', action: 'none', count: 0 }
}

/** Rule 2: a mailbox bouncing above 3% halts its campaigns automatically. */
export function shouldHalt(sent: number, bounced: number) {
  const total = sent + bounced
  return total >= BOUNCE_MINIMUM && bounced / total > BOUNCE_THRESHOLD
}
