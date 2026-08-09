import { createHash } from 'node:crypto'
import { neon } from '@neondatabase/serverless'
import { drizzle } from 'drizzle-orm/neon-http'
import { mailboxes, suppressions } from '../db/schema.ts'

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set')
const db = drizzle(neon(process.env.DATABASE_URL))

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

console.log('seeded')
