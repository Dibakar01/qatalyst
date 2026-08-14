import { desc } from 'drizzle-orm'
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
import { shouldHalt } from '@/lib/rules'
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
import { CommandBar, ClearFilters, Filter, Meter, Search, type Box } from './console'
import Importer from './importer'
import Letter from '../letter'
import {
  Clause,
  Drawer,
  Empty,
  field,
  go,
  ink,
  Label,
  Ledger,
  quiet,
  ruled,
  Sheet,
  Stamp,
  stop,
} from './ui'

/**
 * One desk, one object on it.
 *
 * The letter is always there — a real one, in three dimensions, that you can
 * pick up and turn over. How far it is open is how far the work has actually
 * got, so the state of the run is the first thing you see and you do not have
 * to read a number to know it.
 *
 * Everything else is machinery around that object: the card on the left holds
 * the letters and the instruments, working panels are set down to the right
 * when you need one, and a command line runs along the bottom. Nothing
 * navigates away — `?c=` opens a letter, `?view=` sets down a panel, and the
 * search params are the only state this desk has.
 */

const BOOK_VIEWS = new Set(['book', 'boxes', 'returned'])
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? ''
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

  const sum = (pick: (r: (typeof rows)[number]) => number) => rows.reduce((t, r) => t + pick(r), 0)
  const drafts = sum((r) => r.drafts)
  const flagged = sum((r) => r.flagged)
  const approved = sum((r) => r.approved)
  const sent = sum((r) => r.sent)
  const written = drafts + flagged + approved + sent
  const halted = boxes.filter((box) => box.halted)
  const open = openId ? rows.find((r) => r.campaign.id === openId) : undefined

  // What the object shows. Signing lifts the flap; posting draws the sheet out.
  // Bound to the open letter when there is one, otherwise to all of them.
  const shown = open ?? { drafts, flagged, approved, sent }
  const total = shown.drafts + shown.flagged + shown.approved + shown.sent
  const progress = total > 0 ? (shown.approved * 0.35 + shown.sent) / total : 0

  const hasPanel = Boolean(openId) || BOOK_VIEWS.has(view)

  return (
    <>
      <div className="relative flex min-h-0 flex-1 gap-4 p-4">
        {/* ── the card: the letters, and how the machine is running ──────── */}
        <aside className="panel hidden w-[298px] shrink-0 flex-col overflow-hidden rounded-[10px] xl:flex">
          <div className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-3">
            <Label>Letters</Label>
            <form action={newCampaign} className="ml-auto flex items-center gap-1.5">
              <label className="block">
                <span className="sr-only">Name a new letter</span>
                <input name="name" placeholder="New letter" className={`${ruled} w-24 py-1`} />
              </label>
              <button className="text-primary transition-opacity hover:opacity-70" aria-label="Start it">
                +
              </button>
            </form>
          </div>

          <nav className="max-h-[34%] shrink-0 overflow-auto border-b border-line py-1.5">
            {rows.length === 0 ? (
              <p className="px-4 py-2 text-dim">Nothing written yet.</p>
            ) : (
              rows.map(({ campaign, drafts: d, flagged: f, approved: a, sent: s }) => (
                <Link
                  key={campaign.id}
                  href={`/?c=${campaign.id}`}
                  aria-current={campaign.id === openId ? 'page' : undefined}
                  className={`flex items-center gap-2 px-4 py-1.5 transition-colors ${
                    campaign.id === openId ? 'bg-raise text-ink' : 'text-dim hover:bg-raise hover:text-ink'
                  }`}
                >
                  <span className="min-w-0 flex-1 truncate">{campaign.name}</span>
                  {f > 0 && <Stamp tone="flagged">{`${f}`}</Stamp>}
                  <span className="shrink-0 text-[11px] tabular-nums opacity-70">
                    {d + f > 0 ? `${d + f} to read` : a > 0 ? `${a} signed` : s > 0 ? `${s} out` : '—'}
                  </span>
                </Link>
              ))
            )}
          </nav>

          <div className="min-h-0 flex-1 space-y-6 overflow-auto p-4">
            {/* What needs a person. First, because it is the only part of the
                system that cannot move without you. Gone when there is nothing
                to say, so its presence is the whole signal. */}
            {(flagged > 0 || halted.length > 0) && (
              <section className="space-y-2">
                {halted.map((box) => (
                  <p
                    key={box.id}
                    className="rounded-[5px] border border-primary/35 bg-primary/[0.06] px-3 py-2.5"
                  >
                    <strong className="font-medium text-primary">{box.email} halted itself</strong>{' '}
                    — {(box.bounceRate * 100).toFixed(1)}% came back, over the 3% threshold. Its
                    letters were held.
                  </p>
                ))}
                {flagged > 0 && (
                  <p className="rounded-[5px] border border-primary/35 bg-primary/[0.06] px-3 py-2.5">
                    <strong className="font-medium text-primary">
                      {flagged} {flagged === 1 ? 'draft is' : 'drafts are'} marked for you
                    </strong>{' '}
                    — a reader flagged them. They can never be signed in bulk.
                  </p>
                )}
              </section>
            )}

            <section>
              <Label>Written so far</Label>
              {written === 0 ? (
                <p className="mt-2 text-dim">
                  Nothing drafted. {contacts.sendable.toLocaleString()} of{' '}
                  {contacts.total.toLocaleString()} addresses can be written to at all.
                </p>
              ) : (
                <>
                  <div className="mt-2.5 flex h-1.5 overflow-hidden rounded-full bg-raise">
                    {(
                      [
                        ['drafts', drafts, 'bg-dim/40'],
                        ['marked', flagged, 'bg-primary'],
                        ['signed', approved, 'bg-ink/45'],
                        ['posted', sent, 'bg-ink'],
                      ] as const
                    ).map(([label, value, tone]) =>
                      value > 0 ? (
                        <div
                          key={label}
                          className={tone}
                          style={{ flexGrow: value }}
                          title={`${value} ${label}`}
                        />
                      ) : null,
                    )}
                  </div>
                  <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2.5">
                    {(
                      [
                        ['To read', drafts + flagged],
                        ['Marked', flagged],
                        ['Signed', approved],
                        ['Posted', sent],
                      ] as const
                    ).map(([label, value]) => (
                      <div key={label}>
                        <dd className="text-[20px] font-medium leading-none tracking-[-0.03em]">
                          {value.toLocaleString()}
                        </dd>
                        <dt className="mt-1 text-dim">{label}</dt>
                      </div>
                    ))}
                  </dl>
                </>
              )}
            </section>

            <section>
              <Label>Today&rsquo;s postage</Label>
              <div className="mt-2.5">
                {boxes.length === 0 ? (
                  <p className="text-dim">
                    No post boxes — <code>npm run db:seed</code> adds the first two.
                  </p>
                ) : (
                  <Meter boxes={boxes} />
                )}
              </div>
            </section>
          </div>

          <div className="shrink-0 border-t border-line">
            <div className="flex divide-x divide-line border-b border-line">
              {[
                ['/?view=book', 'Address book', view === 'book'],
                ['/?view=boxes', 'Post boxes', view === 'boxes'],
                ['/?view=returned', 'Returned', view === 'returned'],
              ].map(([href, label, on]) => (
                <Link
                  key={href as string}
                  href={href as string}
                  className={`flex-1 truncate px-2 py-2.5 text-center transition-colors ${
                    on ? 'bg-raise text-ink' : 'text-dim hover:bg-raise hover:text-ink'
                  }`}
                >
                  {label as string}
                </Link>
              ))}
            </div>
            <p className="flex items-center gap-2 px-4 py-2.5 text-dim">
              <span
                className={`size-1.5 rounded-full ${isConfigured() ? 'bg-primary' : 'bg-dim'}`}
                aria-hidden
              />
              {isConfigured() ? 'Gmail live — letters really go' : 'Dry run — nothing really goes'}
            </p>
          </div>
        </aside>

        {/* ── the letter ─────────────────────────────────────────────────────
            The one object on the stage. Never unmounted, so however you have
            turned it stays turned while panels come and go beside it. */}
        <div className={`relative min-w-0 flex-1 ${hasPanel ? 'hidden 2xl:block' : 'hidden md:block'}`}>
          <Letter progress={progress} />
          <p className="pointer-events-none absolute inset-x-0 bottom-2 text-center text-dim">
            {open ? open.campaign.name : 'Drag to turn it over'}
          </p>
        </div>

        {/* ── the working panel ──────────────────────────────────────────── */}
        {hasPanel && (
          <ViewTransition enter="screen" exit="screen" default="none">
            <div className="flex min-h-0 w-full flex-col md:max-w-[720px]">
              {openId ? (
                <LetterSheet id={openId} />
              ) : view === 'book' ? (
                <BookSheet sp={sp} />
              ) : view === 'boxes' ? (
                <BoxesSheet boxes={boxes} />
              ) : (
                <ReturnedSheet />
              )}
            </div>
          </ViewTransition>
        )}
      </div>

      <CommandBar campaignId={open?.campaign.id} campaignName={open?.campaign.name} />

      {BOOK_VIEWS.has(view) && <BookDrawers sp={sp} />}
    </>
  )
}

