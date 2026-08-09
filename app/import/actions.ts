'use server'

import { requireAuth } from '@/lib/auth'
import { runImport } from '@/lib/contacts'
import type { Mapping, Row } from '@/lib/csv'

export async function importRows(mapping: Mapping, rows: Row[], source: string) {
  await requireAuth()
  return runImport(mapping, rows, source)
}
