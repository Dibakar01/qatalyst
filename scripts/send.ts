// The sender. Runs a tick a minute so the daily cap spreads across the day
// instead of going out in a burst:  npm run send
import { and, eq, isNull, lt, or } from 'drizzle-orm'
import { db, sql } from '../db/index.ts'
import { connectors } from '../db/schema.ts'
import { WINDOW } from '../lib/rules.ts'
import { refreshPostmaster } from '../lib/domains.ts'
import { readTick } from '../lib/inbox.ts'
import { assertDbTimezone, sendTick, sendTz } from '../lib/send.ts'
import { canPull, runSource } from '../lib/sources.ts'

const EVERY = 60_000

// Before the first tick, not during one. If the app and the database keep
// different calendars the daily counters roll over at a different instant from
// the window, and a cap is briefly spendable twice — which is invisible in the
// logs and only shows up as a domain's reputation falling. Refusing to start is
// the cheap end of that.
await assertDbTimezone()

/**
 * Pull every source that has not run today, once a day, on the same loop that
 * works the send queue. One process, no scheduler, no new dependency.
 *
 * ponytail: daily and global. If a source ever needs its own cadence, that is
 * the point to reach for a real queue — pg-boss runs on the Postgres already
 * here, so it would still not add a service.
 */
async function pullDue() {
  const midnight = new Date()
  midnight.setHours(0, 0, 0, 0)

  const due = await db
    .select()
    .from(connectors)
    .where(
      and(
        eq(connectors.active, true),
        // Never run, or last run before today. Without the null arm a source
        // that has never run would never be picked up at all.
        or(isNull(connectors.lastRunAt), lt(connectors.lastRunAt, midnight)),
      ),
    )

  for (const source of due) {
    if (!canPull(source.kind)) continue
    try {
      console.log(`${clock()}  pulling ${source.name}: ${await runSource(source.id)}`)
    } catch (cause) {
      console.log(`${clock()}  ${source.name} refused: ${cause instanceof Error ? cause.message : cause}`)
    }
  }
}

const clock = () => new Date().toLocaleTimeString('en-GB', { hour12: false })

let stopping = false
process.on('SIGINT', () => {
  stopping = true
})

console.log(
  `sender running — window ${String(WINDOW.start / 60).padStart(2, '0')}:00 to ${WINDOW.end / 60}:00 ${sendTz()}, ctrl-c to stop`,
)

while (!stopping) {
  try {
    await pullDue()
    // What Google thinks of each domain. Once a day; a domain over the 0.30%
    // line pauses itself here rather than waiting to be noticed.
    const checked = await refreshPostmaster()
    if (checked > 0) console.log(`${clock()}  postmaster: ${checked} ${checked === 1 ? 'domain' : 'domains'} checked`)

    // Read before sending. What came back changes what may go out — a bounce
    // can halt a mailbox, and a reply must stop the follow-up — so listening
    // first means this tick acts on the freshest possible picture.
    const post = await readTick()
    for (const line of post.detail) console.log(`${clock()}  ${line}`)
    if (post.replied > 0 || post.bounced > 0) {
      console.log(
        `${clock()}  read ${post.read}: ${post.replied} replied, ${post.bounced} bounced${post.auto > 0 ? `, ${post.auto} auto` : ''}`,
      )
    }

    const tick = await sendTick()
    for (const line of tick.detail) console.log(`${clock()}  ${line}`)
    if (tick.halted.length > 0) {
      console.log(`${clock()}  HALTED: bounce rate above 3% on ${tick.halted.join(', ')}`)
    }
    if (tick.sent > 0 && tick.dryRun) {
      console.log(`${clock()}  (dry run — set GOOGLE_SERVICE_ACCOUNT_JSON to actually send)`)
    }
  } catch (cause) {
    console.error(`${clock()}  tick failed:`, cause)
  }
  await new Promise((resolve) => setTimeout(resolve, EVERY))
}

await sql.end()
console.log('sender stopped')
