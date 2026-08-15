import { eq, or } from 'drizzle-orm'
import { createHash } from 'node:crypto'
import { db } from '../db/index.ts'
import { suppressions } from '../db/schema.ts'
import { domainOf, normalise } from './email.ts'

type Reason = (typeof suppressions.reason.enumValues)[number]

/** Suppressions store this, never the address itself. */
export const emailHash = (email: string) =>
  createHash('sha256').update(normalise(email)).digest('hex')

/**
 * THE suppression check. Every path that would put an address in a To: header
 * goes through here — import, review, send. There is no other query against
 * `suppressions` in the codebase, and there must never be a send that skips it.
 *
 * ponytail: loads the whole table (hash + domain sets). Fine to ~1e5 rows;
 * swap for a targeted WHERE if it ever gets bigger than memory.
 */
export async function suppressionIndex() {
  const rows = await db
    .select({ hash: suppressions.emailHash, domain: suppressions.domain })
    .from(suppressions)
  const hashes = new Set(rows.map((r) => r.hash).filter(Boolean))
  const domains = new Set(rows.map((r) => r.domain).filter(Boolean))
  return (email: string) => hashes.has(emailHash(email)) || domains.has(domainOf(email))
}

/**
 * One address, by index seek.
 *
 * This is the check inside `deliver()`, so it runs once per send. It used to
 * call `suppressionIndex()`, which loads the entire table — a full scan for
 * every single email. Both unique indexes make this an O(1) probe instead, and
 * unlike caching the index it cannot go stale: an address suppressed a second
 * ago is seen by the very next send.
 */
export async function isSuppressed(email: string) {
  const domain = domainOf(email)
  const [row] = await db
    .select({ id: suppressions.id })
    .from(suppressions)
    .where(
      domain
        ? or(eq(suppressions.emailHash, emailHash(email)), eq(suppressions.domain, domain))
        : eq(suppressions.emailHash, emailHash(email)),
    )
    .limit(1)
  return Boolean(row)
}

/** Idempotent: unsubscribing twice, or bouncing after unsubscribing, is one row. */
export async function suppress(email: string, reason: Reason) {
  await db
    .insert(suppressions)
    .values({ emailHash: emailHash(normalise(email)), reason })
    .onConflictDoNothing()
}

export async function suppressDomain(domain: string, reason: Reason) {
  await db
    .insert(suppressions)
    .values({ domain: domain.trim().toLowerCase(), reason })
    .onConflictDoNothing()
}
