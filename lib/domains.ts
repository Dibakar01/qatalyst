import { asc, eq } from 'drizzle-orm'
import { db } from '../db/index.ts'
import { domains, mailboxes, type Domain } from '../db/schema.ts'
import { domainOf } from './email.ts'
import { daysSince, warmupCap } from './rules.ts'

/**
 * The sending domains, and their credentials.
 *
 * Outbound spreads across several domains so the primary one survives: volume
 * splits between them, each warms on its own clock, and one burning does not
 * stop the rest. What makes that work rather than just look tidy is that the
 * warm-up ramp is automatic — a cap nobody has to edit every morning.
 *
 * Keys live in the environment, never in the database. `credentialKey` is only
 * a name: `QALAKAAR` means read `GOOGLE_SA_QALAKAAR`.
 */

export const envName = (key: string) => `GOOGLE_SA_${key.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`

/**
 * The default key name for a domain: the whole domain, not its first label.
 *
 * `qalakaar.com` and `qalakaar.co.uk` are different Workspaces with different
 * service accounts, and naming both `QALAKAAR` would silently send one
 * domain's mail with the other's credential.
 */
export const defaultKey = (name: string) => name.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()

/**
 * The credential for one domain, or the single legacy one.
 *
 * `GOOGLE_SERVICE_ACCOUNT_JSON` still works exactly as before for anyone who
 * has not split their sending yet, so this change breaks nothing that was
 * already configured.
 */
export function credentialFor(key: string | null | undefined): string | undefined {
  if (key) {
    const named = process.env[envName(key)]
    if (named) return named
  }
  return process.env.GOOGLE_SERVICE_ACCOUNT_JSON
}

export const isConnected = (key: string | null | undefined) => Boolean(credentialFor(key))

export type DomainView = Domain & {
  /** Days into the ramp, or null when established. */
  warmingDay: number | null
  /** Whether a usable service-account key is actually present. */
  connected: boolean
  /** Which env var it is looking for, so a missing one can be named. */
  expects: string
  mailboxes: number
  /** What the domain may send today across its mailboxes, after warm-up. */
  todayCap: number
}

export async function listDomains(now = new Date()): Promise<DomainView[]> {
  const rows = await db.select().from(domains).orderBy(asc(domains.name))
  const boxes = await db.select().from(mailboxes)

  return rows.map((domain) => {
    const mine = boxes.filter((box) => box.domainId === domain.id)
    const day = daysSince(domain.warmingSince, now)
    return {
      ...domain,
      warmingDay: day,
      connected: isConnected(domain.credentialKey),
      expects: envName(domain.credentialKey ?? defaultKey(domain.name)),
      mailboxes: mine.length,
      todayCap: mine
        .filter((box) => box.active)
        .reduce((total, box) => total + warmupCap(box.dailyCap, day), 0),
    }
  })
}

/**
 * Adopt a mailbox into its domain, creating the domain if it is new.
 *
 * Called when a mailbox is added, and once over the existing rows, so nobody
 * has to name a domain by hand before they can use one.
 */
export async function attach(email: string, now = new Date()) {
  const name = domainOf(email)
  if (!name) return null

  const [existing] = await db.select().from(domains).where(eq(domains.name, name)).limit(1)
  const domain =
    existing ??
    (
      await db
        .insert(domains)
        .values({
          name,
          credentialKey: defaultKey(name),
          // A domain discovered from a mailbox is assumed to be warming from
          // now — the cautious reading. Marking it established is one click.
          warmingSince: now,
        })
        .onConflictDoNothing()
        .returning()
    )[0] ??
    (await db.select().from(domains).where(eq(domains.name, name)).limit(1))[0]

  await db.update(mailboxes).set({ domainId: domain.id }).where(eq(mailboxes.email, email))
  return domain
}

/** Backfill: give every mailbox that predates domains its domain row. */
export async function attachAll(now = new Date()) {
  const orphans = await db.select().from(mailboxes)
  for (const box of orphans.filter((b) => !b.domainId)) await attach(box.email, now)
  return orphans.length
}

export const setWarming = (id: string, warmingSince: Date | null) =>
  db.update(domains).set({ warmingSince }).where(eq(domains.id, id))

export const setDomainActive = (id: string, active: boolean) =>
  db.update(domains).set({ active }).where(eq(domains.id, id))