/* ── one letter, from writing it to posting it ────────────────────────────── */

const WHY: Record<string, string> = {
  ungrounded: 'mentions something we have no record of for this person',
  thin: 'says nothing beyond their name, title and company',
}

async function LetterSheet({ id }: { id: string }) {
  const campaign = await getCampaign(id)
  if (!campaign)
    return (
      <Sheet label="Letter" title="Not on the desk">
        <Empty title="No such letter" note="It may have been thrown away." />
      </Sheet>
    )

  const [tally, audience, queue, posted, boxRows] = await Promise.all([
    counts(id),
    audienceSize(id),
    reviewQueue(id),
    sentMessages(id, 10),
    db.select().from(mailboxes),
  ])

  const active = boxRows.filter((box) => box.active)
  const capacity = active.reduce((total, box) => total + box.dailyCap, 0)
  const hasSlot = campaign.bodyTemplate.includes(`{{${SLOT}}}`)

  return (
    <Sheet
      label="Letter"
      title={
        <span className="flex items-baseline gap-3">
          <Link href="/" aria-label="Put it down" className="text-dim hover:text-primary">
            ←
          </Link>
          <span className="truncate">{campaign.name}</span>
          <Stamp tone={campaign.status}>{campaign.status}</Stamp>
        </span>
      }
      note="write · sign · post · hold all work on this letter from the line below."
    >
      <div className="min-h-0 flex-1 overflow-auto">
        <Clause n={1} title="The message">
          <form action={saveCampaignAction} className="space-y-5">
            <input type="hidden" name="id" value={campaign.id} />

            <div className="grid gap-4 sm:grid-cols-2">
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

            <label className="block">
              <Label>The body — {`{{${SLOT}}}`} is the one line the model writes</Label>
              <textarea
                name="body_template"
                rows={10}
                defaultValue={campaign.bodyTemplate}
                spellCheck={false}
                className="mt-1.5 w-full resize-y rounded-[4px] border border-line bg-raise px-4 py-3.5 leading-[1.7] transition-colors focus:border-primary"
              />
            </label>

            {!hasSlot && (
              <p className="text-primary">
                The body has no {`{{${SLOT}}}`}, so there is nothing for the model to write.
              </p>
            )}

            <label className="block">
              <Label>What should that one line say?</Label>
              <textarea
                name="prompt"
                rows={3}
                defaultValue={campaign.prompt}
                className={`${field} mt-1.5`}
              />
              <span className="mt-1 block text-dim">
                The model sees only this and the person&rsquo;s own fields — nothing else.
              </span>
            </label>

            <p className="text-dim">
              Other variables: {`{{first_name}} {{last_name}} {{company}} {{title}}`} and{' '}
              {`{{context.Any CSV column}}`}. The opt-out sentence and unsubscribe link are added
              automatically — you cannot remove them.
            </p>
            <button className={ink}>Save the message</button>
          </form>
        </Clause>

        <Clause
          n={2}
          title="The round"
          note={`${audience} ${audience === 1 ? 'address' : 'addresses'} not yet written to`}
        >
          {audience === 0 ? (
            <p className="text-dim">
              Nobody is eligible. An address must be verified or catch-all — set that in the{' '}
              <Link href="/?view=book" className="underline underline-offset-4">
                address book
              </Link>{' '}
              or map it on import.
            </p>
          ) : (
            <form action={generateAction} className="flex flex-wrap items-center gap-3">
              <input type="hidden" name="id" value={campaign.id} />
              <button className={go} disabled={!hasSlot}>
                Draft the next {Math.min(audience, 25)}
              </button>
              <span className="text-dim">
                One short generation each, then both readers check it. About half a minute.
              </span>
            </form>
          )}
        </Clause>

        <Clause
          n={3}
          title="The reading"
          note={
            tally.drafts + tally.flagged === 0
              ? 'nothing waiting'
              : `${tally.drafts + tally.flagged} waiting · ${tally.flagged} marked`
          }
        >
          {queue.length === 0 ? (
            <p className="text-dim">
              {tally.approved > 0
                ? `${tally.approved} signed and ready to post.`
                : 'Draft something first.'}
            </p>
          ) : (
            <div className="space-y-5">
              {tally.drafts > 0 && (
                <form action={approveAllClean} className="flex flex-wrap items-center gap-3">
                  <input type="hidden" name="id" value={campaign.id} />
                  <button className={quiet}>Sign the {tally.drafts} that passed both readers</button>
                  <span className="text-dim">Marked ones are never signed in bulk.</span>
                </form>
              )}

              {queue.map(({ message, contact }) => (
                <article key={message.id} className="overflow-hidden rounded-[5px] border border-line">
                  <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 border-b border-line bg-raise px-4 py-2.5">
                    <span className="font-medium">
                      {[contact.firstName, contact.lastName].filter(Boolean).join(' ') || 'Unnamed'}
                    </span>
                    <span className="text-dim">{contact.email}</span>
                    {contact.company && <span className="text-dim">· {contact.company}</span>}
                    <span className="ml-auto flex gap-1.5">
                      {message.validatorFlags.map((flag) => (
                        <Stamp key={flag} tone="flagged">
                          {flag}
                        </Stamp>
                      ))}
                    </span>
                  </div>

                  {message.validatorFlags.length > 0 && (
                    <ul className="border-b border-line bg-primary/[0.06] px-4 py-2.5 text-primary">
                      {message.validatorFlags.map((flag) => (
                        <li key={flag}>
                          <strong className="font-medium">{flag}</strong> — {WHY[flag] ?? flag}
                        </li>
                      ))}
                    </ul>
                  )}

                  {message.error ? (
                    <p className="px-4 py-3 text-primary">{message.error}</p>
                  ) : (
                    <>
                      <p className="border-b border-line px-4 py-2.5">
                        <span className="text-dim">Subject </span>
                        {message.subject}
                      </p>
                      {/* The only thing on this desk a real person will ever
                          read. Everything else defers to it. */}
                      <pre className="whitespace-pre-wrap px-4 py-4 font-sans text-[13.5px] leading-[1.7]">
                        {message.body}
                      </pre>
                    </>
                  )}

                  <div className="flex gap-2 border-t border-line px-4 py-3">
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
                  </div>
                </article>
              ))}
            </div>
          )}
        </Clause>

        <Clause n={4} title="The post" note={`${tally.approved} signed · ${tally.sent} posted`}>
          <div className="space-y-4">
            <p className="text-dim">
              {active.length} active post {active.length === 1 ? 'box' : 'boxes'}, up to {capacity} a
              day between them, spread across 09:00–17:00. Catch-all addresses go only from a box
              flagged for them, capped at 10 a day. If a box bounces above 3% this letter stops on
              its own.
            </p>

            {campaign.status === 'sending' ? (
              <form action={pauseSending} className="flex flex-wrap items-center gap-3">
                <input type="hidden" name="id" value={campaign.id} />
                <button className={quiet}>Hold the post</button>
                <span className="text-dim">
                  <code>collect</code> works one collection by hand; <code>npm run send</code> works
                  them on a timer.
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
              <div>
                <Label>Postmarks</Label>
                <ul className="mt-2 space-y-1 text-[11.5px] tabular-nums text-dim">
                  {posted.map(({ message, contact }) => (
                    <li key={message.id} className="truncate">
                      {message.sentAt?.toISOString().slice(0, 16).replace('T', ' ')} → {contact.email}{' '}
                      {message.messageIdHeader}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </Clause>
      </div>
    </Sheet>
  )
}

/* ── the address book ─────────────────────────────────────────────────────── */

const LIMIT = 100

const bookHref = (sp: Params, patch: Record<string, string | undefined>) => {
  const next = new URLSearchParams({ view: 'book' })
  const base = { q: one(sp.q), status: one(sp.status), consent: one(sp.consent) }
  for (const [key, value] of Object.entries({ ...base, ...patch })) if (value) next.set(key, value)
  return `/?${next.toString()}`
}

async function BookSheet({ sp }: { sp: Params }) {
  const q = one(sp.q).trim()
  const status = one(sp.status)
  const consent = one(sp.consent)
  const list = await listContacts({ q, status, consent, size: LIMIT })
  const filtered = Boolean(q || status || consent)
  const query = new URLSearchParams({
    ...(q && { q }),
    ...(status && { status }),
    ...(consent && { consent }),
  })

  return (
    <Sheet
      label="Address book"
      title="Everyone we may write to"
      note={
        <>
          {list.total.toLocaleString()} {filtered ? 'matching' : 'on the list'}
          {list.total > LIMIT && ` — showing the first ${LIMIT}`}
        </>
      }
      actions={
        <>
          <a href={`/api/export?${query}`} className={quiet}>
            Export
          </a>
          <Link href={bookHref(sp, { panel: 'import' })} className={go}>
            Take in a CSV
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
                className="flex items-center gap-3 border-b border-line px-7 py-2.5 transition-colors hover:bg-raise"
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
          <div className="hidden shrink-0 items-center gap-3 border-t border-line bg-raise px-7 py-3 group-has-[input:checked]:flex">
            <button className={ink}>Return the selected</button>
            <span className="text-dim">Permanent. They can never be written to again.</span>
          </div>
        </form>
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
              <p className="mb-2 mt-1 text-dim">
                Everything beyond the fields above. Personalisation may use only what is in here.
              </p>
              <pre className="max-h-56 overflow-auto rounded-[4px] border border-line bg-raise p-3 text-[11.5px]">
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
    >
      <Ledger>
        {boxes.map((box) => (
          <div key={box.id} className="flex items-center gap-3 border-b border-line px-7 py-3.5">
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
          <Empty
            title="No post boxes"
            note={<code>npm run db:seed adds the first two.</code>}
          />
        )}
        <p className="px-7 py-6 text-dim">
          Before any of this goes for real: SPF, DKIM and DMARC on the sending domain, then a two to
          three week warm-up from about five a day up to the cap.
        </p>
      </Ledger>
    </Sheet>
  )
}

async function ReturnedSheet() {
  const blocks = await db
    .select()
    .from(suppressions)
    .orderBy(desc(suppressions.createdAt))
    .limit(200)

  return (
    <Sheet
      label="Returned"
      title="Never write to these"
      note={`${blocks.length} entries, stored as a hash — a person can be erased and still never be written to. There is no way to remove one.`}
      actions={
        <form action={blockDomain} className="flex items-end gap-2">
          <label className="block">
            <span className="sr-only">Domain to block</span>
            <input name="domain" placeholder="competitor.com" className={`${ruled} w-40`} />
          </label>
          <select name="reason" defaultValue="competitor" className={`${ruled} w-24`}>
            <option value="competitor">Competitor</option>
            <option value="customer">Customer</option>
            <option value="manual">Other</option>
          </select>
          <button className={ink}>Block</button>
        </form>
      }
    >
      <Ledger>
        {blocks.map((row) => (
          <div key={row.id} className="flex items-center gap-3 border-b border-line px-7 py-2.5">
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
