import { desc } from 'drizzle-orm'
import { db } from '@/db'
import { mailboxes, suppressions } from '@/db/schema'
import { isConfigured } from '@/lib/gmail'
import { blockDomain } from '../actions'
import { button, field, Pill, Screen } from '../ui'

export default async function SettingsPage() {
  const [boxes, blocks] = await Promise.all([
    db.select().from(mailboxes).orderBy(mailboxes.email),
    db.select().from(suppressions).orderBy(desc(suppressions.createdAt)).limit(200),
  ])
  const capacity = boxes.filter((box) => box.active).reduce((total, box) => total + box.dailyCap, 0)

  return (
    <Screen title="Settings" note="Mailboxes we send from, and addresses we never send to.">
      <div className="min-h-0 flex-1 overflow-auto">
        <section className="border-b border-line px-6 py-6">
          <h2 className="mb-1 font-medium">Mailboxes</h2>
          <p className="mb-3.5 text-muted">
            {boxes.length} configured, {capacity} sends a day at full capacity.{' '}
            {isConfigured()
              ? 'Gmail credentials are set — sends are real.'
              : 'No Gmail credentials, so sending runs as a dry run and records what it would have sent.'}
          </p>
          <div className="max-w-2xl overflow-hidden rounded-xl border border-line">
            {boxes.map((box) => (
              <div
                key={box.id}
                className="flex items-center gap-3 border-b border-line px-4 py-3 last:border-b-0"
              >
                <span className="flex-1 truncate font-medium">{box.email}</span>
                <span className="text-muted">{box.dailyCap}/day</span>
                {box.sendsCatchAll && <Pill tone="catch_all">catch-all · 10/day</Pill>}
                {!box.active && <Pill>paused</Pill>}
              </div>
            ))}
            {boxes.length === 0 && (
              <p className="px-4 py-3 text-muted">
                None yet — <code className="font-mono">npm run db:seed</code> adds the first two.
              </p>
            )}
          </div>
          <p className="mt-2.5 text-muted">
            Before any of this sends for real: SPF, DKIM and DMARC on the sending domain, then a
            two to three week warm-up from about five a day up to the cap.
          </p>
        </section>

        <section className="px-6 py-6">
          <h2 className="mb-1 font-medium">Suppressions</h2>
          <p className="mb-3.5 text-muted">
            {blocks.length} entries. Addresses are stored as a hash, so a person can be erased and
            still never be emailed. There is no way to remove one.
          </p>

          <form action={blockDomain} className="mb-3.5 flex flex-wrap items-center gap-2">
            <input
              name="domain"
              placeholder="competitor.com"
              aria-label="Domain to block"
              className={`${field} w-56`}
            />
            <select name="reason" defaultValue="competitor" className={`${field} w-40`}>
              <option value="competitor">Competitor</option>
              <option value="customer">Customer</option>
              <option value="manual">Other</option>
            </select>
            <button className={button}>Block whole domain</button>
          </form>

          <div className="max-w-2xl overflow-hidden rounded-xl border border-line">
            {blocks.map((row) => (
              <div
                key={row.id}
                className="flex items-center gap-3 border-b border-line px-4 py-2.5 last:border-b-0"
              >
                <span className="flex-1 truncate">
                  {row.domain ? (
                    <span className="font-medium">@{row.domain}</span>
                  ) : (
                    <span className="font-mono text-[12px] text-muted">
                      {row.emailHash?.slice(0, 28)}…
                    </span>
                  )}
                </span>
                <Pill tone={row.reason === 'unsubscribed' ? 'opted_in' : row.reason}>
                  {row.reason}
                </Pill>
              </div>
            ))}
            {blocks.length === 0 && <p className="px-4 py-3 text-muted">Nothing suppressed yet.</p>}
          </div>
        </section>
      </div>
    </Screen>
  )
}
