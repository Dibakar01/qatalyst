import { eq } from 'drizzle-orm'
import { db } from '../db/index.ts'
import { settings } from '../db/schema.ts'
import { clampTuning, type Tuning } from './rules.ts'

/**
 * The one row of configuration, id 1.
 *
 * Everything here was a constant in lib/rules.ts. Moving it into the database
 * is what makes warming a domain possible without editing code — but the rules
 * themselves stay pure functions that take these as arguments, so they remain
 * testable with no database anywhere near them.
 */

export const DEFAULTS: Required<Tuning> = {
  windowStart: 9 * 60,
  windowEnd: 17 * 60,
  bounceThreshold: 300,
  bounceMinimum: 20,
  catchAllCap: 10,
  draftBatch: 25,
  // Live by default: a fresh install with no key dry-runs anyway.
  practice: false,
}

/**
 * Read the tuning, creating the row on first use.
 *
 * A fresh install has no settings row, and every caller wants numbers rather
 * than a null check — so the absence of a row means the defaults, which are
 * also the safe values.
 */
export async function tuning(): Promise<Required<Tuning>> {
  const [row] = await db.select().from(settings).where(eq(settings.id, 1)).limit(1)
  if (!row) return DEFAULTS
  return clampTuning(row as unknown as Record<string, unknown>, DEFAULTS)
}

/** Write it back, clamped. The clamp is in lib/rules.ts, beside the rules. */
export async function saveTuning(input: Record<string, unknown>) {
  const next = clampTuning(input, await tuning())
  await db
    .insert(settings)
    .values({ id: 1, ...next, updatedAt: new Date() })
    .onConflictDoUpdate({ target: settings.id, set: { ...next, updatedAt: new Date() } })
  return next
}

/** For the UI: minutes past midnight as 09:00, and back. */
export const asClock = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`

export function fromClock(value: string, fallback: number) {
  const [h, m] = value.split(':').map(Number)
  if (!Number.isInteger(h) || !Number.isInteger(m)) return fallback
  return h * 60 + m
}
