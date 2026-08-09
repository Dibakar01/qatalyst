import { db } from '@/db'
import { mailboxes } from '@/db/schema'
import { Empty } from '../ui'

export default async function MailboxesPage() {
  const rows = await db.select().from(mailboxes).orderBy(mailboxes.email)
  const capacity = rows
    .filter((row) => row.active)
    .reduce((total, row) => total + row.dailyCap, 0)

  return (
    <>
      <header className="border-b border-line px-5 py-3.5">
        <h1 className="text-[15px] font-semibold tracking-tight">Mailboxes</h1>
        <p className="text-muted">
          {rows.length} configured · {capacity} sends a day at full capacity. Read-only until
          phase 3 wires up sending.
        </p>
      </header>

      {rows.length === 0 ? (
        <Empty title="No mailboxes" hint="Run npm run db:seed to add the first two." />
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full border-separate border-spacing-0">
            <thead className="sticky top-0 bg-surface">
              <tr>
                {['Mailbox', 'Daily cap', 'Catch-all', 'State'].map((label) => (
                  <th
                    key={label}
                    className="border-b border-line px-5 py-2 text-left text-[11.5px] font-medium uppercase tracking-wider text-muted"
                  >
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="hover:bg-faint">
                  <td className="border-b border-line px-5 py-2.5 font-medium">{row.email}</td>
                  <td className="border-b border-line px-5 py-2.5">
                    {row.dailyCap}
                    <span className="text-muted"> / day</span>
                  </td>
                  <td className="border-b border-line px-5 py-2.5">
                    {row.sendsCatchAll ? (
                      <span className="inline-flex items-center rounded-full bg-amber-50 px-2 py-0.5 text-[11.5px] font-medium text-amber-700 ring-1 ring-inset ring-amber-600/15">
                        Permitted · 10/day
                      </span>
                    ) : (
                      <span className="text-muted">Not permitted</span>
                    )}
                  </td>
                  <td className="border-b border-line px-5 py-2.5">
                    <span className={row.active ? '' : 'text-muted'}>
                      {row.active ? 'Active' : 'Paused'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <footer className="border-t border-line px-5 py-3 text-muted">
        Before any of this sends: SPF, DKIM and DMARC on the sending domain, then a two to three
        week warm-up from about five a day up to the cap.
      </footer>
    </>
  )
}
