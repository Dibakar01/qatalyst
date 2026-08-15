// The sending rules, as pure functions with no database behind them, so they
// can be read and tested on their own. lib/send.ts is the only caller.
import type { Contact, Mailbox } from '../db/schema.ts'

/**
 * The defaults, which are also the safe values.
 *
 * These used to be the only values. They are now what a fresh install starts
 * with and what every one of these functions falls back to when called without
 * settings — which is why the whole test suite still passes unchanged.
 */
export const WINDOW = { start: 9 * 60, end: 17 * 60 }

/** Rule 2: catch-all addresses are capped well below the normal daily cap. */
export const CATCH_ALL_CAP = 10

const BOUNCE_THRESHOLD = 0.03
// ponytail: a 3% rate is meaningless on three sends. Twenty is the smallest
// sample where a single bounce doesn't trip the halt; raise it as volume grows.
const BOUNCE_MINIMUM = 20

/** What the sender needs to know. Every field optional; defaults are above. */
export type Tuning = {
  windowStart?: number
  windowEnd?: number
  /** Basis points. 300 = 3.00%. */
  bounceThreshold?: number
  bounceMinimum?: number
  catchAllCap?: number
  draftBatch?: number
  /** Run everything, deliver nothing. Not a number, so it is not clamped. */
  practice?: boolean
}

/**
 * The bounds, and why each one exists.
 *
 * Tuning the rules is the point; being able to turn them off is not. A 50%
 * bounce threshold is not a setting, it is a way to lose the domain — so the
 * clamps are part of the rules rather than validation bolted on at the edge.
 */
export const LIMITS = {
  // Nothing outside 06:00–22:00: mail landing at 3am reads as a machine.
  windowStart: [6 * 60, 21 * 60],
  windowEnd: [7 * 60, 22 * 60],
  // Below 1% a single bad list halts everything; above 8% the domain is
  // already in trouble by the time anything stops.
  bounceThreshold: [100, 800],
  // Under 10 attempts a rate is noise.
  bounceMinimum: [10, 500],
  catchAllCap: [0, 50],
  draftBatch: [1, 100],
} as const

/** Clamped and whole. Anything unparseable falls back to the safe default. */
export function clampTuning(input: Record<string, unknown>, base: Required<Tuning>): Required<Tuning> {
  const out = { ...base }
  for (const key of Object.keys(LIMITS) as (keyof typeof LIMITS)[]) {
    const given = input[key]
    // Number(null) is 0 and Number('') is 0 — both would clamp to the lowest
    // bound and look deliberate. A missing value must keep the safe default,
    // not silently become the most restrictive one.
    if (given === null || given === undefined || given === '') continue
    const raw = Number(given)
    if (!Number.isFinite(raw)) continue
    const [low, high] = LIMITS[key]
    out[key] = Math.min(Math.max(Math.round(raw), low), high)
  }
  // A window that ends before it starts would silently send nothing all day.
  if (out.windowEnd <= out.windowStart) out.windowEnd = Math.min(out.windowStart + 60, LIMITS.windowEnd[1])

  // Practice is a boolean, so it has no bounds to clamp — but the loop above
  // only walks LIMITS, and leaving it out here would silently drop it on every
  // save. Absent means unchanged, exactly like the numbers.
  if (input.practice !== undefined && input.practice !== null && input.practice !== '') {
    out.practice = input.practice === true || input.practice === 'true' || input.practice === 'on'
  }
  return out
}

/**
 * Rule 3. How many sends this mailbox is still owed at this moment — the daily
 * cap released evenly across the sending window rather than all at once.
 * Outside the window it is zero, so a worker that was down all morning cannot
 * catch up in one burst at five o'clock.
 */
