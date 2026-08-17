import { createHash } from 'node:crypto'
// The shared pool, not a private one: this script imports lib/domains.ts below, which
// opens db/index.ts's pool anyway. Two pools meant only one ever got closed, so the
// event loop never drained and the documented setup step hung forever.
import { db, sql } from '../db/index.ts'
import { mailboxes, suppressions } from '../db/schema.ts'

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
