// Phase 1 acceptance criteria, run against a local database.
//   npm run test:acceptance
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { sql as raw } from 'drizzle-orm'
import Papa from 'papaparse'
import { db, sql } from '../db/index.ts'
import { contacts, suppressions } from '../db/schema.ts'
import { eraseContact, runImport } from '../lib/contacts.ts'
import type { Mapping, Row } from '../lib/csv.ts'
import { emailHash, isSuppressed, suppress } from '../lib/suppression.ts'
import { makeToken, readToken } from '../lib/token.ts'

// This truncates tables. Never let it point at anything but a dev database.
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL ?? '')) {
  throw new Error('refusing to run: DATABASE_URL is not local')
}

const ok = (label: string) => console.log(`  ok  ${label}`)

// The four counts describe rows processed, not people, so they must always
// account for every line in the file. A row that vanishes from the report is a bug.
const accountsForEveryRow = (c: { new: number; duplicate: number; suppressed: number; malformed: number }) =>
  c.new + c.duplicate + c.suppressed + c.malformed

await db.execute(raw`truncate contacts, suppressions, messages, events restart identity cascade`)
await suppress('blocked@example.com', 'manual')

const parsed = Papa.parse<Row>(readFileSync('sample.csv', 'utf8'), {
  header: true,
  skipEmptyLines: true,
})
const mapping: Mapping = {
  first_name: 'First',
  last_name: 'Last',
  email: 'Work Email',
  company: 'Org',
  title: 'Role',
  linkedin_url: 'Profile',
}

console.log('1. first import')
const first = await runImport(mapping, parsed.data, 'sample.csv')
assert.equal(first.new, 3, 'three importable contacts')
assert.equal(first.suppressed, 1, 'the seeded suppression is skipped')
assert.equal(first.malformed, 1, 'the bad address is rejected')
assert.equal(first.duplicate, 1, 'the repeated row is caught inside the file')
assert.equal(accountsForEveryRow(first), parsed.data.length)
ok('counts: 3 new / 1 duplicate / 1 suppressed / 1 malformed')

const [ada] = await db
  .select()
  .from(contacts)
  .where(raw`lower(email) = 'ada@analytical.example'`)
assert.equal(ada.company, 'Analytical Engines')
assert.equal(ada.context['Funding round'], 'Series A', 'unmapped column kept as context')
assert.equal(ada.context['Notes'], 'Spoke at PyCon, mentioned batch jobs')
assert.equal(ada.source, 'sample.csv')
ok('unmapped columns land in context, nothing dropped')

const [turing] = await db.select().from(contacts).where(raw`email is null`)
assert.ok(turing.linkedinUrl, 'emailless row kept via linkedin_url')
ok('rows with no email but a linkedin url are imported')

console.log('2. same file again — must not duplicate')
const second = await runImport(mapping, parsed.data, 'sample.csv')
assert.equal(second.new, 0, 'nothing new on re-import')
assert.equal(second.duplicate, 4, 'all four survivors seen as duplicates')
assert.equal(accountsForEveryRow(second), parsed.data.length)
assert.equal((await db.select().from(contacts)).length, 3, 'still three rows')
ok('import is idempotent')

console.log('3. erase keeps the suppression')
await eraseContact(ada.id)
const [erased] = await db.select().from(contacts).where(raw`id = ${ada.id}`)
assert.equal(erased.email, null)
assert.equal(erased.firstName, null)
assert.equal(erased.company, null)
assert.deepEqual(erased.context, {})
assert.ok(erased.erasedAt, 'erased_at stamped')
assert.ok(await isSuppressed('ada@analytical.example'), 'suppression outlives the contact row')
ok('personal fields gone, suppression hash intact')

console.log('4. an erased contact cannot be resurrected by re-importing')
const third = await runImport(mapping, parsed.data, 'sample.csv')
assert.equal(third.new, 0)
// Both of ada's rows are now suppressed, plus blocked@ — the counts are per row.
assert.equal(third.suppressed, 3, 'ada is skipped as suppressed, alongside blocked@')
assert.equal(accountsForEveryRow(third), parsed.data.length)
assert.equal((await db.select().from(contacts)).length, 3, 'no new row for ada')
ok('re-import skips the erased contact')

console.log('5. unsubscribe token')
const token = makeToken('Grace@Compiler.example')
assert.equal(readToken(token), 'grace@compiler.example')
assert.equal(readToken(token.slice(0, -2) + 'xx'), null, 'tampered token rejected')
await suppress(readToken(token)!, 'unsubscribed')
assert.ok(await isSuppressed('grace@compiler.example'))
const [row] = await db
  .select()
  .from(suppressions)
  .where(raw`email_hash = ${emailHash('grace@compiler.example')}`)
assert.equal(row.reason, 'unsubscribed')
assert.equal(
  (await db.select().from(suppressions)).every((s) => s.emailHash !== 'grace@compiler.example'),
  true,
  'addresses are never stored in plaintext',
)
ok('token round-trips, writes a hashed suppression')

await sql.end()
console.log('\nphase 1 acceptance: all checks passed')
