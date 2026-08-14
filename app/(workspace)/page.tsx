import { count, desc } from 'drizzle-orm'
import Link from 'next/link'
import { ViewTransition } from 'react'
import { db } from '@/db'
import { consentStatus, emailStatus, mailboxes, suppressions } from '@/db/schema'
import {
  audienceSize,
  counts,
  getCampaign,
  listCampaigns,
  reviewQueue,
  sentMessages,
} from '@/lib/campaigns'
import { contactStats, getContact, listContacts } from '@/lib/contacts'
import { isConfigured } from '@/lib/gmail'
import { nextAction, shouldHalt } from '@/lib/rules'
import { mailboxStats } from '@/lib/send'
import { SLOT } from '@/lib/template'
import {
  approve,
  approveAllClean,
  blockDomain,
  erase,
  generateAction,
  newCampaign,
  pauseSending,
  reject,
  saveCampaignAction,
  saveStatus,
  startSending,
  suppressEmail,
  suppressSelected,
} from './actions'
import { CommandBar, ClearFilters, Filter, Postage, Search, Valve, type Box } from './console'
import Importer from './importer'
import Letter, { type Card } from '../letter'
import {
  Drawer,
  Empty,
  field,
  go,
  ink,
  Label,
  Ledger,
  Pager,
  quiet,
  ROWS,
  ruled,
  Sheet,
  Stamp,
  Stepper,
  stop,
} from './ui'

/**
 * One desk, and the letters are the whole of it.
 *
 * There is no navigation and no sidebar. The letters stand on the stage; the
 * mark on the front one says what it needs and takes you there; the strip along
 * the top is both the readout and the way to everything that is not a letter.
 * Working surfaces are set down over the stage and taken away again.
 *
 * Nothing scrolls. Lists are paged, the campaign is four steps, and the reading
 * is one message at a time — which is how you would actually sign a stack of
 * letters, and happens to be the only shape that fits.
 *
 * The search params are the only state: `?c=` unfolds a letter, `?step=` picks
 * its clause, `?m=` picks the message under the pen, `?view=` sets down a
 * panel, `?page=`/`?q=` walk a list.
 */

const BOOK_VIEWS = new Set(['book', 'boxes', 'returned'])
const STEPS = ['Message', 'Round', 'Reading', 'Post'] as const
/** Where the mark sends you: the step that has the button for what it asked. */
const STEP_FOR = { draft: 2, read: 3, post: 4, hold: 4, none: 1 } as const

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? ''
const num = (v: string | string[] | undefined, fallback = 1) => {
  const n = Number(one(v))
  return Number.isInteger(n) && n > 0 ? n : fallback
}
type Params = Record<string, string | string[] | undefined>

