// Fills a local database with browsable data: npm run db:demo
// Imports sample.csv, then spreads the email statuses so every state is visible.
import { readFileSync } from 'node:fs'
import { sql as raw } from 'drizzle-orm'
import Papa from 'papaparse'
import { db, sql } from '../db/index.ts'
import { runImport } from '../lib/contacts.ts'
import type { Row } from '../lib/csv.ts'

if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL ?? '')) {
  throw new Error('refusing to run: DATABASE_URL is not local')
}

const parsed = Papa.parse<Row>(readFileSync('sample.csv', 'utf8'), {
  header: true,
  skipEmptyLines: true,
})

const counts = await runImport(
  {
    first_name: 'First',
    last_name: 'Last',
    email: 'Work Email',
    company: 'Org',
    title: 'Role',
    linkedin_url: 'Profile',
  },
  parsed.data,
  'sample.csv',
)

await db.execute(raw`update contacts set email_status = 'verified' where company = 'Analytical Engines'`)
await db.execute(raw`update contacts set email_status = 'catch_all' where company = 'Compiler Co'`)
await db.execute(raw`update contacts set consent_status = 'opted_in' where company = 'Analytical Engines'`)

await sql.end()
console.log(counts)
console.log('demo data loaded')