export function allowanceNow(
  cap: number,
  sentToday: number,
  minuteOfDay: number,
  tuning: Tuning = {},
) {
  const start = tuning.windowStart ?? WINDOW.start
  const end = tuning.windowEnd ?? WINDOW.end
  if (minuteOfDay < start || minuteOfDay >= end) return 0
  const span = end - start
  const unlocked = Math.floor((cap * (minuteOfDay - start)) / span)
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

/* ── the domain's own ceiling ─────────────────────────────────────────────── */

/**
 * Published guidance for how much one domain may send in a day.
 *
 * Per-mailbox caps alone do not protect anything: reputation is earned and
 * lost by the domain, so five mailboxes at 50 and eight at 50 look identical
 * to a mailbox and very different to Google. 30–50 a mailbox and about 250 a
 * domain is where the guidance settles.
 */
export const DOMAIN_CAP = 250

/** Nothing outside this, whatever anyone types. */
export const DOMAIN_CAP_LIMITS = [20, 500] as const

export const clampDomainCap = (n: unknown) => {
  // Number(null) is 0 and Number('') is 0 — both would clamp to the lowest
  // bound and look deliberate. Missing means the safe default, not the most
  // restrictive value. Exactly the trap clampTuning already guards against.
  if (n === null || n === undefined || n === '') return DOMAIN_CAP
  const raw = Number(n)
  if (!Number.isFinite(raw)) return DOMAIN_CAP
  return Math.min(Math.max(Math.round(raw), DOMAIN_CAP_LIMITS[0]), DOMAIN_CAP_LIMITS[1])
}

/**
 * What this domain has left today, across every mailbox on it.
 *
 * Sits on top of the per-mailbox allowance rather than replacing it: a mailbox
 * may still have personal allowance while its domain is spent, and in that
 * case nothing goes out. The whole point is that the tighter of the two wins.
 */
export function domainAllowance(cap: number, sentToday: number) {
  return Math.max(cap - sentToday, 0)
}

/* ── when a send fails ────────────────────────────────────────────────────── */

/** Tries before a message is given up on and handed back to a person. */
export const MAX_ATTEMPTS = 3

/**
 * What to do with a delivery that just failed.
 *
 * The queue used to leave it `approved` with an error recorded, and ordered
 * errored rows first — so an undeliverable message was retried every tick
 * forever and nothing else on that mailbox ever went out. A silent, total
 * stall that looked like the sender having nothing to do.
 *
 * Backoff is minutes, not seconds: the failures worth retrying are transient
 * Gmail errors and rate limits, and hammering either is how a mailbox earns a
 * longer ban. Three tries spans about half an hour, after which a person is a
 * better judge than another retry.
 */
export function afterFailure(attempts: number, now = new Date()) {
  const tried = attempts + 1
  if (tried >= MAX_ATTEMPTS) return { attempts: tried, giveUp: true, nextAttemptAt: null }
  // 5 minutes, then 25.
  const wait = 5 * 60_000 * Math.pow(5, tried - 1)
  return {
    attempts: tried,
    giveUp: false,
    nextAttemptAt: new Date(now.getTime() + wait),
  }
}

/* ── warming a domain ─────────────────────────────────────────────────────── */

/** A new domain starts here, however big its mailbox caps are. */
export const WARMUP_START = 5
/** Compounding daily, which reaches a 35/day cap in about three weeks. */
export const WARMUP_RATE = 0.1

/**
 * What a mailbox on a young domain may actually send today.
 *
 * Spreading across domains only helps if each one is warmed, and warming by
 * hand means editing a cap every morning for three weeks — which nobody does,
 * which is how a fresh domain gets burned on day two. This makes the ramp a
 * function of the domain's age instead of a chore.
 *
 * `startedAt` null means an established domain: it has already been warmed, so
 * its configured cap stands.
 */
export function warmupCap(cap: number, daysWarming: number | null) {
  if (daysWarming === null) return cap
  const day = Math.max(Math.floor(daysWarming), 0)
  const allowed = Math.floor(WARMUP_START * (1 + WARMUP_RATE) ** day)
  return Math.max(Math.min(allowed, cap), Math.min(WARMUP_START, cap))
}

/** Whole days between then and now, for the ramp above. */
export function daysSince(started: Date | null, now = new Date()) {
  if (!started) return null
  return Math.floor((now.getTime() - started.getTime()) / 86_400_000)
}

/** Rule 2: a mailbox bouncing above 3% halts its campaigns automatically. */
export function shouldHalt(sent: number, bounced: number, tuning: Tuning = {}) {
  const threshold = (tuning.bounceThreshold ?? BOUNCE_THRESHOLD * 10_000) / 10_000
  const minimum = tuning.bounceMinimum ?? BOUNCE_MINIMUM
  const total = sent + bounced
  return total >= minimum && bounced / total > threshold
}