export default async function Desk({ searchParams }: PageProps<'/'>) {
  const sp = await searchParams
  const view = one(sp.view)
  const openId = one(sp.c)

  const [rows, contacts, boxRows] = await Promise.all([
    listCampaigns(),
    contactStats(),
    db.select().from(mailboxes).orderBy(mailboxes.email),
  ])

  // ponytail: one count per letter. A handful of cheap counts beats deriving
  // the audience from the global total, which drifts the moment anyone is
  // erased or suppressed — and this number decides what the mark offers to do.
  const audiences = await Promise.all(rows.map((r) => audienceSize(r.campaign.id)))

  const boxes: Box[] = await Promise.all(
    boxRows.map(async (box) => {
      const stats = await mailboxStats(box.id)
      const attempts = stats.sentEver + stats.bouncedEver
      return {
        id: box.id,
        email: box.email,
        cap: box.dailyCap,
        sentToday: stats.sentToday,
        sendsCatchAll: box.sendsCatchAll,
        active: box.active,
        halted: shouldHalt(stats.sentEver, stats.bouncedEver),
        bounceRate: attempts > 0 ? stats.bouncedEver / attempts : 0,
      }
    }),
  )

  const cards: Card[] = rows.map(({ campaign, drafts, flagged, approved, sent }, index) => {
    const tally = { drafts, flagged, approved, sent }
    const next = nextAction(tally, audiences[index], campaign.status)
    const written = drafts + flagged + approved + sent
    return {
      id: campaign.id,
      name: campaign.name,
      // Signing lifts the flap; posting draws the sheet out. The object is the
      // progress bar, so there does not have to be one.
      progress: written > 0 ? (approved * 0.35 + sent) / written : 0,
      mark: next.label,
      count: next.count,
      markHref: `/?c=${campaign.id}&step=${STEP_FOR[next.action]}`,
      href: `/?c=${campaign.id}`,
    }
  })

  const flagged = rows.reduce((total, r) => total + r.flagged, 0)
  const halted = boxes.filter((box) => box.halted)
  const marked = rows.find((r) => r.flagged > 0)
  const hasPanel = Boolean(openId) || BOOK_VIEWS.has(view)

  return (
    <>
      {/* ── the strip: the readout, and the way to everything that is not a
          letter. Red here always means something wants a person. ─────────── */}
      <header className="flex shrink-0 flex-wrap items-center gap-x-5 gap-y-1 border-b border-line px-5 py-2.5">
        <Link href="/?view=boxes" className="transition-colors hover:text-primary">
          <Postage boxes={boxes} />
        </Link>

        {flagged > 0 && marked ? (
          <Link
            href={`/?c=${marked.campaign.id}&step=3`}
            className="font-medium text-primary transition-opacity hover:opacity-75"
          >
            {flagged} marked for you
          </Link>
        ) : (
          <span className="text-dim">nothing marked</span>
        )}

        <Link href="/?view=book" className="text-dim transition-colors hover:text-ink">
          {contacts.total.toLocaleString()} addresses · {contacts.sendable.toLocaleString()} writable
        </Link>

        <Link href="/?view=returned" className="text-dim transition-colors hover:text-ink">
          returned
        </Link>

        <span className="ml-auto flex items-center gap-2 text-dim">
          <span
            className={`size-1.5 rounded-full ${isConfigured() ? 'bg-primary' : 'bg-dim'}`}
            aria-hidden
          />
          {isConfigured() ? 'Gmail live' : 'Dry run'}
        </span>

        {halted.length > 0 && (
          <p className="w-full text-primary">
            <strong className="font-medium">{halted[0].email} halted itself</strong> —{' '}
            {(halted[0].bounceRate * 100).toFixed(1)}% came back, over the 3% threshold. Its letters
            were held.
          </p>
        )}
      </header>

      {/* ── the stage ────────────────────────────────────────────────────── */}
      <div className="relative min-h-0 flex-1">
        <div className="absolute inset-0 px-6 pb-5 pt-2">
          {cards.length === 0 ? (
            <div className="grid size-full place-items-center text-center">
              <div className="max-w-sm">
                <p className="text-[18px] font-medium tracking-[-0.02em]">Nothing on the desk</p>
                <p className="mt-1.5 text-dim">
                  A letter is one message written once and personalised for each person on the list.
                </p>
                <form action={newCampaign} className="mt-5 flex items-end justify-center gap-2">
                  <label className="block">
                    <span className="sr-only">Name a new letter</span>
                    <input name="name" placeholder="Name it" className={`${ruled} w-44`} />
                  </label>
                  <button className={go}>Start one</button>
                </form>
              </div>
            </div>
          ) : (
            <Letter cards={cards} openId={openId || undefined} />
          )}
        </div>

        {hasPanel && (
          <ViewTransition enter="screen" exit="screen" default="none">
            <div className="absolute inset-0 z-10 flex justify-center px-6 pb-5 pt-2">
              <div className="flex min-h-0 w-full max-w-[900px] flex-col">
                {openId ? (
                  <LetterSheet id={openId} step={num(sp.step)} at={num(sp.m)} />
                ) : view === 'book' ? (
                  <BookSheet sp={sp} />
                ) : view === 'boxes' ? (
                  <BoxesSheet boxes={boxes} />
                ) : (
                  <ReturnedSheet page={num(sp.page)} />
                )}
              </div>
            </div>
          </ViewTransition>
        )}
      </div>

      <CommandBar campaignId={openId || undefined} campaignName={cards.find((c) => c.id === openId)?.name} />

      {BOOK_VIEWS.has(view) && <BookDrawers sp={sp} />}
    </>
  )
}

