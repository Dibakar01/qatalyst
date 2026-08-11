// Wipe contacts and suppressions so a manual test run starts clean. Local only.
import { sql as raw } from 'drizzle-orm'
import { db, sql } from '../db/index.ts'

if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL ?? '')) {
  throw new Error('refusing to run: DATABASE_URL is not local')
}

await db.execute(raw`truncate contacts, suppressions, campaigns, messages, events, mailboxes restart identity cascade`)
await sql.end()
console.log('everything cleared — run npm run db:seed next')
