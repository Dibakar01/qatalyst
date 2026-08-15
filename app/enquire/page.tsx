import { eq } from 'drizzle-orm'
import Image from 'next/image'
import { redirect } from 'next/navigation'
import { db } from '@/db'
import { contacts } from '@/db/schema'
import { recordEnquiry } from '@/lib/funnel'
import { readLink } from '@/lib/token'

/**
 * The far end of the funnel, and the only page here a stranger ever sees.
 *
 * Public: no session, no contact list, nothing but this form. It is the same
 * room as the app — same red, same type — because someone arriving from one of
 * our emails should recognise where they have landed.
 */
export const dynamic = 'force-dynamic'

export default async function Enquire({ searchParams }: PageProps<'/enquire'>) {
  const sp = await searchParams
  const token = typeof sp.t === 'string' ? sp.t : ''
  const done = sp.sent === '1'
  const trace = token ? readLink(token) : null

  // Prefilled only when they arrived through their own link, and only with
  // what we already had about them.
  const [known] = trace
    ? await db.select().from(contacts).where(eq(contacts.id, trace.contactId)).limit(1)
    : []

  async function submit(formData: FormData) {
    'use server'
    const text = (name: string) => String(formData.get(name) ?? '').trim()
    const carried = String(formData.get('t') ?? '')

    await recordEnquiry({
      email: text('email'),
      name: text('name'),
      company: text('company'),
      body: text('body'),
      trace: carried ? readLink(carried) : null,
    })

    redirect(`/enquire?sent=1${carried ? `&t=${encodeURIComponent(carried)}` : ''}`)
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center gap-6 px-6 py-16">
      <div className="flex items-center gap-3">
        <Image src="/mark.png" alt="" width={28} height={28} priority className="rounded-[4px]" />
        <span className="font-semibold tracking-[-0.04em]">qatalyst</span>
      </div>

      {done ? (
        <div className="flex flex-col gap-3">
          <h1 className="text-display font-semibold tracking-[-0.03em]">Thank you — that reached us.</h1>
          <p className="text-dim">
            Someone will write back personally. If you would rather we did not,
            reply to the email you received and we will stop.
          </p>
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-3">
            <h1 className="text-display font-semibold tracking-[-0.03em]">
              {known?.firstName ? `Hello ${known.firstName} — tell us more` : 'Tell us more'}
            </h1>
            <p className="text-dim">
              A few lines is plenty. It comes straight to a person, not a queue.
            </p>
          </div>

          <form action={submit} className="flex flex-col gap-5">
            <input type="hidden" name="t" value={token} />

            <div className="grid gap-5 sm:grid-cols-2">
              <label className="flex flex-col gap-2">
                <span className="text-micro font-semibold uppercase tracking-[0.16em] text-dim">Name</span>
                <input
                  name="name"
                  defaultValue={[known?.firstName, known?.lastName].filter(Boolean).join(' ')}
                  className="w-full rounded-[5px] border border-line bg-raise px-3 py-2 transition-colors focus:border-primary"
                />
              </label>
              <label className="flex flex-col gap-2">
                <span className="text-micro font-semibold uppercase tracking-[0.16em] text-dim">Company</span>
                <input
                  name="company"
                  defaultValue={known?.company ?? ''}
                  className="w-full rounded-[5px] border border-line bg-raise px-3 py-2 transition-colors focus:border-primary"
                />
              </label>
            </div>

            <label className="flex flex-col gap-2">
              <span className="text-micro font-semibold uppercase tracking-[0.16em] text-dim">Email</span>
              <input
                name="email"
                type="email"
                required
                defaultValue={known?.email ?? ''}
                className="w-full rounded-[5px] border border-line bg-raise px-3 py-2 transition-colors focus:border-primary"
              />
            </label>

            <label className="flex flex-col gap-2">
              <span className="text-micro font-semibold uppercase tracking-[0.16em] text-dim">
                What would be useful?
              </span>
              <textarea
                name="body"
                rows={5}
                className="w-full resize-none rounded-[5px] border border-line bg-raise px-3 py-2 leading-[1.7] transition-colors focus:border-primary"
              />
            </label>

            <button className="inline-flex items-center justify-center self-start rounded-[5px] bg-primary px-3 py-2 font-medium text-secondary transition-[filter] hover:brightness-110">
              Send it
            </button>
          </form>
        </>
      )}
    </main>
  )
}
