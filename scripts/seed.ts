import { createHash } from 'node:crypto'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { mailboxes, suppressions } from '../db/schema.ts'

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set')

const sql = postgres(process.env.DATABASE_URL, { max: 1 })
const db = drizzle(sql)

const domain = process.env.SEND_DOMAIN ?? 'example.com'

await db
  .insert(mailboxes)
  .values([
    { email: `hello@${domain}`, dailyCap: 35, sendsCatchAll: false },
    // Only this one may send to catch_all addresses (phase 3 rule).
    { email: `outreach@${domain}`, dailyCap: 35, sendsCatchAll: true },
  ])
  .onConflictDoNothing()

// Proves the import path skips suppressed addresses: sample.csv contains this one.
await db
  .insert(suppressions)
  .values({
    emailHash: createHash('sha256').update('blocked@example.com').digest('hex'),
    reason: 'manual',
  })
  .onConflictDoNothing()

// Every mailbox belongs to a domain. Done here rather than on a page render —
// adopting rows was a write on a read path, which is how a GET starts mutating.
// Must come before the connection closes.
const { attachAll } = await import('../lib/domains.ts')
await attachAll()

await sql.end()
console.log('seeded, mailboxes attached to their domains')
