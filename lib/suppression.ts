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

export async function isSuppressed(email: string) {
  return (await suppressionIndex())(email)
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
