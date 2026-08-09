import Link from 'next/link'
import { consentStatus, emailStatus } from '@/db/schema'
import { contactStats, getContact, listContacts } from '@/lib/contacts'
import { erase, saveStatus, suppressEmail, suppressSelected } from './actions'
import Importer from './importer'
import { ClearFilters, Filter, Search } from './toolbar'
import { ConsentPill, Empty, EmailStatusPill, Stat } from './ui'

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? ''

const COLUMNS = [
  { key: 'name', label: 'Contact', className: 'w-[30%]' },
  { key: 'company', label: 'Company', className: 'w-[22%]' },
  { key: '', label: 'Title', className: 'w-[20%]' },
  { key: 'status', label: 'Email status', className: 'w-[12%]' },
  { key: '', label: 'Consent', className: 'w-[10%]' },
  { key: 'added', label: 'Added', className: 'w-[12%]' },
] as const

const fmt = (d: Date) =>
  d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })

export default async function ContactsPage({ searchParams }: PageProps<'/'>) {
  const sp = await searchParams
  const q = one(sp.q).trim()
  const status = one(sp.status)
  const consent = one(sp.consent)
  const sort = one(sp.sort)
  const dir = one(sp.dir)
  const openContact = one(sp.contact)
  const panel = one(sp.panel)

  const [stats, list, selected] = await Promise.all([
    contactStats(),
    listContacts({ q, status, consent, sort, dir, page: Number(one(sp.page)) || 1 }),
    openContact ? getContact(openContact) : undefined,
  ])

  // Every link on the page keeps the filters you already set.
  const href = (patch: Record<string, string | undefined>) => {
    const next = new URLSearchParams()
    for (const [k, v] of Object.entries({ q, status, consent, sort, dir, page: one(sp.page) })) {
      if (v) next.set(k, v)
    }
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v)
      else next.delete(k)
    }
    const qs = next.toString()
    return qs ? `/?${qs}` : '/'
  }

  const closed = href({ contact: undefined, panel: undefined })
  const filtered = Boolean(q || status || consent)

  return (
    <>
      <header className="flex items-center justify-between gap-3 border-b border-line px-5 py-3.5">
        <div>
          <h1 className="text-[15px] font-semibold tracking-tight">Contacts</h1>
          <p className="text-muted">
            {list.total.toLocaleString()} {filtered ? 'matching' : 'in the list'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <a
            href={`/api/export?${new URLSearchParams({ ...(q && { q }), ...(status && { status }), ...(consent && { consent }) })}`}
            className="rounded-lg border border-line px-3 py-1.5 font-medium transition-colors hover:bg-faint"
          >
            Export CSV
          </a>
          <Link
            href={href({ panel: 'import', contact: undefined })}
            className="rounded-lg bg-ink px-3 py-1.5 font-medium text-white transition-opacity hover:opacity-85"
          >
            Import CSV
          </Link>
        </div>
      </header>

      <section className="grid grid-cols-2 gap-2.5 px-5 py-4 lg:grid-cols-4">
        <Stat label="Total" value={stats.total} />
        <Stat
          label="Sendable"
          value={stats.sendable}
          note={stats.total > 0 && stats.sendable === 0 ? 'none yet' : undefined}
          tone="warn"
        />
        <Stat label="Unverified" value={stats.unverified} />
        <Stat label="Erased" value={stats.erased} />
      </section>

      <div className="flex flex-wrap items-center gap-2 px-5 pb-3">
        <Search />
        <Filter name="status" label="Email status" options={emailStatus.enumValues} />
        <Filter name="consent" label="Consent" options={consentStatus.enumValues} />
        <ClearFilters active={filtered} />
      </div>

      {list.rows.length === 0 ? (
        <Empty
          title={filtered ? 'Nothing matches those filters' : 'No contacts yet'}
          hint={filtered ? 'Clear them to see the whole list.' : 'Import a CSV to get started.'}
        />
      ) : (
        <form action={suppressSelected} className="group flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-auto">
            <table className="w-full border-separate border-spacing-0">
              <thead className="sticky top-0 z-10 bg-surface">
                <tr className="border-b border-line">
                  <th className="w-9 border-b border-line px-5 py-2" />
                  {COLUMNS.map((column) => (
                    <th
                      key={column.label}
                      className={`border-b border-line px-3 py-2 text-left text-[11.5px] font-medium uppercase tracking-wider text-muted ${column.className}`}
                    >
                      {column.key ? (
                        <Link
                          href={href({
                            sort: column.key,
                            dir: sort === column.key && dir !== 'asc' ? 'asc' : undefined,
                          })}
                          className="inline-flex items-center gap-1 hover:text-ink"
                        >
                          {column.label}
                          <span className={sort === column.key ? 'opacity-100' : 'opacity-0'}>
                            {dir === 'asc' ? '↑' : '↓'}
                          </span>
                        </Link>
                      ) : (
                        column.label
                      )}
                    </th>
                  ))}
                  <th className="w-10 border-b border-line" />
                </tr>
              </thead>
              <tbody>
                {list.rows.map((contact) => {
                  const name = [contact.firstName, contact.lastName].filter(Boolean).join(' ')
                  return (
                    <tr key={contact.id} className="group/row hover:bg-faint">
                      <td className="border-b border-line px-5 py-2.5 align-middle">
                        <input
                          type="checkbox"
                          name="ids"
                          value={contact.id}
                          aria-label={`Select ${name || contact.id}`}
                          className="size-3.5 accent-ink"
                        />
                      </td>
                      <td className="border-b border-line px-3 py-2.5">
                        <Link href={href({ contact: contact.id, panel: undefined })} className="block">
                          <span className="font-medium">
                            {name || (
                              <span className="italic text-muted">
                                {contact.erasedAt ? 'erased' : 'unnamed'}
                              </span>
                            )}
                          </span>
                          <span className="block truncate text-muted">{contact.email ?? '—'}</span>
                        </Link>
                      </td>
                      <td className="border-b border-line px-3 py-2.5">{contact.company ?? '—'}</td>
                      <td className="truncate border-b border-line px-3 py-2.5 text-muted">
                        {contact.title ?? '—'}
                      </td>
                      <td className="border-b border-line px-3 py-2.5">
                        <EmailStatusPill status={contact.emailStatus} />
                      </td>
                      <td className="border-b border-line px-3 py-2.5">
                        <ConsentPill status={contact.consentStatus} />
                      </td>
                      <td className="border-b border-line px-3 py-2.5 text-muted">
                        {fmt(contact.createdAt)}
                      </td>
                      <td className="border-b border-line pr-4 text-right">
                        <Link
                          href={href({ contact: contact.id, panel: undefined })}
                          aria-label="Open contact"
                          className="inline-block px-1 text-muted opacity-0 transition-opacity group-hover/row:opacity-100"
                        >
                          ›
                        </Link>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {/* Appears only when something is ticked — pure CSS, no state to get wrong. */}
          <div className="hidden items-center gap-3 border-t border-line bg-faint px-5 py-2.5 group-has-[input:checked]:flex">
            <span className="text-muted">Selected contacts</span>
            <button className="rounded-lg bg-ink px-3 py-1.5 font-medium text-white transition-opacity hover:opacity-85">
              Add to suppression
            </button>
            <span className="text-muted">Permanent. They can never be emailed again.</span>
          </div>
        </form>
      )}

      <footer className="flex items-center justify-between border-t border-line px-5 py-2.5 text-muted">
        <span>
          Page {list.page} of {list.pages}
        </span>
        <div className="flex items-center gap-1">
          <PageLink href={href({ page: String(list.page - 1) })} disabled={list.page <= 1}>
            Previous
          </PageLink>
          <PageLink
            href={href({ page: String(list.page + 1) })}
            disabled={list.page >= list.pages}
          >
            Next
          </PageLink>
        </div>
      </footer>

      {panel === 'import' && (
        <Drawer title="Import CSV" closeHref={closed} wide>
          <Importer />
        </Drawer>
      )}

      {selected && (
        <Drawer
          title={[selected.firstName, selected.lastName].filter(Boolean).join(' ') || 'Contact'}
          closeHref={closed}
        >
          <div className="space-y-5 text-[13px]">
            <dl className="grid grid-cols-[7.5rem_1fr] gap-y-1.5">
              <Field label="Email">{selected.email ?? '—'}</Field>
              <Field label="Company">{selected.company ?? '—'}</Field>
              <Field label="Title">{selected.title ?? '—'}</Field>
              <Field label="LinkedIn">
                {selected.linkedinUrl ? (
                  <a
                    href={selected.linkedinUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="break-all underline underline-offset-2"
                  >
                    {selected.linkedinUrl}
                  </a>
                ) : (
                  '—'
                )}
              </Field>
              <Field label="Source">{selected.source ?? '—'}</Field>
              <Field label="Added">{fmt(selected.createdAt)}</Field>
              {selected.erasedAt ? (
                <Field label="Erased">{fmt(selected.erasedAt)}</Field>
              ) : null}
            </dl>

            {!selected.erasedAt && (
              <form action={saveStatus} className="space-y-2 rounded-xl border border-line p-3">
                <input type="hidden" name="id" value={selected.id} />
                <p className="font-medium">Sending eligibility</p>
                <p className="text-muted">
                  Only verified and catch-all addresses can ever be sent to. Catch-all is
                  restricted to a mailbox flagged for it.
                </p>
                <div className="flex gap-2">
                  <select
                    name="email_status"
                    defaultValue={selected.emailStatus}
                    className="flex-1 rounded-lg border border-line bg-faint px-2 py-1.5 capitalize"
                  >
                    {emailStatus.enumValues.map((value) => (
                      <option key={value} value={value}>
                        {value.replace('_', ' ')}
                      </option>
                    ))}
                  </select>
                  <select
                    name="consent_status"
                    defaultValue={selected.consentStatus}
                    className="flex-1 rounded-lg border border-line bg-faint px-2 py-1.5 capitalize"
                  >
                    {consentStatus.enumValues.map((value) => (
                      <option key={value} value={value}>
                        {value.replace('_', ' ')}
                      </option>
                    ))}
                  </select>
                </div>
                <button className="w-full rounded-lg bg-ink py-1.5 font-medium text-white transition-opacity hover:opacity-85">
                  Save
                </button>
              </form>
            )}

            <div>
              <p className="mb-1 font-medium">Context</p>
              <p className="mb-1.5 text-muted">
                Everything the CSV carried that is not a field above. Phase 2 personalises only
                from here.
              </p>
              <pre className="max-h-56 overflow-auto rounded-xl border border-line bg-faint p-3 text-[12px]">
                {Object.keys(selected.context).length
                  ? JSON.stringify(selected.context, null, 2)
                  : '{}'}
              </pre>
            </div>

            <div className="flex flex-wrap gap-2 border-t border-line pt-4">
              {selected.email && (
                <form action={suppressEmail}>
                  <input type="hidden" name="email" value={selected.email} />
                  <button className="rounded-lg border border-line px-3 py-1.5 font-medium transition-colors hover:bg-faint">
                    Add to suppression
                  </button>
                </form>
              )}
              {!selected.erasedAt && (
                <form action={erase}>
                  <input type="hidden" name="id" value={selected.id} />
                  <button className="rounded-lg border border-rose-200 px-3 py-1.5 font-medium text-rose-700 transition-colors hover:bg-rose-50">
                    Erase personal data
                  </button>
                </form>
              )}
            </div>
            <p className="text-muted">
              Erasing clears the personal fields and keeps the suppression hash, so they stay
              unmailable and a re-import cannot bring them back.
            </p>
          </div>
        </Drawer>
      )}
    </>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className="break-words">{children}</dd>
    </>
  )
}

function PageLink({
  href,
  disabled,
  children,
}: {
  href: string
  disabled: boolean
  children: React.ReactNode
}) {
  if (disabled) return <span className="rounded-lg px-2.5 py-1 opacity-35">{children}</span>
  return (
    <Link href={href} className="rounded-lg px-2.5 py-1 hover:bg-faint hover:text-ink">
      {children}
    </Link>
  )
}

function Drawer({
  title,
  closeHref,
  wide,
  children,
}: {
  title: string
  closeHref: string
  wide?: boolean
  children: React.ReactNode
}) {
  return (
    <div className="fixed inset-0 z-40">
      <Link href={closeHref} aria-label="Close" className="veil-in absolute inset-0 bg-ink/15" />
      <div
        className={`panel-in absolute right-0 top-0 flex h-full w-full flex-col border-l border-line bg-surface shadow-[0_0_60px_rgba(0,0,0,0.12)] ${
          wide ? 'max-w-3xl' : 'max-w-lg'
        }`}
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
          <h2 className="text-[15px] font-semibold tracking-tight">{title}</h2>
          <Link
            href={closeHref}
            aria-label="Close"
            className="grid size-7 place-items-center rounded-lg text-muted hover:bg-faint hover:text-ink"
          >
            ✕
          </Link>
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-5 py-4">{children}</div>
      </div>
    </div>
  )
}
