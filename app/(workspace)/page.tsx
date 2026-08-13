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
import {
  Clause,
  Drawer,
  Empty,
  field,
  go,
  ink,
  Ledger,
  quiet,
  ruled,
  Sheet,
  Stamp,
  stop,
} from './ui'

/**
 * One desk, and there is no second one.
 *
 * The app used to be four screens you walked between. It is now a desk you sit
 * at: instruments on the left, one sheet of paper in front of you, and a
 * command line along the bottom. The sheet changes; nothing else moves.
 *
 * Nothing here is a new source of truth. The tally is the message states, the
 * meter is lib/rules.ts, the box numbers are the sender's own, and every button
 * posts to a server action that already existed. The search params are the only
 * state: `?c=` opens a letter, `?view=` picks a sheet, the rest filter a list.
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
  const posting = rows.filter((r) => r.campaign.status === 'sending')
  const open = openId ? rows.find((r) => r.campaign.id === openId) : undefined

  const nav = [
    { href: '/', label: 'The desk', count: rows.length, on: !view && !openId ? true : Boolean(openId) },
    { href: '/?view=book', label: 'Address book', count: contacts.total, on: view === 'book' },
    { href: '/?view=boxes', label: 'Post boxes', count: boxes.length, on: view === 'boxes' },
    { href: '/?view=returned', label: 'Returned', count: null, on: view === 'returned' },
  ]

  return (
    <>
      <div className="flex min-h-0 flex-1 gap-5 p-5">
        {/* ── the instruments ──────────────────────────────────────────────
            Never leaves, never scrolls out from under you. Answers the four
            questions you have every morning: what needs me, what is written,
            what may go out now, and where is everything else. */}
        <aside className="card hidden w-[300px] shrink-0 flex-col overflow-hidden rounded-[12px] xl:flex">
          <nav className="shrink-0 border-b border-card-line/70 p-2.5">
            {nav.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                aria-current={item.on ? 'page' : undefined}
                className={`flex items-center gap-2 rounded-[6px] px-2.5 py-2 transition-colors ${
                  item.on
                    ? 'bg-white/[0.07] text-card-ink'
                    : 'text-card-dim hover:bg-white/[0.04] hover:text-card-ink'
                }`}
              >
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                {item.count !== null && (
                  <span className="font-mono text-[11px] opacity-70">{item.count}</span>
                )}
              </Link>
            ))}
          </nav>

          <div className="min-h-0 flex-1 space-y-6 overflow-auto p-4">
            {/* What needs a person. First, because it is the only part of the
                system that cannot move without you. Gone when there is nothing
                to say, so its presence is the signal. */}
            {(flagged > 0 || halted.length > 0) && (
              <section className="space-y-2">
                {halted.map((box) => (
                  <p
                    key={box.id}
                    className="rounded-[4px] border border-[#E8837B]/30 bg-[#E8837B]/[0.08] px-3 py-2.5 text-[#E8837B]"
                  >
                    <strong className="font-medium">{box.email} halted itself</strong> —{' '}
                    {(box.bounceRate * 100).toFixed(1)}% came back, over the 3% threshold. Its
                    letters were held. Fix the list behind it.
                  </p>
                ))}
                {flagged > 0 && (
                  <p className="rounded-[4px] border border-[#E0B45E]/30 bg-[#E0B45E]/[0.08] px-3 py-2.5 text-[#E0B45E]">
                    <strong className="font-medium">
                      {flagged} {flagged === 1 ? 'draft is' : 'drafts are'} marked for you
                    </strong>{' '}
                    — a reader flagged them. They can never be signed in bulk.
                  </p>
                )}
              </section>
            )}

            <section>
              <h2 className="mb-2.5 font-mono text-[10px] uppercase tracking-[0.18em] text-card-dim">
                Written so far
              </h2>
              {written === 0 ? (
                <p className="text-card-dim">
                  Nothing drafted yet. {contacts.sendable.toLocaleString()} of{' '}
                  {contacts.total.toLocaleString()} addresses can be written to at all.
                </p>
              ) : (
                <>
                  <div className="flex h-1.5 overflow-hidden rounded-full bg-white/[0.07]">
                    {(
                      [
                        ['drafts', drafts, 'bg-white/30'],
                        ['marked', flagged, 'bg-[#E0B45E]'],
                        ['signed', approved, 'bg-[#8F8FFF]/60'],
                        ['posted', sent, 'bg-[#8F8FFF]'],
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
                        <dd className="font-serif text-[21px] leading-none text-card-ink">
                          {value.toLocaleString()}
                        </dd>
                        <dt className="mt-1 text-card-dim">{label}</dt>
                      </div>
                    ))}
                  </dl>
                </>
              )}
            </section>

            <section>
              <h2 className="mb-2.5 font-mono text-[10px] uppercase tracking-[0.18em] text-card-dim">
                Today&rsquo;s postage
              </h2>
              {boxes.length === 0 ? (
                <p className="text-card-dim">
                  No post boxes — <code className="font-mono">npm run db:seed</code> adds the first
                  two.
                </p>
              ) : (
                <Meter boxes={boxes} />
              )}
            </section>
          </div>

          <div className="flex shrink-0 items-center gap-2 border-t border-card-line/70 px-4 py-3 text-card-dim">
            <span
              className={`size-1.5 rounded-full ${isConfigured() ? 'bg-[#8F8FFF]' : 'bg-card-dim'}`}
              aria-hidden
            />
            {isConfigured() ? 'Gmail live — letters really go' : 'Dry run — nothing really goes'}
            <span className="ml-auto font-mono text-[11px]">
              {posting.length > 0 ? `${posting.length} posting` : 'idle'}
            </span>
          </div>
        </aside>

        {/* ── the sheet ────────────────────────────────────────────────────── */}
        <ViewTransition enter="screen" exit="screen" default="none">
          <div className="mx-auto flex min-h-0 w-full max-w-[880px] flex-1 flex-col">
            {openId ? (
              <LetterSheet id={openId} />
            ) : view === 'book' ? (
              <BookSheet sp={sp} />
            ) : view === 'boxes' ? (
              <BoxesSheet boxes={boxes} />
            ) : view === 'returned' ? (
              <ReturnedSheet />
            ) : (
              <DeskSheet rows={rows} contacts={contacts} />
            )}
          </div>
        </ViewTransition>
      </div>

      <CommandBar campaignId={open?.campaign.id} campaignName={open?.campaign.name} />

      {BOOK_VIEWS.has(view) && <BookDrawers sp={sp} />}
    </>
  )
}

