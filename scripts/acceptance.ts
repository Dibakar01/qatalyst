// Phase 1-3 acceptance criteria, run against a local database.
//   npm run test:acceptance
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { sql as raw } from 'drizzle-orm'
import Papa from 'papaparse'
import { db, sql } from '../db/index.ts'
import { campaigns, contacts, events, mailboxes, messages, suppressions } from '../db/schema.ts'
import { eraseContact, runImport } from '../lib/contacts.ts'
import { sendTick } from '../lib/send.ts'
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


console.log('6. sending: eligibility, pacing and suppression at the wire')
await db.execute(raw`truncate contacts, suppressions, messages, events, mailboxes, campaigns restart identity cascade`)

const [, catchAllBox] = await db
  .insert(mailboxes)
  .values([
    { email: 'a@qalakaar.test', dailyCap: 35, sendsCatchAll: false },
    { email: 'b@qalakaar.test', dailyCap: 35, sendsCatchAll: true },
  ])
  .returning()

const [campaign] = await db
  .insert(campaigns)
  .values({ name: 'Acceptance', status: 'sending', bodyTemplate: '{{personalised}}' })
  .returning()

const people = await db
  .insert(contacts)
  .values([
    { email: 'v@example.test', firstName: 'Vee', emailStatus: 'verified' },
    { email: 'c@example.test', firstName: 'Cee', emailStatus: 'catch_all' },
    { email: 'u@example.test', firstName: 'You', emailStatus: 'unverified' },
    { email: 's@example.test', firstName: 'Ess', emailStatus: 'verified' },
  ])
  .returning()
const by = Object.fromEntries(people.map((p) => [p.email!, p]))

await suppress('s@example.test', 'manual')
await db.insert(messages).values(
  people.map((person) => ({
    campaignId: campaign.id,
    contactId: person.id,
    subject: 'Hello',
    body: 'A body with an opt-out.',
    status: 'approved' as const,
  })),
)

// A fixed weekday, not "today".
//
// The sender does not send at weekends — a mailbox pushing cold outreach on a
// Sunday at its weekday rate is a pattern no person produces. That made this
// suite pass Monday to Friday and fail on Saturday, which is the definition of
// a flaky test: the same code, a different answer, depending on the calendar.
const nextWeekday = () => {
  const d = new Date()
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1)
  return d
}

const noon = nextWeekday()
noon.setHours(12, 0, 0, 0)
const early = nextWeekday()
early.setHours(7, 0, 0, 0)

assert.equal((await sendTick(early)).sent, 0, 'nothing goes out before the window opens')
ok('outside the sending window nothing is sent')

const tick = await sendTick(noon)
assert.equal(tick.sent, 2, 'one send per mailbox per tick, never a burst')
assert.equal(tick.dryRun, true, 'no Gmail credentials configured, so this was a dry run')

const afterFirst = await db.select().from(messages)
const state = (email: string) => afterFirst.find((m) => m.contactId === by[email].id)!

assert.equal(state('v@example.test').status, 'sent', 'verified sends')
assert.equal(state('c@example.test').status, 'sent', 'catch-all sends from the flagged mailbox')
assert.equal(state('u@example.test').status, 'approved', 'unverified is never sent')
ok('verified and catch-all sent, unverified never')

assert.equal(
  state('c@example.test').mailboxId,
  catchAllBox.id,
  'catch-all only ever leaves the mailbox flagged for it',
)
assert.notEqual(state('v@example.test').mailboxId, null)
ok('catch-all used the catch-all mailbox')

for (const email of ['v@example.test', 'c@example.test']) {
  assert.ok(state(email).messageIdHeader, `Message-ID captured for ${email}`)
  assert.ok(state(email).sentAt)
}
ok('rule 6: every send captured its Message-ID')

const sentEvents = await db.select().from(events).where(raw`type = 'sent'`)
assert.equal(sentEvents.length, 2, 'one event per delivery')
ok('deliveries are recorded as events')

// The second tick scans past what it may not send: the unverified contact is
// skipped, and the suppressed one is taken out of the queue rather than mailed.
const secondTick = await sendTick(noon)
assert.equal(secondTick.sent, 0, 'nothing eligible is left')

const afterSecond = await db.select().from(messages)
const later = (email: string) => afterSecond.find((m) => m.contactId === by[email].id)!
assert.equal(later('s@example.test').status, 'flagged', 'suppressed is caught before delivery')
assert.equal(later('s@example.test').error, 'suppressed before sending')
assert.equal(later('u@example.test').status, 'approved', 'unverified is left alone, never sent')
assert.equal(afterSecond.filter((m) => m.status === 'sent').length, 2, 'still only two sent')
ok('suppression stops a delivery at send time, not just at import')

await sql.end()
console.log('\nphase 1-3 acceptance: all checks passed')
