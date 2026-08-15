import { count, desc } from 'drizzle-orm'
import Link from 'next/link'
import { ViewTransition } from 'react'
import { db } from '@/db'
import { consentStatus, emailStatus, mailboxes, suppressions } from '@/db/schema'
import {
  audienceSize,
  audienceSizes,
  counts,
  getCampaign,
  listCampaigns,
  reviewQueue,
  sentLog,
  sentMessages,
} from '@/lib/campaigns'
import { contactStats, fieldCoverage, getContact, listContacts } from '@/lib/contacts'
import { KINDS, review, shape } from '@/lib/compose'
import { conversionCounts, enquiryCount, listEnquiries } from '@/lib/funnel'
import { byLetter, byMailbox, bySource, listHealth } from '@/lib/reports'
import { asClock, tuning } from '@/lib/settings'
import { advise } from '@/lib/advice'
import { interval, readable } from '@/lib/stats'
import { listDomains } from '@/lib/domains'
import { audienceOf, listSegments, stageCounts } from '@/lib/segments'
import { STAGES } from '@/db/schema'
import { canPull, listSources, PUSH_PRESETS, pushUrl, readiness } from '@/lib/sources'
import { LIMITS } from '@/lib/rules'
import { isConfigured } from '@/lib/gmail'
import { frankingCode, nextAction, shouldHalt, warmupCap, type Next } from '@/lib/rules'
import { mailboxStats } from '@/lib/send'
import { SLOT } from '@/lib/template'
import {
  addSource,
  approve,
  composeCampaign,
  approveAllClean,
  blockDomain,
  enrichContacts,
  erase,
  generateAction,
  newCampaign,
  pauseSending,
  reject,
  removeSource,
  runSourceAction,
  saveCampaignAction,
  saveSettings,
  saveStatus,
  startSending,
  suppressEmail,
  stageSelected,
  suppressSelected,
  tagSelected,
  toggleDomain,
  warmDomain,
} from './actions'
import { CommandBar, ClearFilters, Filter, Postage, Search, Valve, type Box } from './console'
import Importer from './importer'
import Keys, { Shortcuts } from './keys'
import Letter, { type Card } from '../letter'
import {
  Drawer,
  Empty,
  field,
  Franking,
  go,
  ink,
  Label,
  Ledger,
  Pager,
  quiet,
  ROWS,
  small,
  ruled,
  Sheet,
  Stamp,
  type StepState,
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

const BOOK_VIEWS = new Set([
  'book', 'boxes', 'returned', 'sent', 'replies', 'sources', 'reports', 'settings',
])

/** The four things you do to a letter, in the order you do them. */
const STEPS = ['Write', 'Who', 'Review', 'Send'] as const

/** Where the mark sends you: the step that has the button for what it asked. */
const STEP_FOR = { draft: 2, read: 3, post: 4, hold: 4, none: 1 } as const

/** What each stage is for, said once, at the top of it. */
const ABOUT: Record<number, string> = {
  1: 'One message, written once. The model writes a single line of it per person.',
  2: 'Who it goes to, and drafting a batch for them.',
  3: 'Read each draft and decide. Nothing sends until you do.',
  4: 'Send it, at a rate that keeps the domain safe.',
}

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? ''
const num = (v: string | string[] | undefined, fallback = 1) => {
  const n = Number(one(v))
  return Number.isInteger(n) && n > 0 ? n : fallback
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * An id from the URL, or nothing.
 *
 * These columns are `uuid`, so Postgres throws on anything that is not one —
 * a stale bookmark or a typo in the address bar was a 500. Guarding here rather
 * than at each query is the whole fix: there are exactly two ids in the URL and
 * both come through this function, so no later caller can reintroduce it.
 */
const id = (v: string | string[] | undefined) => (UUID.test(one(v)) ? one(v) : '')
type Params = Record<string, string | string[] | undefined>

export default async function Desk({ searchParams }: PageProps<'/'>) {
  const sp = await searchParams
  const view = one(sp.view)
  const openId = id(sp.c)

  const [rows, contacts, boxRows, replies] = await Promise.all([
    listCampaigns(),
    contactStats(),
    db.select().from(mailboxes).orderBy(mailboxes.email),
    enquiryCount(),
  ])

  // One query for every letter's audience. This was two per letter on every
  // navigation, which is what the load test caught.
  const sizes = await audienceSizes(rows.map((r) => r.campaign))
  const audiences = rows.map((r) => sizes.get(r.campaign.id) ?? 0)

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
      code: frankingCode(campaign.id),
    }
  })

  // What each letter needs, kept beside the cards so the mark on the envelope
  // and the inside of the letter are answering from the same function.
  const guides = new Map(
    rows.map((r, i) => [
      r.campaign.id,
      nextAction(
        { drafts: r.drafts, flagged: r.flagged, approved: r.approved, sent: r.sent },
        audiences[i],
        r.campaign.status,
      ),
    ]),
  )

  const gone = rows.reduce((total, r) => total + r.sent, 0)
  const flagged = rows.reduce((total, r) => total + r.flagged, 0)
  const halted = boxes.filter((box) => box.halted)
  const needsYou = rows.find((r) => r.flagged > 0)
  const listed = one(sp.as) === 'list'
  const making = one(sp.new) === '1'
  const find = one(sp.find).trim().toLowerCase()
  const hasPanel = Boolean(openId) || BOOK_VIEWS.has(view) || listed || making

  // Escape goes up exactly one layer, and the layers are these three. Written
  // out because a collapsed ternary here previously had two identical branches
  // — a line that looked like a decision and was not.
  const back = one(sp.contact) || one(sp.panel)
    ? `/?view=${view}` // a drawer closes onto the panel it opened over
    : '/' //             a panel closes onto the desk


  return (
    <>
      <Keys back={back} />
      <Shortcuts />

      {/* ── the strip ──────────────────────────────────────────────────────
          One line, four zones, in the order you need them: what I can start,
          what needs me, where things are, how the machine is. The middle group
          is the navigation and it shows the open surface on every surface, so
          you can always get anywhere and always know where you are. */}
      <header className="chrome relative z-20 flex shrink-0 flex-wrap items-center gap-x-8 gap-y-3 border-b border-line px-6 py-3">
        <Link href="/?new=1" className={small} aria-label="Start a new letter">
          + New letter
        </Link>

        {flagged > 0 && needsYou ? (
          <Link
            href={`/?c=${needsYou.campaign.id}&step=3`}
            className="font-medium text-primary transition-opacity hover:opacity-75"
          >
            {flagged} {flagged === 1 ? 'draft needs' : 'drafts need'} you
          </Link>
        ) : (
          <span className="text-dim">nothing needs you</span>
        )}

        {/* Three things you do daily, then everything else one level down.
            The strip used to give eleven destinations equal weight, so the
            letters you work every hour sat beside the blocklist you open twice
            a year. Numbers run 1–7 top to bottom, matching the keys. */}
        <nav className="flex items-center gap-1" aria-label="Where things are">
          {(
            [
              ['/?as=list', 'Letters', rows.length, listed],
              ['/?view=replies', 'Replies', replies, view === 'replies'],
              ['/?view=reports', 'Reports', null, view === 'reports'],
            ] as const
          ).map(([href, label, n, on], index) => (
            <Link
              key={label}
              href={href}
              aria-current={on ? 'page' : undefined}
              title={`${label} · press ${index + 1}`}
              className={`flex items-center gap-2 rounded-full border px-3 py-2 transition-[background-color,border-color,transform] active:scale-[0.97] ${
                on
                  ? 'border-primary bg-primary text-secondary'
                  : 'border-line text-dim hover:border-ink/30 hover:bg-raise hover:text-ink'
              }`}
            >
              <span className={`text-small tabular-nums ${on ? 'opacity-60' : 'opacity-40'}`}>
                {index + 1}
              </span>
              {label}
              {n !== null && (
                <span
                  className={`rounded-full px-1.5 text-small tabular-nums ${
                    on ? 'bg-secondary/25' : 'bg-line/70'
                  }`}
                >
                  {n.toLocaleString()}
                </span>
              )}
            </Link>
          ))}

          {/* Native disclosure: no state, no effect, no listener, and it closes
              itself when something inside is clicked because the page navigates. */}
          <details className="relative">
            <summary
              className={`flex cursor-pointer list-none items-center gap-2 rounded-full border px-3 py-2 transition-colors ${
                ['book', 'sent', 'sources', 'returned'].includes(view)
                  ? 'border-primary bg-primary text-secondary'
                  : 'border-line text-dim hover:border-ink/30 hover:bg-raise hover:text-ink'
              }`}
            >
              Everything else
              <span className="text-small opacity-50">▾</span>
            </summary>
            <div className="panel absolute right-0 top-[calc(100%+6px)] z-30 w-60 overflow-hidden rounded-[8px] border border-line p-1 shadow-lg">
              {(
                [
                  ['/?view=book', 'Contacts', contacts.total, 4],
                  ['/?view=sent', 'Sent', gone, 5],
                  ['/?view=sources', 'Sources', null, 6],
                  ['/?view=returned', 'Blocked', null, 7],
                ] as const
              ).map(([href, label, n, key]) => (
                <Link
                  key={label}
                  href={href}
                  aria-current={href.includes(view) ? 'page' : undefined}
                  className="flex items-center gap-3 rounded-[5px] px-3 py-2 text-dim transition-colors hover:bg-raise hover:text-ink"
                >
                  <span className="w-3 text-small tabular-nums opacity-40">{key}</span>
                  <span className="flex-1">{label}</span>
                  {n !== null && <span className="text-small tabular-nums opacity-60">{n.toLocaleString()}</span>}
                </Link>
              ))}
            </div>
          </details>
        </nav>

        <span className="ml-auto flex items-center gap-8">
          <Link href="/?view=boxes" className="text-dim transition-colors hover:text-ink">
            <Postage boxes={boxes} />
          </Link>
          <Link
            href="/?view=settings"
            aria-current={view === 'settings' ? 'page' : undefined}
            className="flex items-center gap-2 text-dim transition-colors hover:text-ink"
          >
            <span
              className={`size-1.5 rounded-full ${isConfigured() ? 'bg-primary' : 'bg-dim'}`}
              aria-hidden
            />
            {isConfigured() ? 'Gmail live' : 'Dry run'}
          </Link>
        </span>

        {halted.length > 0 && (
          <p className="w-full text-primary">
            <strong className="font-medium">{halted[0].email} stopped itself</strong> —{' '}
            {(halted[0].bounceRate * 100).toFixed(1)}% bounced, over the 3% threshold. Its letters
            were paused.
          </p>
        )}
      </header>

      {/* ── the stage ────────────────────────────────────────────────────── */}
      <div className="relative min-h-0 flex-1">
        <div className="absolute inset-0 p-6">
          {cards.length === 0 ? (
            <div className="grid size-full place-items-center text-center">
              <div className="max-w-sm">
                <p className="text-title font-medium tracking-[-0.02em]">No letters yet</p>
                <p className="mt-2 text-dim">
                  A letter is one message written once and personalised for each person on the list.
                </p>
                <form action={newCampaign} className="mt-5 flex items-end justify-center gap-3">
                  <label className="block">
                    <span className="sr-only">Name a new letter</span>
                    <input name="name" placeholder="Name it" className={`${ruled} w-44`} autoFocus />
                  </label>
                  <button className={go}>Start one</button>
                </form>
              </div>
            </div>
          ) : (
            <Letter
              cards={cards}
              openId={openId || undefined}
              listed={listed || making}
              // Steps aside for the panel rather than hiding behind it.
              // Straight back, not aside. A panel to one side and the object
              // to the other makes the eye cross the screen for every reading;
              // pushing it away keeps it as context without competing.
              shift={0}
            />
          )}
        </div>

        {hasPanel && (
          <ViewTransition enter="screen" exit="screen" default="none">
            {/* Sits to the right on a wide window so the letter stays in view,
                and takes the whole stage when there is not room for both. */}
            <div className="absolute inset-0 z-10 flex justify-center p-6">
              {/* One column, centred, at a readable width. Everything you need
                  for the task is on a single vertical axis. */}
              <div className="flex min-h-0 w-full max-w-[760px] flex-col">
                {making ? (
                  <ComposeSheet sp={sp} />
                ) : openId ? (
                  <LetterSheet
                    id={openId}
                    step={sp.step ? num(sp.step) : STEP_FOR[guides.get(openId)?.action ?? 'none']}
                    at={num(sp.m)}
                    guide={guides.get(openId)}
                  />
                ) : listed ? (
                  <ListSheet cards={cards} find={find} />
                ) : view === 'book' ? (
                  <BookSheet sp={sp} />
                ) : view === 'sent' ? (
                  <SentSheet q={one(sp.q).trim()} page={num(sp.page)} />
                ) : view === 'replies' ? (
                  <RepliesSheet page={num(sp.page)} />
                ) : view === 'sources' ? (
                  <SourcesSheet />
                ) : view === 'reports' ? (
                  <ReportsSheet />
                ) : view === 'settings' ? (
                  <SettingsSheet saved={one(sp.saved) === '1'} />
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

      <CommandBar
        campaignId={openId || undefined}
        campaignName={cards.find((c) => c.id === openId)?.name}
        listed={listed}
      />

      {BOOK_VIEWS.has(view) && <BookDrawers sp={sp} />}
    </>
  )
}

/* ── the list, and starting a letter ──────────────────────────────────────── */

/**
 * The same letters, seen head-on.
 *
 * The stack is already vertical, so this is not another way of looking at the
 * data — it is the same column with the perspective taken out. Each row carries
 * the letter's own franking bars, which is how you match a row to the envelope
 * you were just holding.
 */
function ListSheet({ cards, find }: { cards: Card[]; find: string }) {
  const shown = find ? cards.filter((card) => card.name.toLowerCase().includes(find)) : cards

  return (
    <Sheet
      label="Letters"
      title={find ? `Letters matching “${find}”` : 'Every letter'}
      note={`${shown.length} of ${cards.length}. Type in the bar below to narrow.`}
      actions={
        <>
          <Link href="/?new=1" className={go}>
            + New letter
          </Link>
        </>
      }
    >
      {shown.length === 0 ? (
        <Empty title="Nothing matches" note="Clear what you typed to see them all." />
      ) : (
        <Ledger>
          {shown.map((card) => (
            <Link
              key={card.id}
              href={card.href}
              className="flex items-center gap-4 border-b border-line px-6 py-3 transition-colors hover:bg-raise"
            >
              <span className="text-primary">
                <Franking code={card.code} />
              </span>
              <span className="min-w-0 flex-1 truncate font-medium">{card.name}</span>
              <span className="truncate text-dim">
                {card.count > 0 ? `${card.count} · ${card.mark}` : card.mark}
              </span>
            </Link>
          ))}
        </Ledger>
      )}
    </Sheet>
  )
}

/**
 * Three questions, then a letter.
 *
 * What kind of message, what we actually know about these people, and the one
 * thing being asked for. That is enough to write the subject, the body and the
 * model's instruction — nobody should have to learn a mail-merge syntax to send
 * their first letter.
 *
 * The shapes and the checks are in lib/compose.ts, from published cold-email
 * research rather than taste: one ask, a subject about them, roughly a hundred
 * words, and no link in a first touch.
 */
async function ComposeSheet({ sp }: { sp: Params }) {
  const [coverage, segments, stages] = await Promise.all([
    fieldCoverage(),
    listSegments(),
    stageCounts(),
  ])
  const picked = {
    segments: (Array.isArray(sp.seg) ? sp.seg : sp.seg ? [sp.seg] : []).map(String),
    stages: (Array.isArray(sp.stg) ? sp.stg : sp.stg ? [sp.stg] : []).map(String),
  }
  const reach = await audienceOf(picked.segments, picked.stages)
  const kind = (KINDS as readonly string[]).includes(one(sp.kind)) ? one(sp.kind) : 'intro'
  const preview = shape(kind as (typeof KINDS)[number], one(sp.ask), one(sp.signoff))
  const notes = review(preview.subject, preview.body, SLOT)

  const step = num(sp.at, 1)
  const to = (patch: Record<string, string>) => {
    const next = new URLSearchParams({ new: '1', kind, ...patch })
    for (const k of ['ask', 'signoff', 'name'] as const) {
      if (!(k in patch) && one(sp[k])) next.set(k, one(sp[k]))
    }
    for (const seg of picked.segments) next.append('seg', seg)
    for (const stg of picked.stages) next.append('stg', stg)
    return `/?${next.toString()}`
  }

  // Toggling one group in or out of the audience, without losing the rest.
  const toggle = (key: 'seg' | 'stg', value: string) => {
    const next = new URLSearchParams({ new: '1', kind, at: '2' })
    for (const k of ['ask', 'signoff', 'name'] as const) if (one(sp[k])) next.set(k, one(sp[k]))
    const on = key === 'seg' ? picked.segments : picked.stages
    const other = key === 'seg' ? picked.stages : picked.segments
    for (const v of on.includes(value) ? on.filter((x) => x !== value) : [...on, value]) {
      next.append(key, v)
    }
    for (const v of other) next.append(key === 'seg' ? 'stg' : 'seg', v)
    return `/?${next.toString()}`
  }

  return (
    <Sheet
      label="New letter"
      title={step === 1 ? 'What kind of message?' : step === 2 ? 'Who is it for?' : 'What are you asking for?'}
      note={
        step === 1
          ? 'Three moments, three different emails — not three wordings of one.'
          : step === 2
            ? 'The model may only use what you tick. Anything it cannot support, it leaves out.'
            : 'One ask. Two questions make the reader decide before replying.'
      }
    >
      <form action={composeCampaign} className="quiet-scroll flex min-h-0 flex-1 flex-col gap-6 p-6">
        <input type="hidden" name="kind" value={kind} />

        {/* ── 1 · which message ─────────────────────────────────────────── */}
        {step === 1 && (
          <div className="grid gap-3 sm:grid-cols-3">
            {KINDS.map((k) => {
              const s = shape(k, '', '')
              const on = k === kind
              return (
                <Link
                  key={k}
                  href={to({ kind: k })}
                  aria-current={on ? 'true' : undefined}
                  className={`flex flex-col gap-2 rounded-[8px] border p-6 transition-colors ${
                    on ? 'border-primary bg-primary/[0.05]' : 'border-line hover:bg-raise'
                  }`}
                >
                  <span className={`font-medium ${on ? 'text-primary' : ''}`}>{s.label}</span>
                  <span className="text-dim">{s.about}</span>
                </Link>
              )
            })}
          </div>
        )}

        {/* ── 2 · who it is for, and what we know ──────────────────────── */}
        {step === 2 && (
          <div className="flex flex-col gap-6">
            {picked.segments.map((v) => (
              <input key={v} type="hidden" name="seg" value={v} />
            ))}
            {picked.stages.map((v) => (
              <input key={v} type="hidden" name="stg" value={v} />
            ))}

            <div className="flex flex-col gap-3">
              <div className="flex items-baseline gap-3">
                <Label>Who it goes to</Label>
                <span className="ml-auto flex items-baseline gap-2">
                  <span className="text-display font-medium leading-none text-primary">{reach}</span>
                  <span className="text-dim">will get it</span>
                </span>
              </div>

              {segments.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {segments.map((seg) => {
                    const on = picked.segments.includes(seg.name)
                    return (
                      <Link
                        key={seg.name}
                        href={toggle('seg', seg.name)}
                        aria-current={on ? 'true' : undefined}
                        className={`flex items-center gap-2 rounded-full border px-3 py-2 transition-colors ${
                          on ? 'border-primary bg-primary text-secondary' : 'border-line hover:bg-raise'
                        }`}
                      >
                        {seg.name}
                        <span className="tabular-nums opacity-70">{seg.sendable}</span>
                      </Link>
                    )
                  })}
                </div>
              )}

              <div className="flex flex-wrap items-center gap-2">
                <span className="text-dim">how far along</span>
                {stages.map((s) => {
                  const on = picked.stages.includes(s.stage)
                  return (
                    <Link
                      key={s.stage}
                      href={toggle('stg', s.stage)}
                      aria-current={on ? 'true' : undefined}
                      className={`flex items-center gap-2 rounded-full border px-3 py-2 capitalize transition-colors ${
                        on ? 'border-primary bg-primary text-secondary' : 'border-line hover:bg-raise'
                      }`}
                    >
                      {s.stage}
                      <span className="tabular-nums opacity-70">{s.n}</span>
                    </Link>
                  )
                })}
              </div>

              <p className="text-dim">
                {picked.segments.length + picked.stages.length === 0
                  ? 'Nothing picked, so this goes to everyone who can be written to.'
                  : 'Someone must match one of the groups and one of the stages.'}
              </p>
            </div>

            <div className="flex flex-col gap-3">
              <Label>What the model may lean on</Label>
              <p className="text-dim">
                A field only some of them have leaves a hole in the rest, so the share matters more
                than the name.
              </p>
              <div className="grid gap-2 sm:grid-cols-2">
                {coverage.fields.map((f) => {
                  const thin = f.share < 0.6
                  return (
                    <label
                      key={f.name}
                      className="flex items-center gap-3 rounded-[6px] border border-line px-3 py-2 transition-colors hover:bg-raise"
                    >
                      <input
                        type="checkbox"
                        name="lean"
                        value={f.name}
                        defaultChecked={f.share >= 0.8}
                        className="size-3.5 shrink-0 accent-primary"
                      />
                      <span className="min-w-0 flex-1 truncate">{f.name}</span>
                      <Bar value={f.share} danger={thin} />
                      <span className={`w-12 text-right text-small tabular-nums ${thin ? 'text-primary' : 'text-dim'}`}>
                        {Math.round(f.share * 100)}%
                      </span>
                    </label>
                  )
                })}
              </div>
            </div>
          </div>
        )}

        {/* ── 3 · the ask, and what it becomes ──────────────────────────── */}
        {step === 3 && (
          <div className="flex flex-col gap-5">
            <div className="grid gap-5 sm:grid-cols-2">
              <label className="flex flex-col gap-2">
                <Label>The one ask</Label>
                <input
                  name="ask"
                  defaultValue={one(sp.ask) || 'Worth a short call next week?'}
                  className={ruled}
                />
                <span className="text-dim">Small asks get answered. A demo is a big ask.</span>
              </label>
              <label className="flex flex-col gap-2">
                <Label>Sign off as</Label>
                <input name="signoff" defaultValue={one(sp.signoff) || 'Dibakar'} className={ruled} />
              </label>
            </div>

            <label className="flex flex-col gap-2">
              <Label>Call this letter</Label>
              <input
                name="name"
                defaultValue={one(sp.name)}
                placeholder="Autumn outreach"
                className={ruled}
                required
              />
              <span className="text-dim">Only you see this.</span>
            </label>

            {/* What it becomes, before it exists. */}
            <div className="rounded-[6px] border border-line">
              <p className="border-b border-line bg-raise px-3 py-2">
                <span className="text-dim">Subject </span>
                {preview.subject}
              </p>
              <pre className="whitespace-pre-wrap px-3 py-3 font-sans leading-[1.7]">{preview.body}</pre>
              <p className="border-t border-line px-3 py-2 text-dim">
                <strong className="font-medium text-ink">{'{{personalised}}'}</strong> is the only line
                the model writes. Everything else is yours.
              </p>
            </div>

            {notes.length > 0 && (
              <ul className="flex flex-col gap-1">
                {notes.map((n) => (
                  <li key={n.text} className={n.level === 'stop' ? 'text-primary' : 'text-dim'}>
                    {n.level === 'stop' ? '· ' : '· '}
                    {n.text}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* ── where you are, and the way on ─────────────────────────────── */}
        <div className="mt-auto flex items-center gap-3 border-t border-line pt-5">
          <span className="flex items-center gap-1.5" aria-hidden>
            {[1, 2, 3].map((n) => (
              <span
                key={n}
                className={`h-1.5 rounded-full transition-all ${
                  n === step ? 'w-5 bg-primary' : n < step ? 'w-1.5 bg-ink/50' : 'w-1.5 bg-line'
                }`}
              />
            ))}
          </span>
          <span className="text-dim">step {step} of 3</span>

          <span className="ml-auto flex items-center gap-3">
            {step > 1 && (
              <Link href={to({ at: String(step - 1) })} className={quiet}>
                Back
              </Link>
            )}
            {step < 3 ? (
              <Link href={to({ at: String(step + 1) })} className={go}>
                Next
              </Link>
            ) : (
              <button className={go} disabled={notes.some((n) => n.level === 'stop')}>
                Write it
              </button>
            )}
          </span>
        </div>
      </form>
    </Sheet>
  )
}

/* ── one letter, unfolded ─────────────────────────────────────────────────── */

const WHY: Record<string, string> = {
  ungrounded: 'mentions something we have no record of for this person',
  thin: 'says nothing beyond their name, title and company',
}

/** The one thing this letter needs, said as a sentence rather than a stamp. */
const HEADLINE: Record<Next['action'], (n: number) => string> = {
  read: (n) => `${n} ${n === 1 ? 'draft is' : 'drafts are'} waiting to be read`,
  hold: (n) => `Sending now — ${n} approved and going out`,
  post: (n) => `${n} approved and ready to send`,
  draft: (n) => `Ready to draft the next ${n}`,
  none: () => 'Nothing to do on this letter',
}

async function LetterSheet({
  id,
  step,
  at,
  guide,
}: {
  id: string
  step: number
  at: number
  guide?: Next
}) {
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
  const written = tally.drafts + tally.flagged + tally.approved + tally.sent
  const notes = review(campaign.subjectTemplate, campaign.bodyTemplate, SLOT)
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
        <Link href="/" className={quiet}>
          Put it down
        </Link>
      }
    >
      {/* What to do, before what there is to look at. The same nextAction()
          that draws the mark on the envelope, so the two cannot disagree. */}
      {guide && (
        <div className="shrink-0 border-b border-line px-6 py-3">
          <p className={`font-medium ${guide.action === 'read' ? 'text-primary' : ''}`}>
            {HEADLINE[guide.action](guide.count)}
          </p>
          <p className="text-dim">{ABOUT[clause]}</p>
        </div>
      )}

      <div className="quiet-scroll min-h-0 flex-1 p-6">
        {clause === 1 && (
          <form action={saveCampaignAction} className="flex h-full flex-col gap-5">
            <input type="hidden" name="id" value={campaign.id} />

            <div className="grid shrink-0 gap-5 sm:grid-cols-2">
              <label className="flex flex-col gap-2">
                <Label>Name</Label>
                <input name="name" defaultValue={campaign.name} className={ruled} />
              </label>
              <label className="flex flex-col gap-2">
                <Label>Subject</Label>
                <input name="subject_template" defaultValue={campaign.subjectTemplate} className={ruled} />
              </label>
            </div>

            <label className="flex min-h-0 flex-1 flex-col gap-2">
              <Label>The body — {`{{${SLOT}}}`} is the one line the model writes</Label>
              <textarea
                name="body_template"
                defaultValue={campaign.bodyTemplate}
                spellCheck={false}
                className="min-h-0 w-full flex-1 resize-none rounded-[4px] border border-line bg-raise px-3 py-2 leading-[1.7] transition-colors focus:border-primary"
              />
            </label>

            <label className="flex shrink-0 flex-col gap-2">
              <Label>What should that one line say?</Label>
              <textarea
                name="prompt"
                rows={2}
                defaultValue={campaign.prompt}
                className={`${field} resize-none`}
              />
            </label>

            {/* The practice checks, from lib/compose.ts. Advice, not gates. */}
            {notes.length > 0 && (
              <ul className="flex shrink-0 flex-col gap-1">
                {notes.map((n) => (
                  <li key={n.text} className={n.level === 'stop' ? 'text-primary' : 'text-dim'}>
                    · {n.text}
                  </li>
                ))}
              </ul>
            )}

            <div className="flex shrink-0 items-center gap-3">
              <button className={ink}>Save the message</button>
              <span className="min-w-0 flex-1 truncate text-dim">
                {`{{first_name}} {{company}} {{title}}`} and {`{{context.Any CSV column}}`} also fill.
              </span>
            </div>
          </form>
        )}

        {clause === 2 && (
          <div className="flex h-full flex-col gap-5">
            <div className="flex items-baseline gap-4">
              <p className="text-display font-medium leading-none">{audience}</p>
              <p className="min-w-0 flex-1 text-dim">
                {audience === 1 ? 'address' : 'addresses'} on the list this letter has not been
                written to yet. Sources below feed that list.
              </p>
              {audience > 0 && (
                <form action={generateAction}>
                  <input type="hidden" name="id" value={campaign.id} />
                  <button className={go} disabled={!hasSlot}>
                    Draft the next {Math.min(audience, 25)}
                  </button>
                </form>
              )}
            </div>

            <Sources campaignId={campaign.id} />
          </div>
        )}

        {clause === 3 && <Reading queue={queue} at={at} tally={tally} id={id} href={step3} />}

        {clause === 4 && (
          <div className="flex h-full flex-col gap-5">
            <div className="flex items-baseline gap-6">
              {(
                [
                  ['Signed', tally.approved],
                  ['Posted', tally.sent],
                ] as const
              ).map(([label, value]) => (
                <div key={label}>
                  <p className="text-display font-medium leading-none">{value}</p>
                  <p className="mt-2 text-dim">{label}</p>
                </div>
              ))}
              <p className="min-w-0 flex-1 text-dim">
                {active.length} active {active.length === 1 ? 'mailbox' : 'mailboxes'}, up to {capacity} a
                day between them. Above the bounce threshold this letter stops on its own.
              </p>
            </div>

            {campaign.status === 'sending' ? (
              <form action={pauseSending} className="flex flex-wrap items-center gap-3">
                <input type="hidden" name="id" value={campaign.id} />
                <button className={quiet}>Hold the post</button>
                <span className="text-dim">
                  <code>sendnow</code> works one send by hand.
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
                <ul className="mt-2 flex flex-col gap-1 text-small tabular-nums text-dim">
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

      <Stepper
        steps={STEPS.map((name, index) => {
          const n = index + 1
          const done = [
            hasSlot && campaign.prompt.trim().length > 0,
            written > 0,
            written > 0 && tally.drafts + tally.flagged === 0,
            tally.sent > 0,
          ][index]
          return { name, state: (n === clause ? 'now' : done ? 'done' : 'todo') as StepState }
        })}
        href={(n) => `/?c=${id}&step=${n}`}
      />
    </Sheet>
  )
}

/**
 * One message under the pen, never a list.
 *
 * This is how a stack of letters is actually signed — read one, decide, the
 * next comes up. Approving or discarding shortens the queue, so the same index
 * lands on the next message with no cursor to keep in sync.
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
            ? `${tally.approved} approved and ready to send.`
            : 'Draft some on the step before this.'
        }
      />
    )

  const index = Math.min(Math.max(at, 1), queue.length)
  const { message, contact } = queue[index - 1]

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex shrink-0 flex-wrap items-baseline gap-3">
        <span className="font-medium">
          {[contact.firstName, contact.lastName].filter(Boolean).join(' ') || 'Unnamed'}
        </span>
        <span className="text-dim">{contact.email}</span>
        {contact.company && <span className="text-dim">· {contact.company}</span>}
        <span className="ml-auto flex items-center gap-2">
          {message.validatorFlags.map((flag) => (
            <Stamp key={flag} tone="flagged">
              {flag}
            </Stamp>
          ))}
          <span className="text-dim tabular-nums">
            {index} of {queue.length}
          </span>
        </span>
      </div>

      {message.validatorFlags.length > 0 && (
        <ul className="shrink-0 rounded-[4px] border border-primary/35 bg-primary/[0.06] px-3 py-2 text-primary">
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
        <div className="quiet-scroll min-h-0 flex-1 rounded-[4px] border border-line bg-raise p-6">
          <p className="mb-3 border-b border-line pb-2">
            <span className="text-dim">Subject </span>
            {message.subject}
          </p>
          <pre className="whitespace-pre-wrap font-sans leading-[1.75]">{message.body}</pre>
        </div>
      )}

      <div className="flex shrink-0 flex-wrap items-center gap-3">
        <form action={approve}>
          <input type="hidden" name="id" value={message.id} />
          <button className={go} disabled={Boolean(message.error)}>
            Approve
          </button>
        </form>
        <form action={reject}>
          <input type="hidden" name="id" value={message.id} />
          <button className={quiet}>Discard</button>
        </form>

        {tally.drafts > 0 && (
          <form action={approveAllClean} className="ml-auto flex items-center gap-3">
            <input type="hidden" name="id" value={id} />
            <span className="text-dim">Flagged ones are never approved in bulk.</span>
            <button className={quiet}>Approve the {tally.drafts} clean</button>
          </form>
        )}
      </div>

      {queue.length > 1 && (
        <div className="flex shrink-0 items-center justify-center gap-3">
          {index > 1 && (
            <Link href={href(index - 1)} className={quiet}>
              ‹ back
            </Link>
          )}
          {index < queue.length && (
            <Link href={href(index + 1)} className={quiet}>
              skip ›
            </Link>
          )}
        </div>
      )}
    </div>
  )
}

/* ── the address book ─────────────────────────────────────────────────────── */

const fmt = (d: Date) =>
  d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })

const bookHref = (sp: Params, patch: Record<string, string | undefined>) => {
  const next = new URLSearchParams({ view: 'book' })
  const base = { q: one(sp.q), status: one(sp.status), consent: one(sp.consent), page: one(sp.page) }
  for (const [key, value] of Object.entries({ ...base, ...patch })) if (value) next.set(key, value)
  return `/?${next.toString()}`
}

async function BookSheet({ sp }: { sp: Params }) {
  const said = one(sp.said)
  const q = one(sp.q).trim()
  const status = one(sp.status)
  const consent = one(sp.consent)
  const list = await listContacts({ q, status, consent, page: num(sp.page), size: ROWS })
  const filtered = Boolean(q || status || consent)

  return (
    <Sheet
      label="Contacts"
      title="Everyone we may write to"
      note={`${list.total.toLocaleString()} ${filtered ? 'matching' : 'on the list'}`}
      actions={
        <>
          <form action={enrichContacts}>
            <button className={quiet} title="Ask Apollo what it knows about unverified addresses">
              Enrich unverified
            </button>
          </form>
          <a
            href={`/api/export?${new URLSearchParams({ ...(q && { q }), ...(status && { status }), ...(consent && { consent }) })}`}
            className={quiet}
          >
            Export
          </a>
          <Link href={bookHref(sp, { panel: 'import' })} className={go}>
            Take in a CSV
          </Link>
        </>
      }
    >
      {said && <p className="shrink-0 border-b border-line bg-raise px-6 py-3">{said}</p>}

      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-line px-6 py-3">
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
                className="flex items-center gap-3 border-b border-line px-6 py-2 transition-colors hover:bg-raise"
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
                      <span className="italic text-dim">{contact.erasedAt ? 'erased' : 'unnamed'}</span>
                    )}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-dim">{contact.email ?? '—'}</span>
                </Link>
                {contact.segments.slice(0, 2).map((seg) => (
                  <Stamp key={seg} tone="none">
                    {seg}
                  </Stamp>
                ))}
                <Stamp tone={contact.stage === 'new' ? 'draft' : 'sent'}>{contact.stage}</Stamp>
                <Stamp tone={contact.emailStatus}>{contact.emailStatus}</Stamp>
              </div>
            ))}
          </Ledger>

          {/* Appears only when something is ticked — a CSS :has() rule, no state. */}
          <div className="hidden shrink-0 flex-wrap items-center gap-3 border-t border-line bg-raise px-6 py-3 group-has-[input:checked]:flex">
            <input
              name="segment"
              placeholder="Add to a group…"
              className={`${ruled} w-40`}
              formAction={tagSelected}
            />
            <button className={quiet} formAction={tagSelected}>
              Tag
            </button>
            <select name="stage" className={`${ruled} w-32 capitalize`} defaultValue="contacted">
              {STAGES.map((st) => (
                <option key={st} value={st}>
                  {st}
                </option>
              ))}
            </select>
            <button className={quiet} formAction={stageSelected}>
              Move stage
            </button>
            <span className="ml-auto flex items-center gap-3">
              <span className="text-dim">Permanent:</span>
              <button className={ink}>Never write to these</button>
            </span>
          </div>
        </form>
      )}

      {list.pages > 1 && (
        <Pager page={list.page} pages={list.pages} href={(page) => bookHref(sp, { page: String(page) })} />
      )}
    </Sheet>
  )
}

async function BookDrawers({ sp }: { sp: Params }) {
  const openId = id(sp.contact)
  const panel = one(sp.panel)
  const selected = openId ? await getContact(openId) : undefined
  const closed = bookHref(sp, { contact: undefined, panel: undefined })

  return (
    <>
      {panel === 'import' && (
        <Drawer title="Take in a CSV" label="Contacts" closeHref={closed} wide>
          <Importer />
        </Drawer>
      )}

      {selected && (
        <Drawer
          label="Contacts"
          title={[selected.firstName, selected.lastName].filter(Boolean).join(' ') || 'Unnamed'}
          closeHref={closed}
        >
          <div className="flex flex-col gap-6">
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
              <form action={saveStatus} className="flex flex-col gap-3 rounded-[5px] border border-line p-6">
                <input type="hidden" name="id" value={selected.id} />
                <p className="font-medium">May we write to them?</p>
                <p className="text-dim">
                  Only verified and catch-all can ever be written to, and catch-all only from a
                  mailbox flagged for it.
                </p>
                <div className="flex gap-3">
                  <select name="email_status" defaultValue={selected.emailStatus} className={`${field} capitalize`}>
                    {emailStatus.enumValues.map((value) => (
                      <option key={value} value={value}>
                        {value.replace('_', ' ')}
                      </option>
                    ))}
                  </select>
                  <select name="consent_status" defaultValue={selected.consentStatus} className={`${field} capitalize`}>
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
              <pre className="quiet-scroll mt-2 max-h-56 rounded-[4px] border border-line bg-raise p-3 text-small">
                {JSON.stringify(selected.context, null, 2)}
              </pre>
            </div>

            <div className="flex flex-wrap gap-3 border-t border-line pt-5">
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
              Erasing clears the personal fields and keeps the never-send hash, so they stay
              unwritable and a re-import cannot bring them back.
            </p>
          </div>
        </Drawer>
      )}
    </>
  )
}

/* ── everything that has gone ─────────────────────────────────────────────── */

const when = (d: Date | null) =>
  d ? d.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'

async function SentSheet({ q, page }: { q: string; page: number }) {
  const log = await sentLog({ q, page, size: ROWS })
  const href = (n: number) => `/?view=sent&page=${n}${q ? `&q=${encodeURIComponent(q)}` : ''}`

  return (
    <Sheet
      label="Sent"
      title="Everything that has gone"
      note={`${log.total.toLocaleString()} ${log.total === 1 ? 'message' : 'messages'}${q ? ` matching “${q}”` : ''}, newest first.`}
    >
      <div className="flex shrink-0 items-center gap-3 border-b border-line px-6 py-3">
        <Search placeholder="Search an address, company or letter" />
      </div>

      {log.rows.length === 0 ? (
        <Empty
          title={q ? 'Nothing matches' : 'Nothing has gone yet'}
          note={q ? 'Clear the search.' : 'Approve some drafts and put a letter in the post.'}
        />
      ) : (
        <Ledger>
          {log.rows.map(({ message, contact, campaign }) => (
            <div key={message.id} className="flex items-baseline gap-3 border-b border-line px-6 py-3">
              <span className="w-28 shrink-0 text-small tabular-nums text-dim">{when(message.sentAt)}</span>
              <span className="w-48 shrink-0 truncate">{contact.email}</span>
              <span className="min-w-0 flex-1 truncate text-dim">{contact.company ?? '—'}</span>
              <Link
                href={`/?c=${campaign.id}`}
                className="w-40 shrink-0 truncate text-dim underline-offset-4 hover:text-ink hover:underline"
              >
                {campaign.name}
              </Link>
              <Stamp tone={message.status}>{message.status}</Stamp>
            </div>
          ))}
        </Ledger>
      )}

      {log.pages > 1 && <Pager page={log.page} pages={log.pages} href={href} />}
    </Sheet>
  )
}

/* ── reports ──────────────────────────────────────────────────────────────── */

const asPercent = (n: number) => `${(n * 100).toFixed(1)}%`

/**
 * A bar, and only a bar.
 *
 * With two colours there is no categorical palette to encode identity with, so
 * every chart here is magnitude in neutral ink and status in the one red. A
 * bar that turns red has crossed something; a bar that does not has not.
 */
function Bar({ value, danger }: { value: number; danger?: boolean }) {
  return (
    <span className="inline-flex h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-line" aria-hidden>
      <span
        className={`rounded-full transition-[width] ${danger ? 'bg-primary' : 'bg-ink/55'}`}
        style={{ width: `${Math.min(Math.max(value, 0), 1) * 100}%` }}
      />
    </span>
  )
}

async function ReportsSheet() {
  const rules = await tuning()
  const [sources, boxes, letters, health] = await Promise.all([
    bySource(),
    byMailbox(rules),
    byLetter(),
    listHealth(),
  ])

  const funnel = await conversionCounts()
  const advice = advise({ mailboxes: boxes, sources, letters, tuning: rules })
  const worst = boxes.reduce((a, b) => (b.towardHalt > (a?.towardHalt ?? -1) ? b : a), boxes[0])
  const sent = letters.reduce((t, l) => t + l.sent, 0)
  const replied = letters.reduce((t, l) => t + l.replied, 0)
  const clicked = letters.reduce((t, l) => t + l.clicked, 0)

  // Only what changes a decision. Everything a table used to carry that did
  // not is gone — the detail still lives on the surface that owns it, one
  // click away, rather than crowding the answer here.
  const row = 'flex items-center gap-4 px-6 py-2.5'

  return (
    <Sheet
      label="Reports"
      title="What is actually happening"
      note="Counted from the rows that caused it, never a tally kept alongside."
    >
      <div className="quiet-scroll min-h-0 flex-1">
        {/* ── what to do ─────────────────────────────────────────────────
            First and largest, because a report you have to interpret is a
            report nobody reads twice. */}
        <div className="flex flex-col gap-2 p-6">
          {advice.map((note) => (
            <div
              key={note.title}
              className={`flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-[8px] px-4 py-3 ${
                note.level === 'urgent' ? 'bg-primary/[0.07]' : 'bg-raise'
              }`}
            >
              <span
                className={`font-medium ${note.level === 'urgent' ? 'text-primary' : ''}`}
              >
                {note.title}
              </span>
              {note.level === 'acted' && <Stamp tone="none">done for you</Stamp>}
              {note.fix && (
                <Link href={note.fix.href} className="ml-auto shrink-0 text-primary underline-offset-4 hover:underline">
                  {note.fix.label} →
                </Link>
              )}
              <span className="w-full text-dim">{note.why}</span>
            </div>
          ))}
        </div>

        {/* ── the three numbers ──────────────────────────────────────────
            Sent is effort; the other two are outcome. Nothing else belongs
            at this size. */}
        <div className="grid grid-cols-3 gap-px bg-line">
          {(
            [
              [sent.toLocaleString(), 'sent', null],
              [sent > 0 ? asPercent(clicked / sent) : '—', 'clicked', `${clicked}`],
              [sent > 0 ? asPercent(replied / sent) : '—', 'replied', `${replied}`],
            ] as const
          ).map(([big, label, sub]) => (
            <div key={label} className="flex flex-col gap-1 bg-panel px-6 py-5">
              <span className="text-display font-medium leading-none">{big}</span>
              <span className="text-dim">
                {label}
                {sub && sub !== '0' && <span className="ml-1.5 opacity-70">{sub}</span>}
              </span>
            </div>
          ))}
        </div>

        {/* ── letters, ranked by what they produced ──────────────────────── */}
        {/* ── the whole funnel ────────────────────────────────────────────
            Sent through to subscribed, which is the only row that is money.
            The last three arrive from your product over /api/conversion. */}
        <section className="pt-6">
          <div className="flex items-baseline gap-3 px-6 pb-3">
            <Label>The funnel</Label>
            <span className="text-dim">outbound through to paid</span>
          </div>
          <div className="flex flex-col gap-1.5 px-6">
            {(
              [
                ['Sent', sent],
                ['Clicked', clicked],
                ['Replied', replied],
                ['Visited', funnel.visited],
                ['Signed up', funnel.signedUp],
                ['Subscribed', funnel.subscribed],
              ] as const
            ).map(([label, n], i, all) => (
              <div key={label} className="flex items-center gap-3">
                <span className="w-20 shrink-0 text-dim">{label}</span>
                <span className="h-5 min-w-px flex-1">
                  <span
                    className={`block h-full rounded-[3px] ${i === all.length - 1 ? 'bg-primary' : 'bg-ink/15'}`}
                    style={{ width: `${all[0][1] > 0 ? Math.max((n / all[0][1]) * 100, n > 0 ? 1.5 : 0) : 0}%` }}
                  />
                </span>
                <span className="w-14 shrink-0 text-right tabular-nums">{n.toLocaleString()}</span>
              </div>
            ))}
          </div>
          {funnel.revenue > 0 && (
            <p className="px-6 pt-3 text-dim">
              <span className="text-ink tabular-nums">
                {(funnel.revenue / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}
              </span>{' '}
              from {funnel.subscribed} {funnel.subscribed === 1 ? 'subscription' : 'subscriptions'}, attributed to the letter that started it.
            </p>
          )}
        </section>

        <section className="pt-6">
          <div className="flex items-baseline gap-3 px-6 pb-2">
            <Label>Letters</Label>
            <span className="text-dim">click or reply, as a range</span>
          </div>
          {[...letters]
            .sort((a, b) => b.replyRate + b.clickRate - (a.replyRate + a.clickRate))
            .map((letter) => (
              <Link key={letter.id} href={`/?c=${letter.id}`} className={`${row} hover:bg-raise`}>
                <span className="min-w-0 flex-1 truncate">{letter.name}</span>

                {/* A flag rate only appears once it means something, and only
                    when it is bad. A green "all fine" column is noise. */}
                {letter.written >= 12 && letter.flagRate > 0.3 && (
                  <span className="shrink-0 text-primary">{asPercent(letter.flagRate)} flagged</span>
                )}

                <span className="w-16 shrink-0 text-right tabular-nums text-dim">{letter.sent}</span>
                {/* The range, not the point. One click in forty is not "2.5%",
                    it is somewhere between 0.4% and 13%, and showing the first
                    number is how a fluke gets promoted to a finding. */}
                <span className="flex w-40 shrink-0 items-center justify-end gap-2">
                  <Bar value={Math.min(interval(letter.clicked + letter.replied, letter.sent).rate * 8, 1)} />
                  <span className="w-24 text-right tabular-nums">
                    {readable(interval(letter.clicked + letter.replied, letter.sent))}
                  </span>
                </span>
              </Link>
            ))}
          {letters.length === 0 && <p className="px-6 py-2 text-dim">No letters yet.</p>}
        </section>

        {/* ── sources, ranked by what they returned ──────────────────────── */}
        <section className="pt-6">
          <div className="flex items-baseline gap-3 px-6 pb-2">
            <Label>Sources</Label>
            <span className="text-dim">enquiries per thousand sent</span>
          </div>
          {[...sources]
            .sort((a, b) => b.yieldPerThousand - a.yieldPerThousand)
            .map((source) => (
              <div key={source.source} className={row}>
                <span className="min-w-0 flex-1 truncate">{source.source}</span>
                <span className="shrink-0 text-dim">
                  {asPercent(source.sendable / Math.max(source.contacts, 1))} usable
                </span>
                <span className="w-16 shrink-0 text-right tabular-nums text-dim">{source.sent}</span>
                <span className="w-20 shrink-0 text-right tabular-nums">
                  {source.enquired > 0 ? (
                    <span className="text-primary">{source.yieldPerThousand.toFixed(1)}/k</span>
                  ) : (
                    <span className="text-dim">—</span>
                  )}
                </span>
              </div>
            ))}
        </section>

        {/* ── safety, in one line unless something is wrong ──────────────── */}
        <section className="pt-6">
          <div className="flex items-baseline gap-3 px-6 pb-2">
            <Label>Safety</Label>
            <Link href="/?view=settings" className="ml-auto text-dim underline-offset-4 hover:text-ink hover:underline">
              stopping above {(rules.bounceThreshold / 100).toFixed(1)}% · tune
            </Link>
          </div>
          <div className={row}>
            <span className="min-w-0 flex-1">
              {worst && worst.towardHalt > 0
                ? `${worst.email} is the closest to stopping`
                : 'Every mailbox is well under the line'}
            </span>
            <span className="flex w-32 shrink-0 items-center justify-end gap-2">
              <Bar value={worst?.towardHalt ?? 0} danger={(worst?.towardHalt ?? 0) > 0.7} />
              <span className="w-12 text-right tabular-nums text-dim">
                {worst && worst.bounced > 0 ? asPercent(worst.bounceRate) : '0%'}
              </span>
            </span>
          </div>
          <p className="px-6 pb-6 pt-1 text-dim">
            {health.total.toLocaleString()} can never be written to, {health.last7} added this week.
          </p>
        </section>
      </div>
    </Sheet>
  )
}

/* ── settings ─────────────────────────────────────────────────────────────── */

/**
 * The rules, as controls, each shown against the range it may live in.
 *
 * A limit you discover by hitting it is a bad limit, so every field states its
 * bounds and why. The clamping itself is in lib/rules.ts beside the rules.
 */
/**
 * The rules, as five plain statements you can edit in place.
 *
 * A form of labelled boxes makes you assemble the meaning yourself. These read
 * as the sentences they are — "send between 09:00 and 17:00" — so the setting
 * and its consequence are the same thing on screen.
 */
async function SettingsSheet({ saved }: { saved: boolean }) {
  const rules = await tuning()
  const span = rules.windowEnd - rules.windowStart
  const inline = 'mx-1 w-20 rounded-[4px] border border-line bg-raise px-2 py-1 text-center tabular-nums transition-colors focus:border-primary'

  return (
    <Sheet
      label="Settings"
      title="How hard to push"
      note="Tighten these while a domain is warming. Every one is bounded — tuning the rules is the point, turning them off is not."
    >
      {saved && <p className="shrink-0 bg-primary/[0.07] px-6 py-3 text-primary">Saved.</p>}

      <form action={saveSettings} className="quiet-scroll min-h-0 flex-1">
        <div className="flex flex-col gap-6 p-6 text-body leading-[2.2]">
          <p>
            Send between
            <input type="time" name="window_start" defaultValue={asClock(rules.windowStart)} className={inline} />
            and
            <input type="time" name="window_end" defaultValue={asClock(rules.windowEnd)} className={inline} />
            <span className="ml-2 text-dim">
              — {(span / 60).toFixed(1)} hours, released evenly so a backlog never goes out at once.
            </span>
          </p>

          {/* The window as the day it describes. */}
          <span className="relative -mt-4 flex h-1.5 w-full overflow-hidden rounded-full bg-line" aria-hidden>
            <span
              className="absolute inset-y-0 bg-primary"
              style={{ left: `${(rules.windowStart / 1440) * 100}%`, width: `${(span / 1440) * 100}%` }}
            />
          </span>

          <p>
            Stop a mailbox above
            <input
              name="bounce_threshold"
              type="number"
              step="0.1"
              min={LIMITS.bounceThreshold[0] / 100}
              max={LIMITS.bounceThreshold[1] / 100}
              defaultValue={(rules.bounceThreshold / 100).toFixed(1)}
              className={inline}
            />
            % bounces, but only after
            <input
              name="bounce_minimum"
              type="number"
              min={LIMITS.bounceMinimum[0]}
              max={LIMITS.bounceMinimum[1]}
              defaultValue={rules.bounceMinimum}
              className={inline}
            />
            attempts.
            <span className="ml-2 text-dim">
              Below {LIMITS.bounceMinimum[0]} attempts a rate is noise; above{' '}
              {LIMITS.bounceThreshold[1] / 100}% the domain is already in trouble.
            </span>
          </p>

          <p>
            Send at most
            <input
              name="catch_all_cap"
              type="number"
              min={LIMITS.catchAllCap[0]}
              max={LIMITS.catchAllCap[1]}
              defaultValue={rules.catchAllCap}
              className={inline}
            />
            catch-all addresses a day, per mailbox.
            <span className="ml-2 text-dim">Zero switches them off entirely.</span>
          </p>

          <p>
            Draft
            <input
              name="draft_batch"
              type="number"
              min={LIMITS.draftBatch[0]}
              max={LIMITS.draftBatch[1]}
              defaultValue={rules.draftBatch}
              className={inline}
            />
            at a time.
            <span className="ml-2 text-dim">Each one is a model call, so this is what a run costs.</span>
          </p>
        </div>

        <div className="flex items-center gap-3 px-6 pb-6">
          <button className={go}>Save</button>
          <span className="text-dim">Takes effect on the next send tick.</span>
        </div>
      </form>
    </Sheet>
  )
}

/* ── sources ──────────────────────────────────────────────────────────────── */

/**
 * Where a letter's audience comes from.
 *
 * Two shapes, and the difference is visible rather than explained: a pull
 * source has a Pull button, a push source has a URL you paste into the tool
 * that will post to it. Whatever the last run said is shown verbatim — an
 * Apollo plan that refuses People Search says so here, instead of looking like
 * a search that found nobody.
 */
async function Sources({ campaignId }: { campaignId?: string }) {
  const sources = await listSources(campaignId)

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex items-baseline gap-3">
        <Label>Sources</Label>
        <span className="text-dim">
          {sources.length === 0 ? 'none yet' : `${sources.length} feeding this list`}
        </span>
      </div>

      {sources.length > 0 && (
        <div className="overflow-hidden rounded-[5px] border border-line">
          {sources.map((source) => {
            const ready = readiness(source.kind)
            return (
              <div
                key={source.id}
                className="flex flex-wrap items-center gap-3 border-b border-line px-3 py-2 last:border-b-0"
              >
                <span className="text-primary">
                  <Franking code={frankingCode(source.id)} className="h-2 w-7" />
                </span>
                <span className="shrink-0 font-medium">{source.name}</span>
                <Stamp tone={source.kind === 'apollo' ? 'sending' : 'none'}>{source.kind}</Stamp>

                {canPull(source.kind) ? (
                  <span className="min-w-0 flex-1 truncate text-dim">
                    {source.lastResult ?? 'never pulled'}
                  </span>
                ) : (
                  <code className="min-w-0 flex-1 truncate text-small text-dim">
                    POST {pushUrl(source.config.preset ?? 'evaboot')}
                  </code>
                )}

                {canPull(source.kind) &&
                  (ready.ok ? (
                    <form action={runSourceAction}>
                      <input type="hidden" name="id" value={source.id} />
                      <button className={quiet}>Pull</button>
                    </form>
                  ) : (
                    <span className="shrink-0 text-primary">{ready.why}</span>
                  ))}

                <form action={removeSource}>
                  <input type="hidden" name="id" value={source.id} />
                  <button className="px-2 text-dim transition-colors hover:text-primary" aria-label={`Remove ${source.name}`}>
                    ✕
                  </button>
                </form>
              </div>
            )
          })}
        </div>
      )}

      <details className="rounded-[5px] border border-line">
        <summary className="cursor-pointer px-3 py-2 text-dim transition-colors hover:text-ink">
          Add a source
        </summary>
        <div className="grid gap-5 border-t border-line p-6 sm:grid-cols-2">
          <form action={addSource} className="flex flex-col gap-3">
            <input type="hidden" name="kind" value="apollo" />
            {campaignId && <input type="hidden" name="campaign" value={campaignId} />}
            <Label>Apollo — we ask them</Label>
            <input name="name" placeholder="Name it" className={ruled} required />
            <input name="titles" placeholder="Titles, comma separated" className={ruled} />
            <input name="locations" placeholder="Locations" className={ruled} />
            <input name="domains" placeholder="Company domains" className={ruled} />
            <button className={quiet}>Add Apollo source</button>
            <p className="text-dim">
              Enrichment works on the free plan. People Search needs a paid one, and a pull will
              say so rather than come back empty.
            </p>
          </form>

          <form action={addSource} className="flex flex-col gap-3">
            <input type="hidden" name="kind" value="linkedin" />
            {campaignId && <input type="hidden" name="campaign" value={campaignId} />}
            <Label>LinkedIn — they post to us</Label>
            <input name="name" placeholder="Name it" className={ruled} required />
            <select name="preset" className={ruled} defaultValue="evaboot">
              {PUSH_PRESETS.map((preset) => (
                <option key={preset.key} value={preset.key}>
                  {preset.label}
                </option>
              ))}
            </select>
            <button className={quiet}>Add LinkedIn source</button>
            <p className="text-dim">
              Sales Navigator has no export API. Point your exporter&rsquo;s webhook at the URL this
              gives you — nothing here automates a browser against LinkedIn.
            </p>
          </form>
        </div>
      </details>
    </div>
  )
}

function SourcesSheet() {
  return (
    <Sheet
      label="Sources"
      title="Where contacts come from"
      note="These feed the address book itself. A source added inside a letter feeds only that letter."
    >
      <div className="min-h-0 flex-1 overflow-hidden p-6">
        <Sources />
      </div>
    </Sheet>
  )
}

/* ── what came back ───────────────────────────────────────────────────────── */

/**
 * The far end of the funnel.
 *
 * Everything else on this desk measures effort — written, approved, sent. This
 * measures the only outcome that matters, and ties each one back to the letter
 * that caused it when there was one.
 */
async function RepliesSheet({ page }: { page: number }) {
  const log = await listEnquiries({ page, size: ROWS })

  return (
    <Sheet
      label="Replies"
      title="Who wrote back"
      note={`${log.total.toLocaleString()} ${log.total === 1 ? 'enquiry' : 'enquiries'} through the website, newest first.`}
    >
      {log.rows.length === 0 ? (
        <Empty
          title="Nobody yet"
          note={
            <>
              Put <code>{'{{link}}'}</code> in a letter&rsquo;s body. It becomes a tracked link
              that records the click and lands them on the enquiry form.
            </>
          }
        />
      ) : (
        <Ledger>
          {log.rows.map(({ enquiry, campaign }) => (
            <div key={enquiry.id} className="flex items-baseline gap-3 border-b border-line px-6 py-3">
              <span className="w-28 shrink-0 text-small tabular-nums text-dim">
                {when(enquiry.createdAt)}
              </span>
              <span className="w-44 shrink-0 truncate font-medium">
                {enquiry.name || enquiry.email}
              </span>
              <span className="min-w-0 flex-1 truncate text-dim">{enquiry.body || '—'}</span>
              {campaign ? (
                <Link
                  href={`/?c=${campaign.id}`}
                  className="w-36 shrink-0 truncate text-dim underline-offset-4 hover:text-ink hover:underline"
                >
                  {campaign.name}
                </Link>
              ) : (
                <span className="w-36 shrink-0 text-right">
                  <Stamp tone="none">came in cold</Stamp>
                </span>
              )}
            </div>
          ))}
        </Ledger>
      )}
      {log.pages > 1 && (
        <Pager page={log.page} pages={log.pages} href={(n) => `/?view=replies&page=${n}`} />
      )}
    </Sheet>
  )
}

/* ── the post boxes, and the returned register ────────────────────────────── */

/**
 * The domains, and the mailboxes on each.
 *
 * Spreading across domains is what keeps the primary one alive: volume splits,
 * each warms on its own clock, and one burning does not stop the others. The
 * ramp is automatic — a young domain sends a handful a day and climbs to its
 * configured cap over about three weeks, so nobody has to edit a number every
 * morning for a fortnight.
 */
async function BoxesSheet({ boxes }: { boxes: Box[] }) {
  const domains = await listDomains()
  // What could go out, and what actually can. Saying only the second reads as
  // broken when the ramp is working fine and a key is simply missing.
  const ready = domains.filter((d) => d.active)
  const allowed = ready.reduce((t, d) => t + d.todayCap, 0)
  const sendable = ready.filter((d) => d.connected).reduce((t, d) => t + d.todayCap, 0)

  return (
    <Sheet
      label="Sending"
      title="Domains we send from"
      note={
        allowed === sendable
          ? `${allowed} a day across ${ready.length} active ${ready.length === 1 ? 'domain' : 'domains'}, after warm-up.`
          : `${allowed} a day allowed by warm-up across ${ready.length} ${
              ready.length === 1 ? 'domain' : 'domains'
            } — ${sendable} of it can actually send. The rest has no key yet and runs as a dry run.`
      }
    >
      <div className="quiet-scroll min-h-0 flex-1">
        {/* How much may go out this minute, drawn against the clock. The only
            number here that cannot be read off a list. */}
        {boxes.length > 0 && (
          <div className="border-b border-line p-6">
            <Valve boxes={boxes} />
          </div>
        )}

        {domains.map((domain) => {
          const mine = boxes.filter((box) => box.email.endsWith(`@${domain.name}`))
          const warming = domain.warmingDay !== null
          // Three weeks to full cap, so the ramp doubles as a progress bar.
          const through = warming ? Math.min((domain.warmingDay ?? 0) / 21, 1) : 1

          return (
            <section key={domain.id} className="border-b border-line last:border-b-0">
              <div className="flex flex-wrap items-center gap-3 px-6 py-3">
                <span className="text-primary">
                  <Franking code={frankingCode(domain.id)} className="h-2.5 w-9" />
                </span>
                <span className="font-medium">{domain.name}</span>

                {!domain.connected && <Stamp tone="flagged">no key</Stamp>}
                {!domain.active && <Stamp tone="paused">paused</Stamp>}
                {/* Warming is about the domain's age, not its credential —
                    a domain with no key yet is still on day n of its ramp. */}
                {warming && (
                  <Stamp tone={domain.active ? 'sending' : 'paused'}>
                    {`warming · day ${domain.warmingDay}`}
                  </Stamp>
                )}

                <span className="ml-auto flex items-center gap-3">
                  <Bar value={through} />
                  <span className="w-24 text-right tabular-nums text-dim">
                    {domain.todayCap}/day now
                  </span>
                </span>

                <form action={warmDomain}>
                  <input type="hidden" name="id" value={domain.id} />
                  <input type="hidden" name="warming" value={warming ? '0' : '1'} />
                  <button className={quiet}>{warming ? 'Mark established' : 'Start warming'}</button>
                </form>
                <form action={toggleDomain}>
                  <input type="hidden" name="id" value={domain.id} />
                  <input type="hidden" name="active" value={domain.active ? '0' : '1'} />
                  <button className={quiet}>{domain.active ? 'Pause' : 'Resume'}</button>
                </form>
              </div>

              {!domain.connected && (
                <p className="px-6 pb-3 text-dim">
                  Add <code className="text-ink">{domain.expects}</code> to <code>.env</code> and
                  restart. Until then this domain sends as a dry run. The key never goes in the
                  database.
                </p>
              )}

              {mine.map((box) => {
                const today = warmupCap(box.cap, domain.warmingDay)
                return (
                  <div
                    key={box.id}
                    className="flex items-center gap-3 border-t border-line bg-raise/40 px-6 py-2"
                  >
                    <span className="min-w-0 flex-1 truncate pl-6 text-dim">{box.email}</span>
                    {box.sendsCatchAll && <Stamp tone="catch_all">catch all</Stamp>}
                    {box.halted && <Stamp tone="halted">halted</Stamp>}
                    <Bar value={box.sentToday / Math.max(today, 1)} danger={box.halted} />
                    <span className="w-28 text-right tabular-nums text-dim">
                      {box.sentToday}/{today}
                      {today < box.cap && <span className="opacity-60"> of {box.cap}</span>}
                    </span>
                  </div>
                )
              })}
            </section>
          )
        })}

        {domains.length === 0 && (
          <Empty title="No mailboxes yet" note={<code>npm run db:seed adds the first two.</code>} />
        )}

        <p className="p-6 text-dim">
          Before any of this sends for real: SPF, DKIM and DMARC on each domain. Warm-up then runs
          itself — about five a day climbing to the configured cap over three weeks.
        </p>
      </div>
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
        </>
      }
    >
      <Ledger>
        {blocks.map((row) => (
          <div key={row.id} className="flex items-center gap-3 border-b border-line px-6 py-3">
            <span className="min-w-0 flex-1 truncate">
              {row.domain ? (
                <span className="font-medium">@{row.domain}</span>
              ) : (
                <span className="text-small text-dim">{row.emailHash?.slice(0, 32)}…</span>
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
      <dt className="text-micro uppercase tracking-[0.14em] text-dim">{label}</dt>
      <dd className="break-words">{value || '—'}</dd>
    </>
  )
}
