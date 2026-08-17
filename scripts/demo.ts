// Fills a local database with browsable data: npm run db:demo
// Imports sample.csv, then spreads the email statuses so every state is visible.
import { readFileSync } from 'node:fs'
import { sql as raw } from 'drizzle-orm'
import Papa from 'papaparse'
import { db, sql } from '../db/index.ts'
import { campaigns, contacts, messages } from '../db/schema.ts'
import { runImport } from '../lib/contacts.ts'
import type { Row } from '../lib/csv.ts'
import { assembleBody, fill, SLOT, variables } from '../lib/template.ts'
import { unsubscribeUrl } from '../lib/token.ts'
import { validate } from '../lib/validators.ts'

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

// A campaign with two hand-written lines, run through the real validators so
// the review step has something honest in it before an API key is configured.
const [campaign] = await db
  .insert(campaigns)
  .values({
    name: 'Demo campaign',
    subjectTemplate: 'A question about {{company}}',
    bodyTemplate: 'Hi {{first_name}},\n\n{{personalised}}\n\nWorth a short call next week?\n\nDibakar',
    prompt: 'Say why we are writing to this person in particular.',
    status: 'ready',
  })
  .returning()

const written: Record<string, string> = {
  'ada@analytical.example':
    'Your PyCon talk on batch jobs lined up almost exactly with a scheduling problem we keep running into.',
  'grace@compiler.example':
    'Congratulations on closing the Series B last month — Sequoia backing a compiler company is a good sign.',
}

const people = await db.select().from(contacts)
const drafts = people
  .filter((person) => person.email && written[person.email])
  .map((person) => {
    const line = written[person.email!]
    const values = variables(person)
    const flags = validate(line, person)
    return {
      campaignId: campaign.id,
      contactId: person.id,
      subject: fill(campaign.subjectTemplate, values),
      body: assembleBody(
        fill(campaign.bodyTemplate, { ...values, [SLOT]: line }),
        unsubscribeUrl(person.email!),
      ).body,
      status: (flags.length ? 'flagged' : 'draft') as 'flagged' | 'draft',
      validatorFlags: flags,
    }
  })
if (drafts.length > 0) await db.insert(messages).values(drafts).onConflictDoNothing()

await sql.end()
console.log(counts)
console.log(`demo campaign: ${drafts.filter((d) => d.status === 'draft').length} clean, ${drafts.filter((d) => d.status === 'flagged').length} flagged`)
console.log('demo data loaded')