/* ── one letter, unfolded ─────────────────────────────────────────────────── */

const WHY: Record<string, string> = {
  ungrounded: 'mentions something we have no record of for this person',
  thin: 'says nothing beyond their name, title and company',
}

async function LetterSheet({ id, step, at }: { id: string; step: number; at: number }) {
  const campaign = await getCampaign(id)
  if (!campaign)
    return (
      <Sheet label="Letter" title="Not on the desk">
        <Empty title="No such letter" note="It may have been thrown away." />
      </Sheet>
    )

  const clause = Math.min(Math.max(step, 1), 4)
  const [tally, audience, queue, posted, boxRows] = await Promise.all([
    counts(id),
    audienceSize(id),
    clause === 3 ? reviewQueue(id) : Promise.resolve([]),
    clause === 4 ? sentMessages(id, 3) : Promise.resolve([]),
    db.select().from(mailboxes),
  ])

  const active = boxRows.filter((box) => box.active)
  const capacity = active.reduce((total, box) => total + box.dailyCap, 0)
  const hasSlot = campaign.bodyTemplate.includes(`{{${SLOT}}}`)
  const step3 = (n: number) => `/?c=${id}&step=3&m=${n}`

  return (
    <Sheet
      label="Letter"
      title={
        <span className="flex items-baseline gap-3">
          <span className="truncate">{campaign.name}</span>
          <Stamp tone={campaign.status}>{campaign.status}</Stamp>
        </span>
      }
      actions={
        <Link href="/" className={quiet} aria-label="Put it down">
          Put it down
        </Link>
      }
    >
      <div className="min-h-0 flex-1 overflow-hidden px-7 py-6">
        {clause === 1 && (
          <form action={saveCampaignAction} className="flex h-full flex-col gap-4">
            <input type="hidden" name="id" value={campaign.id} />

            <div className="grid shrink-0 gap-4 sm:grid-cols-2">
              <label className="block">
                <Label>Name</Label>
                <input name="name" defaultValue={campaign.name} className={`${ruled} mt-1`} />
              </label>
              <label className="block">
                <Label>Subject</Label>
                <input
                  name="subject_template"
                  defaultValue={campaign.subjectTemplate}
                  className={`${ruled} mt-1`}
                />
              </label>
            </div>

            <label className="flex min-h-0 flex-1 flex-col">
              <Label>The body — {`{{${SLOT}}}`} is the one line the model writes</Label>
              <textarea
                name="body_template"
                defaultValue={campaign.bodyTemplate}
                spellCheck={false}
                className="mt-1.5 min-h-0 w-full flex-1 resize-none rounded-[4px] border border-line bg-raise px-4 py-3 leading-[1.7] transition-colors focus:border-primary"
              />
            </label>

            <label className="block shrink-0">
              <Label>What should that one line say?</Label>
              <textarea
                name="prompt"
                rows={2}
                defaultValue={campaign.prompt}
                className={`${field} mt-1.5 resize-none`}
              />
            </label>

            <div className="flex shrink-0 flex-wrap items-center gap-3">
              <button className={ink}>Save the message</button>
              <span className="min-w-0 flex-1 truncate text-dim">
                {hasSlot
                  ? `{{first_name}} {{company}} {{title}} and {{context.Any CSV column}} also fill.`
                  : `No {{${SLOT}}} in the body — nothing for the model to write.`}
              </span>
            </div>
          </form>
        )}

        {clause === 2 && (
          <div className="flex h-full flex-col justify-center gap-5 text-center">
            <div>
              <p className="text-[34px] font-medium leading-none tracking-[-0.03em]">{audience}</p>
              <p className="mt-2 text-dim">
                {audience === 1 ? 'address' : 'addresses'} not yet written to
              </p>
            </div>
            {audience === 0 ? (
              <p className="mx-auto max-w-sm text-dim">
                Nobody is eligible. An address must be verified or catch-all — set that in the{' '}
                <Link href="/?view=book" className="underline underline-offset-4">
                  address book
                </Link>{' '}
                or map it on import.
              </p>
            ) : (
              <form action={generateAction} className="mx-auto max-w-sm">
                <input type="hidden" name="id" value={campaign.id} />
                <button className={go} disabled={!hasSlot}>
                  Draft the next {Math.min(audience, 25)}
                </button>
                <p className="mt-2.5 text-dim">
                  One short generation each, then both readers check it. About half a minute.
                </p>
              </form>
            )}
          </div>
        )}

        {clause === 3 && <Reading queue={queue} at={at} tally={tally} id={id} href={step3} />}

        {clause === 4 && (
          <div className="flex h-full flex-col gap-4">
            <div className="flex items-baseline gap-6">
              {(
                [
                  ['Signed', tally.approved],
                  ['Posted', tally.sent],
                ] as const
              ).map(([label, value]) => (
                <div key={label}>
                  <p className="text-[28px] font-medium leading-none tracking-[-0.03em]">{value}</p>
                  <p className="mt-1 text-dim">{label}</p>
                </div>
              ))}
              <p className="min-w-0 flex-1 text-dim">
                {active.length} active post {active.length === 1 ? 'box' : 'boxes'}, up to {capacity}{' '}
                a day between them across 09:00–17:00. Above 3% bounces this letter stops on its own.
              </p>
            </div>

            {campaign.status === 'sending' ? (
              <form action={pauseSending} className="flex flex-wrap items-center gap-3">
                <input type="hidden" name="id" value={campaign.id} />
                <button className={quiet}>Hold the post</button>
                <span className="text-dim">
                  <code>collect</code> works one collection by hand.
                </span>
              </form>
            ) : (
              <form action={startSending} className="flex flex-wrap items-center gap-3">
                <input type="hidden" name="id" value={campaign.id} />
                <button className={go} disabled={tally.approved === 0}>
                  Put it in the post
                </button>
                {tally.approved === 0 && <span className="text-dim">Nothing signed yet.</span>}
              </form>
            )}

            {posted.length > 0 && (
              <div className="min-h-0">
                <Label>Last postmarks</Label>
                <ul className="mt-2 space-y-1 text-[11.5px] tabular-nums text-dim">
                  {posted.map(({ message, contact }) => (
                    <li key={message.id} className="truncate">
                      {message.sentAt?.toISOString().slice(0, 16).replace('T', ' ')} → {contact.email}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>

      <Stepper at={clause} steps={STEPS} href={(n) => `/?c=${id}&step=${n}`} />
    </Sheet>
  )
}

/**
 * One message under the pen, never a list.
 *
 * This is how a stack of letters is actually signed — you read one, you decide,
 * the next one comes up. Approving or discarding shortens the queue, so the
 * same index lands on the next message with no cursor to keep in sync.
 */
function Reading({
  queue,
  at,
  tally,
  id,
  href,
}: {
  queue: Awaited<ReturnType<typeof reviewQueue>>
  at: number
  tally: { drafts: number; flagged: number; approved: number }
  id: string
  href: (n: number) => string
}) {
  if (queue.length === 0)
    return (
      <Empty
        title={tally.approved > 0 ? 'Nothing left to read' : 'Nothing drafted yet'}
        note={
          tally.approved > 0
            ? `${tally.approved} signed and ready to post.`
            : 'Draft some on the round before this.'
        }
      />
    )

  const index = Math.min(Math.max(at, 1), queue.length)
  const { message, contact } = queue[index - 1]

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex shrink-0 flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <span className="font-medium">
          {[contact.firstName, contact.lastName].filter(Boolean).join(' ') || 'Unnamed'}
        </span>
        <span className="text-dim">{contact.email}</span>
        {contact.company && <span className="text-dim">· {contact.company}</span>}
        <span className="ml-auto flex items-center gap-1.5">
          {message.validatorFlags.map((flag) => (
            <Stamp key={flag} tone="flagged">
              {flag}
            </Stamp>
          ))}
          <span className="ml-1 text-dim tabular-nums">
            {index} of {queue.length}
          </span>
        </span>
      </div>

      {message.validatorFlags.length > 0 && (
        <ul className="shrink-0 rounded-[4px] border border-primary/35 bg-primary/[0.06] px-4 py-2.5 text-primary">
          {message.validatorFlags.map((flag) => (
            <li key={flag}>
              <strong className="font-medium">{flag}</strong> — {WHY[flag] ?? flag}
            </li>
          ))}
        </ul>
      )}

      {message.error ? (
        <p className="text-primary">{message.error}</p>
      ) : (
        <div className="quiet-scroll min-h-0 flex-1 rounded-[4px] border border-line bg-raise px-5 py-4">
          <p className="mb-3 border-b border-line pb-2.5">
            <span className="text-dim">Subject </span>
            {message.subject}
          </p>
          {/* The only thing on this desk a real person will ever read.
              Everything else defers to it. */}
          <pre className="whitespace-pre-wrap font-sans text-[13.5px] leading-[1.75]">
            {message.body}
          </pre>
        </div>
      )}

      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <form action={approve}>
          <input type="hidden" name="id" value={message.id} />
          <button className={go} disabled={Boolean(message.error)}>
            Sign it
          </button>
        </form>
        <form action={reject}>
          <input type="hidden" name="id" value={message.id} />
          <button className={quiet}>Throw away</button>
        </form>

        {tally.drafts > 0 && (
          <form action={approveAllClean} className="ml-auto flex items-center gap-2">
            <input type="hidden" name="id" value={id} />
            <span className="text-dim">Marked ones are never signed in bulk.</span>
            <button className={quiet}>Sign the {tally.drafts} clean</button>
          </form>
        )}
      </div>

      {queue.length > 1 && (
        <div className="flex shrink-0 items-center justify-center gap-2">
          {index > 1 ? (
            <Link href={href(index - 1)} className={quiet}>
              ‹ back
            </Link>
          ) : null}
          {index < queue.length ? (
            <Link href={href(index + 1)} className={quiet}>
              skip ›
            </Link>
          ) : null}
        </div>
      )}
    </div>
  )
}

/* ── the address book ─────────────────────────────────────────────────────── */

const bookHref = (sp: Params, patch: Record<string, string | undefined>) => {
  const next = new URLSearchParams({ view: 'book' })
  const base = {
    q: one(sp.q),
    status: one(sp.status),
    consent: one(sp.consent),
    page: one(sp.page),
  }
  for (const [key, value] of Object.entries({ ...base, ...patch })) if (value) next.set(key, value)
  return `/?${next.toString()}`
}

async function BookSheet({ sp }: { sp: Params }) {
  const q = one(sp.q).trim()
  const status = one(sp.status)
  const consent = one(sp.consent)
  const list = await listContacts({ q, status, consent, page: num(sp.page), size: ROWS })
  const filtered = Boolean(q || status || consent)

  return (
    <Sheet
      label="Address book"
      title="Everyone we may write to"
      note={`${list.total.toLocaleString()} ${filtered ? 'matching' : 'on the list'}`}
      actions={
        <>
          <a
            href={`/api/export?${new URLSearchParams({ ...(q && { q }), ...(status && { status }), ...(consent && { consent }) })}`}
            className={quiet}
          >
            Export
          </a>
          <Link href={bookHref(sp, { panel: 'import' })} className={go}>
            Take in a CSV
          </Link>
          <Link href="/" className={quiet} aria-label="Close">
            ✕
          </Link>
        </>
      }
    >
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-line px-7 py-3">
        <Search />
        <Filter name="status" label="Any address status" options={emailStatus.enumValues} />
        <Filter name="consent" label="Any consent" options={consentStatus.enumValues} />
        <ClearFilters active={filtered} />
      </div>

      {list.rows.length === 0 ? (
        <Empty
          title={filtered ? 'Nothing matches' : 'The book is empty'}
          note={filtered ? 'Clear the filters to see the whole book.' : 'Take in a CSV to begin.'}
        />
      ) : (
        <form action={suppressSelected} className="group flex min-h-0 flex-1 flex-col">
          <Ledger>
            {list.rows.map((contact) => (
              <div
                key={contact.id}
                className="flex items-center gap-3 border-b border-line px-7 py-2 transition-colors hover:bg-raise"
              >
                <input
                  type="checkbox"
                  name="ids"
                  value={contact.id}
                  aria-label={`Select ${contact.email ?? contact.id}`}
                  className="size-3.5 shrink-0 accent-primary"
                />
                <Link href={bookHref(sp, { contact: contact.id })} className="flex min-w-0 flex-1 gap-3">
                  <span className="w-40 shrink-0 truncate font-medium">
                    {[contact.firstName, contact.lastName].filter(Boolean).join(' ') || (
                      <span className="italic text-dim">
                        {contact.erasedAt ? 'erased' : 'unnamed'}
                      </span>
                    )}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-dim">{contact.email ?? '—'}</span>
                </Link>
                {contact.consentStatus === 'opted_in' && <Stamp tone="opted_in">opted in</Stamp>}
                <Stamp tone={contact.emailStatus}>{contact.emailStatus}</Stamp>
              </div>
            ))}
          </Ledger>

          {/* Appears only when something is ticked — a CSS :has() rule, no state. */}
          <div className="hidden shrink-0 items-center gap-3 border-t border-line bg-raise px-7 py-2.5 group-has-[input:checked]:flex">
            <button className={ink}>Return the selected</button>
            <span className="text-dim">Permanent. They can never be written to again.</span>
          </div>
        </form>
      )}

      {list.pages > 1 && (
        <Pager
          page={list.page}
          pages={list.pages}
          href={(page) => bookHref(sp, { page: String(page) })}
        />
      )}
    </Sheet>
  )
}

const fmt = (d: Date) =>
  d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })

async function BookDrawers({ sp }: { sp: Params }) {
  const openId = one(sp.contact)
  const panel = one(sp.panel)
  const selected = openId ? await getContact(openId) : undefined
  const closed = bookHref(sp, { contact: undefined, panel: undefined })

  return (
    <>
      {panel === 'import' && (
        <Drawer title="Take in a CSV" label="Address book" closeHref={closed} wide>
          <Importer />
        </Drawer>
      )}

      {selected && (
        <Drawer
          label="Address book"
          title={[selected.firstName, selected.lastName].filter(Boolean).join(' ') || 'Unnamed'}
          closeHref={closed}
        >
          <div className="space-y-6">
            <dl className="grid grid-cols-[6.5rem_1fr] gap-y-2">
              {(
                [
                  ['Address', selected.email],
                  ['Company', selected.company],
                  ['Title', selected.title],
                  ['LinkedIn', selected.linkedinUrl],
                  ['Came from', selected.source],
                  ['Added', fmt(selected.createdAt)],
                  ['Erased', selected.erasedAt ? fmt(selected.erasedAt) : null],
                ] as const
              ).map(([label, value]) => (
                <Row key={label} label={label} value={value} />
              ))}
            </dl>

            {!selected.erasedAt && (
              <form action={saveStatus} className="space-y-2.5 rounded-[5px] border border-line p-4">
                <input type="hidden" name="id" value={selected.id} />
                <p className="font-medium">May we write to them?</p>
                <p className="text-dim">
                  Only verified and catch-all can ever be written to, and catch-all only from a post
                  box flagged for it.
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
                <button className={`${ink} w-full`}>Save</button>
              </form>
            )}

            <div>
              <Label>What the CSV carried</Label>
              <pre className="quiet-scroll mt-2 max-h-56 rounded-[4px] border border-line bg-raise p-3 text-[11.5px]">
                {JSON.stringify(selected.context, null, 2)}
              </pre>
            </div>

            <div className="flex flex-wrap gap-2 border-t border-line pt-5">
              {selected.email && (
                <form action={suppressEmail}>
                  <input type="hidden" name="email" value={selected.email} />
                  <button className={quiet}>Never write again</button>
                </form>
              )}
              {!selected.erasedAt && (
                <form action={erase}>
                  <input type="hidden" name="id" value={selected.id} />
                  <button className={stop}>Erase personal data</button>
                </form>
              )}
            </div>
            <p className="text-dim">
              Erasing clears the personal fields and keeps the returned-register hash, so they stay
              unwritable and a re-import cannot bring them back.
            </p>
          </div>
        </Drawer>
      )}
    </>
  )
}

/* ── the post boxes, and the returned register ────────────────────────────── */

function BoxesSheet({ boxes }: { boxes: Box[] }) {
  const capacity = boxes.filter((box) => box.active).reduce((total, box) => total + box.cap, 0)

  return (
    <Sheet
      label="Post boxes"
      title="Where our letters go from"
      note={`${boxes.length} configured, ${capacity} a day between them at full capacity.`}
      actions={
        <Link href="/" className={quiet} aria-label="Close">
          ✕
        </Link>
      }
    >
      <div className="min-h-0 flex-1 overflow-hidden px-7 py-5">
        <Valve boxes={boxes} />
      </div>
      <Ledger>
        {boxes.map((box) => (
          <div key={box.id} className="flex items-center gap-3 border-t border-line px-7 py-2.5">
            <span className="min-w-0 flex-1 truncate font-medium">{box.email}</span>
            {box.sendsCatchAll && <Stamp tone="catch_all">catch all · 10/day</Stamp>}
            {box.halted && <Stamp tone="halted">halted</Stamp>}
            {!box.active && <Stamp tone="paused">paused</Stamp>}
            <span className="w-24 shrink-0 text-right text-[11.5px] tabular-nums text-dim">
              {box.sentToday}/{box.cap} today
            </span>
          </div>
        ))}
        {boxes.length === 0 && (
          <Empty title="No post boxes" note={<code>npm run db:seed adds the first two.</code>} />
        )}
      </Ledger>
    </Sheet>
  )
}

async function ReturnedSheet({ page }: { page: number }) {
  const [blocks, [{ total }]] = await Promise.all([
    db
      .select()
      .from(suppressions)
      .orderBy(desc(suppressions.createdAt))
      .limit(ROWS)
      .offset((page - 1) * ROWS),
    db.select({ total: count() }).from(suppressions),
  ])
  const pages = Math.max(Math.ceil(total / ROWS), 1)

  return (
    <Sheet
      label="Returned"
      title="Never write to these"
      note="Stored as a hash, so a person can be erased and still never be written to. There is no way to remove one."
      actions={
        <>
          <form action={blockDomain} className="flex items-end gap-2">
            <label className="block">
              <span className="sr-only">Domain to block</span>
              <input name="domain" placeholder="competitor.com" className={`${ruled} w-36`} />
            </label>
            <select name="reason" defaultValue="competitor" className={`${ruled} w-24`}>
              <option value="competitor">Competitor</option>
              <option value="customer">Customer</option>
              <option value="manual">Other</option>
            </select>
            <button className={ink}>Block</button>
          </form>
          <Link href="/" className={quiet} aria-label="Close">
            ✕
          </Link>
        </>
      }
    >
      <Ledger>
        {blocks.map((row) => (
          <div key={row.id} className="flex items-center gap-3 border-b border-line px-7 py-2">
            <span className="min-w-0 flex-1 truncate">
              {row.domain ? (
                <span className="font-medium">@{row.domain}</span>
              ) : (
                <span className="text-[11.5px] text-dim">{row.emailHash?.slice(0, 32)}…</span>
              )}
            </span>
            <Stamp tone={row.reason}>{row.reason}</Stamp>
          </div>
        ))}
        {blocks.length === 0 && (
          <Empty title="Nothing returned yet" note="Nobody has been put beyond reach." />
        )}
      </Ledger>
      {pages > 1 && (
        <Pager
          page={page}
          pages={pages}
          note={`${total.toLocaleString()} entries`}
          href={(n) => `/?view=returned&page=${n}`}
        />
      )}
    </Sheet>
  )
}

function Row({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <>
      <dt className="text-[9.5px] uppercase tracking-[0.14em] text-dim">{label}</dt>
      <dd className="break-words">{value || '—'}</dd>
    </>
  )
}
