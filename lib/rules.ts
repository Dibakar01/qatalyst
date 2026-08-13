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

/** Rule 2: a mailbox bouncing above 3% halts its campaigns automatically. */
export function shouldHalt(sent: number, bounced: number) {
  const total = sent + bounced
  return total >= BOUNCE_MINIMUM && bounced / total > BOUNCE_THRESHOLD
}
