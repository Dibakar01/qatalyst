import { desc } from 'drizzle-orm'
import { db } from '@/db'
import { suppressions } from '@/db/schema'
import { blockDomain } from '../actions'
import { Empty } from '../ui'

const REASON_TONE: Record<string, string> = {
  unsubscribed: 'bg-sky-50 text-sky-700 ring-sky-600/15',
  bounced: 'bg-rose-50 text-rose-700 ring-rose-600/15',
  complained: 'bg-rose-50 text-rose-700 ring-rose-600/15',
  customer: 'bg-emerald-50 text-emerald-700 ring-emerald-600/15',
  competitor: 'bg-amber-50 text-amber-700 ring-amber-600/15',
  manual: 'bg-faint text-muted ring-line',
}

export default async function SuppressionsPage() {
  const rows = await db.select().from(suppressions).orderBy(desc(suppressions.createdAt)).limit(500)
  const domains = rows.filter((row) => row.domain).length

  return (
    <>
      <header className="border-b border-line px-5 py-3.5">
        <h1 className="text-[15px] font-semibold tracking-tight">Suppressions</h1>
        <p className="text-muted">
          {rows.length.toLocaleString()} entries · {domains} whole domains. Addresses are stored as
          a hash, so a person can be erased and still never be emailed. There is no way to remove
          one.
        </p>
      </header>

      <form
        action={blockDomain}
        className="flex flex-wrap items-center gap-2 border-b border-line px-5 py-3"
      >
        <input
          name="domain"
          placeholder="competitor.com"
          aria-label="Domain to block"
          className="w-56 rounded-lg border border-line bg-faint px-2.5 py-1.5 placeholder:text-muted focus:bg-surface"
        />
        <select
          name="reason"
          defaultValue="competitor"
          className="rounded-lg border border-line bg-faint px-2.5 py-1.5"
        >
          <option value="competitor">Competitor</option>
          <option value="customer">Customer</option>
          <option value="manual">Other</option>
        </select>
        <button className="rounded-lg bg-ink px-3 py-1.5 font-medium text-white transition-opacity hover:opacity-85">
          Block domain
        </button>
        <span className="text-muted">Blocks every address at that domain, now and in future.</span>
      </form>

      {rows.length === 0 ? (
        <Empty
          title="Nothing suppressed yet"
          hint="Unsubscribes, bounces and manual blocks all land here."
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full border-separate border-spacing-0">
            <thead className="sticky top-0 bg-surface">
              <tr>
                {['Entry', 'Reason', 'Added'].map((label) => (
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
                  <td className="border-b border-line px-5 py-2.5">
                    {row.domain ? (
                      <span className="font-medium">@{row.domain}</span>
                    ) : (
                      <span className="font-mono text-[12px] text-muted">
                        {row.emailHash?.slice(0, 24)}…
                      </span>
                    )}
                  </td>
                  <td className="border-b border-line px-5 py-2.5">
                    <span
                      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11.5px] font-medium capitalize ring-1 ring-inset ${REASON_TONE[row.reason]}`}
                    >
                      {row.reason}
                    </span>
                  </td>
                  <td className="border-b border-line px-5 py-2.5 text-muted">
                    {row.createdAt.toLocaleDateString('en-GB', {
                      day: '2-digit',
                      month: 'short',
                      year: 'numeric',
                    })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
