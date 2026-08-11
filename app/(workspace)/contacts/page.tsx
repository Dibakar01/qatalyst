import Link from 'next/link'
import { consentStatus, emailStatus } from '@/db/schema'
import { getContact, listContacts } from '@/lib/contacts'
import { erase, saveStatus, suppressEmail, suppressSelected } from '../actions'
import Importer from '../importer'
import { ClearFilters, Filter, Search } from '../toolbar'
import { button, field, ghost, Pill } from '../ui'

const LIMIT = 100
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? ''
const fmt = (d: Date) => d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })

export default async function ContactsPage({ searchParams }: PageProps<'/contacts'>) {
  const sp = await searchParams
  const q = one(sp.q).trim()
  const status = one(sp.status)
  const consent = one(sp.consent)
  const open = one(sp.contact)
  const panel = one(sp.panel)

  const [list, selected] = await Promise.all([
    listContacts({ q, status, consent, size: LIMIT }),
    open ? getContact(open) : undefined,
  ])

  const href = (patch: Record<string, string | undefined>) => {
    const next = new URLSearchParams()
    for (const [k, v] of Object.entries({ q, status, consent, ...patch })) if (v) next.set(k, v)
    const qs = next.toString()
    return qs ? `/contacts?${qs}` : '/contacts'
  }
  const closed = href({ contact: undefined, panel: undefined })
  const filtered = Boolean(q || status || consent)

  return (
    <>
      <header className="flex items-center justify-between gap-3 border-b border-line px-5 py-3.5">
        <div>
          <h1 className="text-[15px] font-semibold tracking-tight">Contacts</h1>
          <p className="text-muted">
            {list.total.toLocaleString()} {filtered ? 'matching' : 'on the list'}
            {list.total > LIMIT && ` — showing the first ${LIMIT}`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <a
            href={`/api/export?${new URLSearchParams({ ...(q && { q }), ...(status && { status }), ...(consent && { consent }) })}`}
            className={ghost}
          >
            Export CSV
          </a>
          <Link href={href({ panel: 'import', contact: undefined })} className={button}>
            Import CSV
          </Link>
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-2 border-b border-line px-5 py-2.5">
        <Search />
        <Filter name="status" label="Email status" options={emailStatus.enumValues} />
        <Filter name="consent" label="Consent" options={consentStatus.enumValues} />
        <ClearFilters active={filtered} />
      </div>

      {list.rows.length === 0 ? (
        <div className="grid flex-1 place-items-center px-6 py-16 text-center">
          <div>
            <p className="font-medium">{filtered ? 'Nothing matches' : 'No contacts yet'}</p>
            <p className="mt-1 text-muted">
              {filtered ? 'Clear the filters to see the whole list.' : 'Import a CSV to begin.'}
            </p>
          </div>
        </div>
      ) : (
        <form action={suppressSelected} className="group flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-auto">
            {list.rows.map((contact) => (
              <div
                key={contact.id}
                className="flex items-center gap-3 border-b border-line px-5 py-2.5 hover:bg-faint"
              >
                <input
                  type="checkbox"
                  name="ids"
                  value={contact.id}
                  aria-label={`Select ${contact.email ?? contact.id}`}
                  className="size-3.5 shrink-0 accent-ink"
                />
                <Link href={href({ contact: contact.id })} className="flex min-w-0 flex-1 gap-3">
                  <span className="w-48 shrink-0 truncate font-medium">
                    {[contact.firstName, contact.lastName].filter(Boolean).join(' ') || (
                      <span className="italic text-muted">
                        {contact.erasedAt ? 'erased' : 'unnamed'}
                      </span>
                    )}
                  </span>
                  <span className="w-56 shrink-0 truncate text-muted">{contact.email ?? '—'}</span>
                  <span className="min-w-0 flex-1 truncate text-muted">{contact.company ?? '—'}</span>
                </Link>
                <Pill>{contact.emailStatus}</Pill>
                {contact.consentStatus === 'opted_in' && <Pill tone="opted_in">opted in</Pill>}
              </div>
            ))}
          </div>

          {/* Appears only when something is ticked — a CSS :has() rule, no state. */}
          <div className="hidden items-center gap-3 border-t border-line bg-faint px-5 py-2.5 group-has-[input:checked]:flex">
            <button className={button}>Add selected to suppression</button>
            <span className="text-muted">Permanent. They can never be emailed again.</span>
          </div>
        </form>
      )}

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
          <div className="space-y-5">
            <dl className="grid grid-cols-[7rem_1fr] gap-y-1.5">
              {(
                [
                  ['Email', selected.email],
                  ['Company', selected.company],
                  ['Title', selected.title],
                  ['LinkedIn', selected.linkedinUrl],
                  ['Source', selected.source],
                  ['Added', fmt(selected.createdAt)],
                  ['Erased', selected.erasedAt ? fmt(selected.erasedAt) : null],
                ] as const
              ).map(([label, value]) => (
                <Row key={label} label={label} value={value} />
              ))}
            </dl>

            {!selected.erasedAt && (
              <form action={saveStatus} className="space-y-2 rounded-xl border border-line p-3">
                <input type="hidden" name="id" value={selected.id} />
                <p className="font-medium">Sending eligibility</p>
                <p className="text-muted">
                  Only verified and catch-all can ever be sent to, and catch-all only from a
                  mailbox flagged for it.
                </p>
                <div className="flex gap-2">
                  <select
                    name="email_status"
                    defaultValue={selected.emailStatus}
                    className={`${field} capitalize`}
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
                    className={`${field} capitalize`}
                  >
                    {consentStatus.enumValues.map((value) => (
                      <option key={value} value={value}>
                        {value.replace('_', ' ')}
                      </option>
                    ))}
                  </select>
                </div>
                <button className={`${button} w-full`}>Save</button>
              </form>
            )}

            <div>
              <p className="mb-1 font-medium">Context</p>
              <p className="mb-1.5 text-muted">
                Everything the CSV carried beyond the fields above. Personalisation may use only
                what is in here.
              </p>
              <pre className="max-h-56 overflow-auto rounded-xl border border-line bg-faint p-3 text-[12px]">
                {JSON.stringify(selected.context, null, 2)}
              </pre>
            </div>

            <div className="flex flex-wrap gap-2 border-t border-line pt-4">
              {selected.email && (
                <form action={suppressEmail}>
                  <input type="hidden" name="email" value={selected.email} />
                  <button className={ghost}>Add to suppression</button>
                </form>
              )}
              {!selected.erasedAt && (
                <form action={erase}>
                  <input type="hidden" name="id" value={selected.id} />
                  <button className="rounded-lg border border-rose-200 px-3 py-1.5 font-medium text-rose-700 hover:bg-rose-50">
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

function Row({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className="break-words">{value || '—'}</dd>
    </>
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
