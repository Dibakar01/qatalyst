import { and, eq, isNotNull, isNull } from 'drizzle-orm'
import { db } from '../db/index.ts'
import { connectors, contacts, type Connector } from '../db/schema.ts'
import { apolloEnrich, apolloPull, apolloReady, PRESETS, type Ready } from './connectors.ts'
import { runImport } from './contacts.ts'
import { asEmailStatus } from './csv.ts'
import { normalise } from './email.ts'
import { verifierConfigured, verifyMany } from './verify.ts'

/**
 * Running the sources.
 *
 * `connectors.ts` holds the adapters and knows nothing about the database;
 * this holds the orchestration. The split is so the column presets and the
 * Apollo request shapes stay testable without a Postgres.
 */

/** Only some sources can be *asked* for rows. The rest are pushed to us. */
export const canPull = (kind: Connector['kind']) => kind === 'apollo'

export const readiness = (kind: Connector['kind']): Ready =>
  kind === 'apollo'
    ? apolloReady()
    : { ok: true }

export const listSources = (campaignId?: string) =>
  db
    .select()
    .from(connectors)
    .where(campaignId ? eq(connectors.campaignId, campaignId) : isNull(connectors.campaignId))
    .orderBy(connectors.createdAt)

export async function addSource(input: {
  campaignId?: string | null
  kind: Connector['kind']
  name: string
  config?: Record<string, string>
}) {
  const [row] = await db
    .insert(connectors)
    .values({
      campaignId: input.campaignId ?? null,
      kind: input.kind,
      name: input.name || input.kind,
      config: input.config ?? {},
    })
    .returning()
  return row
}

export const removeSource = (id: string) => db.delete(connectors).where(eq(connectors.id, id))

/**
 * Pull a source and put whatever comes back through the ordinary import.
 *
 * The summary it returns is what gets shown and stored, so a run that fetched
 * nothing says why rather than looking like a success with no rows.
 */
export async function runSource(id: string, limit = 25): Promise<string> {
  const [source] = await db.select().from(connectors).where(eq(connectors.id, id)).limit(1)
  if (!source) throw new Error('no such source')
  if (!canPull(source.kind)) throw new Error(`${source.kind} sources are pushed to, not pulled`)

  const ready = readiness(source.kind)
  if (!ready.ok) throw new Error(ready.why)

  let summary: string
  try {
    const pulled = await apolloPull(source.config, limit)
    if (pulled.rows.length === 0) {
      summary = 'nobody matched that search'
    } else {
      const counts = await runImport(pulled.mapping, pulled.rows, pulled.source)
      summary = `${counts.new} new · ${counts.duplicate} already known · ${counts.suppressed} suppressed · ${counts.malformed} malformed`
    }
  } catch (cause) {
    // The failure is recorded on the source rather than thrown away, so the
    // next person to look knows the last run refused and exactly why.
    summary = cause instanceof Error ? cause.message : String(cause)
    await db
      .update(connectors)
      .set({ lastRunAt: new Date(), lastResult: summary })
      .where(eq(connectors.id, id))
    throw cause
  }

  await db
    .update(connectors)
    .set({ lastRunAt: new Date(), lastResult: summary })
    .where(eq(connectors.id, id))
  return summary
}

/* ── enrichment ───────────────────────────────────────────────────────────── */

/** Apollo's bulk match takes ten at a time. */
const BATCH = 10

/**
 * Fill in what we do not know about people we already have.
 *
 * Deliberately not `runImport()`: that inserts and does nothing on conflict,
 * which is exactly right for importing and exactly wrong here — every one of
 * these already exists, so an import would report them all as duplicates and
 * change nothing. Enrichment is an update.
 *
 * The status Apollo returns goes through the same normaliser a CSV column
 * would, so an unrecognised value falls back to `unverified` — the never-send
 * default. A vendor's new spelling can never quietly promote an address.
 */
/**
 * Check the unverified against our own verifier.
 *
 * Free, unlimited and offline in the sense that matters — the list never
 * leaves our machine. Preferred over the paid path, and used first: anything
 * it can settle is a record we do not pay to enrich.
 */
export async function verifyUnverified(limit = BATCH) {
  if (!verifierConfigured()) throw new Error('No verifier. Set REACHER_URL — see docker-compose.yml.')

  const waiting = await db
    .select({ id: contacts.id, email: contacts.email })
    .from(contacts)
    .where(
      and(
        eq(contacts.emailStatus, 'unverified'),
        isNotNull(contacts.email),
        isNull(contacts.erasedAt),
      ),
    )
    .limit(Math.min(limit, BATCH))

  if (waiting.length === 0) return 'nothing was waiting to be checked'

  const byEmail = new Map(waiting.map((c) => [normalise(c.email!), c.id]))
  const { checked, changed } = await verifyMany(
    waiting.map((c) => c.email!),
    async (email, emailStatus) => {
      const id = byEmail.get(normalise(email))
      if (id) await db.update(contacts).set({ emailStatus }).where(eq(contacts.id, id))
    },
  )

  const stuck = checked - changed
  return `checked ${checked}, settled ${changed}${stuck > 0 ? `, ${stuck} still unknown` : ''}`
}

export async function enrichUnverified(limit = BATCH) {
  const ready = apolloReady()
  if (!ready.ok) throw new Error(ready.why)

  const waiting = await db
    .select({ id: contacts.id, email: contacts.email })
    .from(contacts)
    .where(
      and(
        eq(contacts.emailStatus, 'unverified'),
        isNotNull(contacts.email),
        isNull(contacts.erasedAt),
      ),
    )
    .limit(Math.min(limit, BATCH))

  if (waiting.length === 0) return 'nothing was waiting to be enriched'

  const pulled = await apolloEnrich(waiting.map((c) => c.email!))
  const byEmail = new Map(waiting.map((c) => [normalise(c.email!), c.id]))

  let updated = 0
  let sendable = 0
  for (const row of pulled.rows) {
    const id = byEmail.get(normalise(row.email ?? ''))
    if (!id) continue

    const status = asEmailStatus(row.email_status ?? '')
    await db
      .update(contacts)
      .set({
        // Only ever fill a gap. Enrichment must not overwrite something a
        // person typed by hand.
        title: row.title || undefined,
        company: row.company || undefined,
        linkedinUrl: row.linkedin_url || undefined,
        emailStatus: status,
        updatedAt: new Date(),
      })
      .where(and(eq(contacts.id, id), isNull(contacts.erasedAt)))
    updated++
    if (status === 'verified' || status === 'catch_all') sendable++
  }

  return `${updated} enriched · ${sendable} now sendable · ${waiting.length - updated} not found`
}

/** The webhook a push source is fed through, shown next to it in the UI. */
export const pushUrl = (preset: string) =>
  `${process.env.UNSUBSCRIBE_BASE_URL ?? ''}/api/ingest/${preset}`

export const PUSH_PRESETS = Object.entries(PRESETS).map(([key, p]) => ({ key, ...p }))
