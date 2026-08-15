import { asc, eq } from 'drizzle-orm'
import { db } from '../db/index.ts'
import { domains, mailboxes, type Domain } from '../db/schema.ts'
import { domainOf } from './email.ts'
import { clampDomainCap, daysSince, warmupCap } from './rules.ts'

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
  /** Where it settles once the ramp is finished. */
  fullCap: number
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
      // Held to the domain's own ceiling, because the sender holds it there.
      // Summing mailbox caps alone would promise 320 a day from eight boxes at
      // 40 while the sender stops at 250 — a readout that disagrees with the
      // rule is worse than no readout.
      todayCap: Math.min(
        mine.filter((box) => box.active).reduce((t, box) => t + warmupCap(box.dailyCap, day), 0),
        domain.dailyCap,
      ),
      fullCap: Math.min(
        mine.filter((box) => box.active).reduce((t, box) => t + box.dailyCap, 0),
        domain.dailyCap,
      ),
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

/**
 * Add a sending domain and the mailboxes on it, in one go.
 *
 * Until now `mailboxes` was written only by the seed and acceptance scripts —
 * so growing the estate meant editing the database by hand, which is the real
 * reason throughput was stuck. You buy them a domain at a time with a handful
 * of boxes on it, so that is the shape of this.
 *
 * The warm-up clock starts now: a new domain sends 5 a day and compounds to
 * full cap over about three weeks, whatever caps are asked for here.
 */
export async function addDomain(input: {
  name: string
  /** Local parts — `hello` becomes `hello@the-domain`. */
  prefixes: string[]
  /** Per mailbox. The domain's own ceiling is separate. */
  cap?: number
  /** Anything; clampDomainCap decides what it means. */
  domainCap?: unknown
  credentialKey?: string | null
}) {
  const name = input.name.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(name)) {
    throw new Error(`"${input.name}" is not a domain name.`)
  }

  const [domain] = await db
    .insert(domains)
    .values({
      name,
      credentialKey: input.credentialKey || envName(name),
      dailyCap: clampDomainCap(input.domainCap),
      // Assume it is new, because it usually is. Warming can be cleared by
      // hand for a domain that has been sending for years.
      warmingSince: new Date(),
    })
    .onConflictDoUpdate({ target: domains.name, set: { dailyCap: clampDomainCap(input.domainCap) } })
    .returning()

  // 30–50 a day each is the published safe range; anything outside it is a
  // typo or a bad idea, and either way not what the estate should run on.
  const cap = Math.min(Math.max(Math.round(Number(input.cap) || 40), 5), 50)

  const wanted = input.prefixes
    .flatMap((p) => p.split(/[,\s]+/))
    .map((p) => p.trim().toLowerCase().replace(/@.*$/, ''))
    .filter(Boolean)

  if (wanted.length === 0) return { domain, added: 0 }

  const rows = await db
    .insert(mailboxes)
    .values(
      [...new Set(wanted)].map((prefix) => ({
        email: `${prefix}@${name}`,
        domainId: domain.id,
        dailyCap: cap,
        active: true,
      })),
    )
    .onConflictDoNothing()
    .returning()

  return { domain, added: rows.length }
}
