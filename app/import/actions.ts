'use server'

import { db } from '@/db'
import { contacts, type NewContact } from '@/db/schema'
import { requireAuth } from '@/lib/auth'
import { mapRow, type Mapping, type Row } from '@/lib/csv'
import { suppressionIndex } from '@/lib/suppression'

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
 */
export async function importRows(
  mapping: Mapping,
  rows: Row[],
  source: string,
): Promise<ImportCounts> {
  await requireAuth()

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
