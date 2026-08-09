import { eq } from 'drizzle-orm'
import { db } from '../db/index.ts'
import { contacts, type NewContact } from '../db/schema.ts'
import { mapRow, type Mapping, type Row } from './csv.ts'
import { suppress, suppressionIndex } from './suppression.ts'

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
