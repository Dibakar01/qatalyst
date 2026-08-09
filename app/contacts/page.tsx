import { and, desc, eq, ilike, or, type SQL } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { db } from '@/db'
import { consentStatus, contacts, emailStatus } from '@/db/schema'
import { requireAuth } from '@/lib/auth'
import { suppress } from '@/lib/suppression'

const LIMIT = 200
const COLS = 'grid grid-cols-[1.2fr_1.2fr_1.6fr_7rem_5rem] gap-2 px-2 py-1'

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? ''

async function addSuppression(formData: FormData) {
  'use server'
  await requireAuth()
  const email = String(formData.get('email') ?? '')
  if (email) await suppress(email, 'manual')
  revalidatePath('/contacts')
}

/**
 * DPDP erasure: personal fields go, `erased_at` is stamped, the suppression hash
 * stays. Suppressing first is deliberate — once the address is gone we could
 * never honour a future request for it, and a re-import would resurrect them.
 */
async function erase(formData: FormData) {
  'use server'
  await requireAuth()
  const id = String(formData.get('id') ?? '')
  const [row] = await db.select({ email: contacts.email }).from(contacts).where(eq(contacts.id, id))
  if (!row) return
  if (row.email) await suppress(row.email, 'manual')
  await db
    .update(contacts)
    .set({
      firstName: null,
      lastName: null,
      email: null,
      company: null,
      title: null,
      linkedinUrl: null,
      context: {},
      erasedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(contacts.id, id))
  revalidatePath('/contacts')
}

export default async function ContactsPage({ searchParams }: PageProps<'/contacts'>) {
  await requireAuth()
  const sp = await searchParams
  const q = one(sp.q).trim()
  const status = one(sp.status)
  const consent = one(sp.consent)

  const filters: (SQL | undefined)[] = [
    q
      ? or(
          ilike(contacts.firstName, `%${q}%`),
          ilike(contacts.lastName, `%${q}%`),
          ilike(contacts.company, `%${q}%`),
          ilike(contacts.email, `%${q}%`),
        )
      : undefined,
    emailStatus.enumValues.includes(status as never)
      ? eq(contacts.emailStatus, status as never)
      : undefined,
    consentStatus.enumValues.includes(consent as never)
      ? eq(contacts.consentStatus, consent as never)
      : undefined,
  ]

  const rows = await db
    .select()
    .from(contacts)
    .where(and(...filters))
    .orderBy(desc(contacts.createdAt))
    .limit(LIMIT)

  return (
    <div className="space-y-3">
      <form method="get" className="flex flex-wrap items-center gap-2">
        <input
          name="q"
          defaultValue={q}
          placeholder="name, company, email"
          className="w-64 border border-neutral-400 px-2 py-1"
        />
        <select name="status" defaultValue={status} className="border border-neutral-400 px-1 py-1">
          <option value="">any email status</option>
          {emailStatus.enumValues.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
        <select
          name="consent"
          defaultValue={consent}
          className="border border-neutral-400 px-1 py-1"
        >
          <option value="">any consent</option>
          {consentStatus.enumValues.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
        <button className="border border-neutral-400 bg-neutral-100 px-3 py-1">Search</button>
        <span className="text-neutral-600">
          {rows.length}
          {rows.length === LIMIT ? '+' : ''} shown
        </span>
      </form>

      <div className="border border-neutral-300">
        <div className={`${COLS} border-b border-neutral-300 bg-neutral-100 font-medium`}>
          <span>Name</span>
          <span>Company</span>
          <span>Email</span>
          <span>Email status</span>
          <span>Consent</span>
        </div>
        {rows.map((c) => (
          <details key={c.id} className="border-b border-neutral-200 last:border-b-0">
            <summary className={`${COLS} cursor-pointer hover:bg-neutral-50`}>
              <span>
                {[c.firstName, c.lastName].filter(Boolean).join(' ') ||
                  (c.erasedAt ? <em className="text-neutral-500">erased</em> : '—')}
              </span>
              <span>{c.company ?? '—'}</span>
              <span className="truncate">{c.email ?? '—'}</span>
              <span>{c.emailStatus}</span>
              <span>{c.consentStatus}</span>
            </summary>
            <div className="space-y-2 bg-neutral-50 px-4 py-2">
              <dl className="grid grid-cols-[9rem_1fr] gap-x-2">
                <dt>title</dt>
                <dd>{c.title ?? '—'}</dd>
                <dt>linkedin_url</dt>
                <dd className="break-all">{c.linkedinUrl ?? '—'}</dd>
                <dt>source</dt>
                <dd>{c.source ?? '—'}</dd>
                <dt>created</dt>
                <dd>{c.createdAt.toISOString()}</dd>
                <dt>erased_at</dt>
                <dd>{c.erasedAt?.toISOString() ?? '—'}</dd>
              </dl>
              <div>
                <div className="text-neutral-600">context</div>
                <pre className="overflow-x-auto bg-white p-2">
                  {JSON.stringify(c.context, null, 2)}
                </pre>
              </div>
              <div className="flex gap-2">
                {c.email && (
                  <form action={addSuppression}>
                    <input type="hidden" name="email" value={c.email} />
                    <button className="border border-neutral-400 bg-white px-2 py-1">
                      Add to suppression
                    </button>
                  </form>
                )}
                {!c.erasedAt && (
                  <form action={erase}>
                    <input type="hidden" name="id" value={c.id} />
                    <button className="border border-red-400 bg-white px-2 py-1 text-red-700">
                      Erase
                    </button>
                  </form>
                )}
              </div>
            </div>
          </details>
        ))}
        {rows.length === 0 && <p className="px-2 py-3 text-neutral-600">No contacts.</p>}
      </div>
    </div>
  )
}