/* ── the desk: every letter, and what stage it is at ──────────────────────── */

function DeskSheet({
  rows,
  contacts,
}: {
  rows: Awaited<ReturnType<typeof listCampaigns>>
  contacts: Awaited<ReturnType<typeof contactStats>>
}) {
  return (
    <Sheet
      label="The desk"
      title="Letters"
      note={`${contacts.sendable.toLocaleString()} of ${contacts.total.toLocaleString()} addresses can be written to.`}
      actions={
        <form action={newCampaign} className="flex items-end gap-2">
          <label className="block">
            <span className="sr-only">New letter name</span>
            <input name="name" placeholder="Name a new letter" className={`${ruled} w-52`} />
          </label>
          <button className={go}>Start</button>
        </form>
      }
    >
      {rows.length === 0 ? (
        <Empty
          title="Nothing on the desk"
          note={
            <>
              A letter is one message written once and personalised for each person on the list.
              Name one above, or type <code className="font-mono text-ink">new autumn</code> below.
            </>
          }
        />
      ) : (
        <Ledger>
          {rows.map(({ campaign, drafts, flagged, approved, sent }) => {
            const waiting = drafts + flagged
            return (
              <Link
                key={campaign.id}
                href={`/?c=${campaign.id}`}
                className="group flex items-baseline gap-4 border-b border-rule/60 px-8 py-4 transition-colors hover:bg-ink/[0.03]"
              >
                <span className="min-w-0 flex-1 truncate font-serif text-[19px] group-hover:underline group-hover:decoration-rule group-hover:underline-offset-4">
                  {campaign.name}
                </span>
                {flagged > 0 && <Stamp tone="flagged">{`${flagged} marked`}</Stamp>}
                <Stamp tone={campaign.status}>{campaign.status}</Stamp>
                <span className="w-44 shrink-0 text-right text-dim">
                  {waiting > 0
                    ? `${waiting} to read`
                    : approved > 0
                      ? `${approved} signed, ready`
                      : sent > 0
                        ? `${sent} posted`
                        : 'nothing drafted'}
                </span>
              </Link>
            )
          })}
        </Ledger>
      )}
    </Sheet>
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
      <Sheet label="The desk" title="No such letter">
        <Empty title="Not on the desk" note="It may have been thrown away." />
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
          <Link href="/" aria-label="Back to the desk" className="text-dim hover:text-ink">
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
          <form action={saveCampaignAction} className="max-w-2xl space-y-5">
            <input type="hidden" name="id" value={campaign.id} />

            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block">
                <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-dim">
                  Name
                </span>
                <input name="name" defaultValue={campaign.name} className={`${ruled} mt-1`} />
              </label>
              <label className="block">
                <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-dim">
                  Subject
                </span>
                <input
                  name="subject_template"
                  defaultValue={campaign.subjectTemplate}
                  className={`${ruled} mt-1`}
                />
              </label>
            </div>

            {/* The letter as it will be posted: real stock, real serif, a page
                width you can actually read. Everything around it is a control;
                this is the thing a person receives. */}
            <label className="block">
              <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-dim">
                The body — {`{{${SLOT}}}`} is the one line the model writes
              </span>
              <textarea
                name="body_template"
                rows={11}
                defaultValue={campaign.bodyTemplate}
                spellCheck={false}
                className="mt-1.5 w-full resize-y rounded-[3px] border border-rule bg-white/70 px-5 py-4 font-serif text-[15px] leading-[1.75] transition-colors focus:border-ink/50"
              />
            </label>

            {!hasSlot && (
              <p className="text-mark">
                The body has no {`{{${SLOT}}}`}, so there is nothing for the model to write.
              </p>
            )}

            <label className="block">
              <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-dim">
                What should that one line say?
              </span>
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
                  <span className="text-dim">
                    Marked ones are never signed in bulk — open each and decide.
                  </span>
                </form>
              )}

              {queue.map(({ message, contact }) => (
                <article
                  key={message.id}
                  className="overflow-hidden rounded-[3px] border border-rule bg-white/70"
                >
                  <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 border-b border-rule px-5 py-3">
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
                    <ul className="border-b border-rule bg-mark/[0.07] px-5 py-2.5 text-mark">
                      {message.validatorFlags.map((flag) => (
                        <li key={flag}>
                          <strong className="font-medium">{flag}</strong> — {WHY[flag] ?? flag}
                        </li>
                      ))}
                    </ul>
                  )}

                  {message.error ? (
                    <p className="px-5 py-3 text-stop">{message.error}</p>
                  ) : (
                    <>
                      <p className="border-b border-rule px-5 py-2.5">
                        <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-dim">
                          Subject{' '}
                        </span>
                        {message.subject}
                      </p>
                      {/* The only thing on this desk a real person will ever
                          read. Everything else defers to it. */}
                      <pre className="whitespace-pre-wrap px-5 py-5 font-serif text-[15px] leading-[1.75]">
                        {message.body}
                      </pre>
                    </>
                  )}

                  <div className="flex gap-2 border-t border-rule px-5 py-3">
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
            <p className="max-w-2xl text-dim">
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
                  <code className="font-mono">collect</code> works one collection by hand;{' '}
                  <code className="font-mono">npm run send</code> works them on a timer.
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
                <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.16em] text-dim">
                  Postmarks
                </p>
                <ul className="space-y-1 font-mono text-[11.5px] text-dim">
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
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-rule px-8 py-3">
        <Search />
        <Filter name="status" label="Any address status" options={emailStatus.enumValues} />
        <Filter name="consent" label="Any consent" options={consentStatus.enumValues} />
        <ClearFilters active={filtered} />
      </div>

      {list.rows.length === 0 ? (
        <Empty
          title={filtered ? 'Nothing matches' : 'The book is empty'}
          note={
            filtered ? 'Clear the filters to see the whole book.' : 'Take in a CSV of addresses to begin.'
          }
        />
      ) : (
        <form action={suppressSelected} className="group flex min-h-0 flex-1 flex-col">
          <Ledger>
            {list.rows.map((contact) => (
              <div
                key={contact.id}
                className="flex items-center gap-3 border-b border-rule/60 px-8 py-2.5 transition-colors hover:bg-ink/[0.03]"
              >
                <input
                  type="checkbox"
                  name="ids"
                  value={contact.id}
                  aria-label={`Select ${contact.email ?? contact.id}`}
                  className="size-3.5 shrink-0 accent-ink"
                />
                <Link href={bookHref(sp, { contact: contact.id })} className="flex min-w-0 flex-1 gap-3">
                  <span className="w-44 shrink-0 truncate font-medium">
                    {[contact.firstName, contact.lastName].filter(Boolean).join(' ') || (
                      <span className="font-serif italic text-dim">
                        {contact.erasedAt ? 'erased' : 'unnamed'}
                      </span>
                    )}
                  </span>
                  <span className="w-56 shrink-0 truncate text-dim">{contact.email ?? '—'}</span>
                  <span className="min-w-0 flex-1 truncate text-dim">{contact.company ?? '—'}</span>
                </Link>
                {contact.consentStatus === 'opted_in' && <Stamp tone="opted_in">opted in</Stamp>}
                <Stamp tone={contact.emailStatus}>{contact.emailStatus}</Stamp>
              </div>
            ))}
          </Ledger>

          {/* Appears only when something is ticked — a CSS :has() rule, no state. */}
          <div className="hidden shrink-0 items-center gap-3 border-t border-rule bg-ink/[0.04] px-8 py-3 group-has-[input:checked]:flex">
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
              <form action={saveStatus} className="space-y-2.5 rounded-[3px] border border-rule p-4">
                <input type="hidden" name="id" value={selected.id} />
                <p className="font-serif text-[17px]">May we write to them?</p>
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
              <p className="mb-1 font-serif text-[17px]">What the CSV carried</p>
              <p className="mb-2 text-dim">
                Everything beyond the fields above. Personalisation may use only what is in here.
              </p>
              <pre className="max-h-56 overflow-auto rounded-[3px] border border-rule bg-white/60 p-3 font-mono text-[11.5px]">
                {JSON.stringify(selected.context, null, 2)}
              </pre>
            </div>

            <div className="flex flex-wrap gap-2 border-t border-rule pt-5">
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
          <div key={box.id} className="flex items-baseline gap-3 border-b border-rule/60 px-8 py-4">
            <span className="min-w-0 flex-1 truncate font-serif text-[17px]">{box.email}</span>
            {box.sendsCatchAll && <Stamp tone="catch_all">catch all · 10/day</Stamp>}
            {box.halted && <Stamp tone="halted">halted</Stamp>}
            {!box.active && <Stamp tone="paused">paused</Stamp>}
            <span className="w-28 shrink-0 text-right font-mono text-[11.5px] text-dim">
              {box.sentToday}/{box.cap} today
            </span>
          </div>
        ))}
        {boxes.length === 0 && (
          <Empty
            title="No post boxes"
            note={
              <>
                <code className="font-mono text-ink">npm run db:seed</code> adds the first two.
              </>
            }
          />
        )}
        <p className="px-8 py-6 text-dim">
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
      note={`${blocks.length} entries. Stored as a hash, so a person can be erased and still never be written to. There is no way to remove one.`}
      actions={
        <form action={blockDomain} className="flex items-end gap-2">
          <label className="block">
            <span className="sr-only">Domain to block</span>
            <input name="domain" placeholder="competitor.com" className={`${ruled} w-44`} />
          </label>
          <select name="reason" defaultValue="competitor" className={`${ruled} w-28`}>
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
          <div key={row.id} className="flex items-center gap-3 border-b border-rule/60 px-8 py-2.5">
            <span className="min-w-0 flex-1 truncate">
              {row.domain ? (
                <span className="font-medium">@{row.domain}</span>
              ) : (
                <span className="font-mono text-[11.5px] text-dim">
                  {row.emailHash?.slice(0, 32)}…
                </span>
              )}
            </span>
            <Stamp tone={row.reason === 'unsubscribed' ? 'opted_in' : row.reason}>{row.reason}</Stamp>
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
      <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-dim">{label}</dt>
      <dd className="break-words">{value || '—'}</dd>
    </>
  )
}
