import { and, asc, count, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from 'drizzle-orm'
import { db } from '../db/index.ts'
import { consentStatus, contacts, emailStatus, type Contact, type NewContact } from '../db/schema.ts'
import { mapRow, type Mapping, type Row } from './csv.ts'
import { suppress, suppressionIndex } from './suppression.ts'

export type EmailStatus = (typeof emailStatus.enumValues)[number]
export type ConsentStatus = (typeof consentStatus.enumValues)[number]

/** Statuses an address may be sent to. The other two are never-send. */
export const SENDABLE: EmailStatus[] = ['verified', 'catch_all']

export type ImportCounts = {
  new: number
  duplicate: number
  suppressed: number
  malformed: number
  errors: string[]
}

const CHUNK = 500

/**
 * Idempotent by construction: duplicates are caught by the unique indexes on
 * lower(email) and linkedin_url, not by anything clever here. Re-importing the
 * same file is a no-op that reports itself as duplicates.
 *
 * No auth here on purpose — this is the plain operation, so scripts and tests
 * can drive it. The server action in app/import/actions.ts is the guarded door.
 */
export async function runImport(
  mapping: Mapping,
  rows: Row[],
  source: string,
): Promise<ImportCounts> {
  const suppressed = await suppressionIndex()
  const counts: ImportCounts = { new: 0, duplicate: 0, suppressed: 0, malformed: 0, errors: [] }
  const pending: NewContact[] = []
  const seen = new Set<string>()

  for (const row of rows) {
    const result = mapRow(row, mapping)
    if ('error' in result) {
      counts.malformed++
      if (counts.errors.length < 10) counts.errors.push(result.error)
      continue
    }
    const contact = result.contact
    if (contact.email && suppressed(contact.email)) {
      counts.suppressed++
      continue
    }
    // Same file can list the same person twice; the DB would catch it, but
    // counting it here keeps the report honest.
    const key = contact.email ?? contact.linkedinUrl ?? ''
    if (seen.has(key)) {
      counts.duplicate++
      continue
    }
    seen.add(key)
    pending.push({ ...contact, source: contact.source ?? source })
  }

  for (let i = 0; i < pending.length; i += CHUNK) {
    const chunk = pending.slice(i, i + CHUNK)
    const inserted = await db
      .insert(contacts)
      .values(chunk)
      .onConflictDoNothing()
      .returning({ id: contacts.id })
    counts.new += inserted.length
    counts.duplicate += chunk.length - inserted.length
  }

  return counts
}

/**
 * DPDP erasure: personal fields go, `erased_at` is stamped, the suppression hash
 * stays. Suppressing first is deliberate — once the address is gone we could
 * never honour a future request for it, and a re-import would resurrect them.
 */
export type ListQuery = {
  q?: string
  status?: string
  consent?: string
  sort?: string
  dir?: string
  page?: number
  size?: number
}

const SORTS = {
  name: contacts.firstName,
  company: contacts.company,
  status: contacts.emailStatus,
  added: contacts.createdAt,
} as const

export async function listContacts(query: ListQuery) {
  const size = Math.min(Math.max(query.size ?? 25, 5), 5000)
  const page = Math.max(query.page ?? 1, 1)

  const filters: (SQL | undefined)[] = [
    query.q
      ? or(
          ilike(contacts.firstName, `%${query.q}%`),
          ilike(contacts.lastName, `%${query.q}%`),
          ilike(contacts.company, `%${query.q}%`),
          ilike(contacts.email, `%${query.q}%`),
        )
      : undefined,
    emailStatus.enumValues.includes(query.status as never)
      ? eq(contacts.emailStatus, query.status as EmailStatus)
      : undefined,
    consentStatus.enumValues.includes(query.consent as never)
      ? eq(contacts.consentStatus, query.consent as ConsentStatus)
      : undefined,
  ]
  const where = and(...filters)

  const column = SORTS[query.sort as keyof typeof SORTS] ?? contacts.createdAt
  const order = query.dir === 'asc' ? asc(column) : desc(column)

  const [rows, [{ total }]] = await Promise.all([
    db
      .select()
      .from(contacts)
      .where(where)
      .orderBy(order)
      .limit(size)
      .offset((page - 1) * size),
    db.select({ total: count() }).from(contacts).where(where),
  ])

  return { rows, total, page, size, pages: Math.max(Math.ceil(total / size), 1) }
}

/**
 * The four numbers that decide whether a campaign can run at all. `sendable` is
 * the honest one: an address only counts if its status says we may send to it.
 */
export async function contactStats() {
  const [row] = await db
    .select({
      total: count(),
      sendable: sql<number>`count(*) filter (
        where email_status in ('verified', 'catch_all') and erased_at is null
      )`.mapWith(Number),
      unverified: sql<number>`count(*) filter (
        where email_status = 'unverified' and erased_at is null
      )`.mapWith(Number),
      erased: sql<number>`count(*) filter (where erased_at is not null)`.mapWith(Number),
    })
    .from(contacts)
  return row
}

export async function setContactStatus(
  id: string,
  email: EmailStatus,
  consent: ConsentStatus,
): Promise<void> {
  await db
    .update(contacts)
    .set({ emailStatus: email, consentStatus: consent, updatedAt: new Date() })
    .where(and(eq(contacts.id, id), isNull(contacts.erasedAt)))
}

/** Bulk suppression still goes one address at a time through lib/suppression.ts. */
export async function suppressContacts(ids: string[]) {
  if (ids.length === 0) return 0
  const rows = await db
    .select({ email: contacts.email })
    .from(contacts)
    .where(inArray(contacts.id, ids))
  const emails = rows.map((r) => r.email).filter((e): e is string => Boolean(e))
  for (const email of emails) await suppress(email, 'manual')
  return emails.length
}

export async function getContact(id: string): Promise<Contact | undefined> {
  const [row] = await db.select().from(contacts).where(eq(contacts.id, id))
  return row
}

export async function eraseContact(id: string) {
  const [row] = await db.select({ email: contacts.email }).from(contacts).where(eq(contacts.id, id))
  if (!row) return
  if (row.email) await suppress(row.email, 'manual')
  await db
    .update(contacts)
    .set({
      firstName: null,
      lastName: null,
      email: null,
      company: null,
      title: null,
      linkedinUrl: null,
      context: {},
      erasedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(contacts.id, id))
}
