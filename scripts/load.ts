// What happens at volume:  npm run load
//
// Everything else in this repo checks that the rules are right. Nothing checked
// what they cost, so "never load-tested" was on the weakness list. This fills
// the largest table with a realistic year of sending and times the queries that
// run most often.
//
// It writes a lot of rows. Local database only, and `npm run db:reset` after.
import { sql as raw } from 'drizzle-orm'
import { db, sql } from '../db/index.ts'
import { audienceSize, audienceSizes } from '../lib/campaigns.ts'
import { byLetter, byMailbox, bySource, listHealth } from '../lib/reports.ts'
import { sendTick } from '../lib/send.ts'
import { tuning } from '../lib/settings.ts'

if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL ?? '')) {
  throw new Error('refusing to run: DATABASE_URL is not local')
}

const CONTACTS = Number(process.env.LOAD_CONTACTS ?? 20_000)
const MESSAGES = Number(process.env.LOAD_MESSAGES ?? 100_000)

async function time(label: string, fn: () => Promise<unknown>) {
  const started = performance.now()
  await fn()
  const ms = performance.now() - started
  const bar = '█'.repeat(Math.min(Math.round(ms / 20), 40))
  console.log(`  ${label.padEnd(26)}${ms.toFixed(0).padStart(6)}ms  ${bar}`)
  return ms
}

console.log(`\nfilling: ${CONTACTS.toLocaleString()} contacts, ${MESSAGES.toLocaleString()} messages\n`)

// generate_series does this server-side; inserting a hundred thousand rows over
// the wire one statement at a time would measure the network, not the database.
await db.execute(raw`
  insert into contacts (first_name, last_name, email, company, title, email_status, source, segments, stage)
  select
    'Load', 'Test ' || i, 'load' || i || '@example.test', 'Co ' || (i % 400), 'Head of ' || (i % 20),
    (array['verified','verified','verified','catch_all','unverified','invalid'])[1 + (i % 6)]::email_status,
    (array['apollo:founders','evaboot:q3','csv:handmade','linkedin:webhook'])[1 + (i % 4)],
    array[(array['SaaS founders','Met at PyCon','Enterprise','Warm intro'])[1 + (i % 4)]],
    (array['new','new','contacted','contacted','replied','qualified'])[1 + (i % 6)]::stage
  from generate_series(1, ${CONTACTS}) as i
  on conflict do nothing
`)

// A year of sending is several letters, not one — and the unique index on
// (campaign, contact) means one campaign can never hold more messages than
// there are people. Spreading across letters is both realistic and the only
// way to reach the target volume.
const letters = Math.max(Math.ceil(MESSAGES / CONTACTS), 1)
const ids: string[] = []

for (let n = 1; n <= letters; n++) {
  const [row] = await db.execute<{ id: string }>(raw`
    insert into campaigns (name, status, subject_template, body_template, prompt)
    values ('Load test ' || ${n}, 'sending', '{{company}}', 'Hi {{first_name}},

{{personalised}}

Worth a word?', 'Say why.')
    returning id::text
  `)
  ids.push(row.id)
}

for (const id of ids) {
  await db.execute(raw`
    insert into messages (campaign_id, contact_id, subject, body, status, mailbox_id, sent_at, message_id_header, validator_flags)
    select
      ${id}::uuid,
      c.id,
      'A subject',
      'A body with an opt-out.',
      (array['sent','sent','sent','sent','draft','flagged','approved','bounced'])[1 + (row_number() over () % 8)]::message_status,
      (select id from mailboxes order by random() limit 1),
      now() - (random() * interval '365 days'),
      '<load' || ${id} || c.id || '@qatalyst.local>',
      case when row_number() over () % 8 = 5 then '["ungrounded"]'::jsonb else '[]'::jsonb end
    from contacts c
    where c.email like 'load%'
    limit ${Math.ceil(MESSAGES / letters)}
    on conflict do nothing
  `)
}

// Clicks and conversions on a realistic slice, so the reports have joins to do.
await db.execute(raw`
  insert into events (contact_id, message_id, type, payload)
  select m.contact_id, m.id, 'click', '{}'::jsonb
  from messages m where m.status = 'sent' and random() < 0.03
`)

const campaign = { id: ids[0] }

const [{ n: total }] = await db.execute<{ n: number }>(raw`select count(*)::int as n from messages`)
const [{ n: people }] = await db.execute<{ n: number }>(raw`select count(*)::int as n from contacts`)
console.log(`  ready: ${people.toLocaleString()} contacts, ${total.toLocaleString()} messages\n`)

const rules = await tuning()

console.log('the reports — every one of these runs on opening Reports')
await time('bySource', () => bySource())
await time('byMailbox', () => byMailbox(rules))
await time('byLetter', () => byLetter())
await time('listHealth', () => listHealth())

console.log('\nthe desk — runs on every navigation')
const all = await db.execute<{ id: string; audience_segments: string[]; audience_stages: string[] }>(
  raw`select id::text, audience_segments, audience_stages from campaigns`,
)
const shaped = all.map((c) => ({
  id: c.id,
  audienceSegments: c.audience_segments,
  audienceStages: c.audience_stages,
}))
await time('audienceSize (one letter)', () => audienceSize(campaign.id))
await time(`audienceSizes (all ${all.length})`, () => audienceSizes(shaped))

console.log('\nthe sender — runs every minute')
await time('sendTick', () => sendTick(new Date(new Date().setHours(12, 0, 0, 0))))

console.log('\nAnything past ~200ms is felt. Past 1s the page is broken.')
console.log('npm run db:reset && npm run db:seed && npm run db:demo to clear.\n')

await sql.end()
