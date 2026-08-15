// What a 25-mailbox estate actually costs the sender:  npm run estate
//
// Throughput is bounded by deliverability, not software — 30–50 a day per
// mailbox and ~250 per domain. This builds the estate that reaches 1,000 a day
// and measures a tick against it, because the send loop used to run one queue
// query per mailbox.
import { sql as raw } from 'drizzle-orm'
import { db, sql } from '../db/index.ts'
import { addDomain } from '../lib/domains.ts'
import { sendTick } from '../lib/send.ts'

if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL ?? '')) {
  throw new Error('refusing to run: DATABASE_URL is not local')
}

const DOMAINS = 5
const PER_DOMAIN = 5
const CAP = 40

for (let d = 1; d <= DOMAINS; d++) {
  await addDomain({
    name: `estate-${d}.test`,
    prefixes: Array.from({ length: PER_DOMAIN }, (_, i) => `box${i + 1}`),
    cap: CAP,
    domainCap: 250,
  })
}

const [{ boxes }] = await db.execute<{ boxes: number }>(
  raw`select count(*)::int boxes from mailboxes where email like '%@estate-%'`,
)
console.log(`\n  estate: ${boxes} mailboxes across ${DOMAINS} domains, ${CAP}/day each`)
console.log(`  ceiling: ${Math.min(boxes * CAP, DOMAINS * 250)} a day once warm\n`)

// Time it. Counting queries was tempting but I could only intercept
// `db.execute`, and the queue uses the query builder — so the number would
// have been 0 and wrong. The duration is real; the query structure is a fact
// about the code, stated below rather than measured badly.
const started = performance.now()
const tick = await sendTick(new Date(new Date().setHours(12, 0, 0, 0)))
const ms = performance.now() - started

console.log(`  one tick over ${boxes} mailboxes: ${ms.toFixed(0)}ms, sent ${tick.sent}`)
console.log(`  the queue select now runs once per tick rather than once per mailbox —`)
console.log(`  at this size that was ~${(boxes * 480).toLocaleString()} round trips a day, nearly all returning nothing.\n`)

await db.execute(raw`delete from mailboxes where email like '%@estate-%'`)
await db.execute(raw`delete from domains where name like 'estate-%'`)
console.log('  test estate removed')
await sql.end()
