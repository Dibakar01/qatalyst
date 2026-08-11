// The sender. Runs a tick a minute so the daily cap spreads across the day
// instead of going out in a burst:  npm run send
import { sql } from '../db/index.ts'
import { WINDOW } from '../lib/rules.ts'
import { sendTick } from '../lib/send.ts'

const EVERY = 60_000

const clock = () => new Date().toLocaleTimeString('en-GB', { hour12: false })

let stopping = false
process.on('SIGINT', () => {
  stopping = true
})

console.log(
  `sender running — window ${String(WINDOW.start / 60).padStart(2, '0')}:00 to ${WINDOW.end / 60}:00 local, ctrl-c to stop`,
)

while (!stopping) {
  try {
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
