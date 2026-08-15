'use client'

import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useEffect, useRef, useState, useTransition } from 'react'
import { allowanceNow, WINDOW } from '@/lib/rules'
import {
  approveAllClean,
  blockDomain,
  generateAction,
  newCampaign,
  pauseSending,
  sendNow,
  startSending,
  suppressEmail,
} from './actions'

/* ── The command line ─────────────────────────────────────────────────────────
   Every button on the paper has a word here, and both post to the same server
   action. Nothing is reachable only by typing — this is the fast way to the one
   way, never a second one. */

type Cmd = {
  name: string
  hint: string
  /** Refuses to run unless a campaign is open, because it acts on one. */
  campaign?: boolean
  /** Won't run on an empty argument. */
  needs?: string
  run: (arg: string) => Promise<string | void> | string | void
}

const form = (entries: Record<string, string>) => {
  const data = new FormData()
  for (const [key, value] of Object.entries(entries)) data.append(key, value)
  return data
}

export function CommandBar({
  campaignId,
  campaignName,
  listed = false,
}: {
  campaignId?: string
  campaignName?: string
  /** Whether the stack is currently shown as a list. */
  listed?: boolean
}) {
  const router = useRouter()
  const params = useSearchParams()
  const [text, setText] = useState('')
  const [log, setLog] = useState<string[]>([])
  const [pick, setPick] = useState(0)
  const [busy, start] = useTransition()
  const box = useRef<HTMLInputElement>(null)

  // Newest first, three deep. The console says what it just did; the meter and
  // the tally are the real readout, so this never needs to be a log viewer.
  const say = (...lines: string[]) => setLog((prev) => [...lines, ...prev].slice(0, 3))
  const here = campaignName ?? 'this letter'

  const commands: Cmd[] = [
    {
      name: 'new',
      hint: 'new <name> — start a new letter',
      needs: 'a name',
      run: (arg) => void newCampaign(form({ name: arg })),
    },
    {
      name: 'write',
      hint: 'write [n] — draft the next n, 25 by default',
      campaign: true,
      run: async (arg) => {
        await generateAction(form({ id: campaignId!, n: arg }))
        return `drafted for ${here}`
      },
    },
    {
      name: 'approve',
      hint: 'approve — approve every draft that passed both readers',
      campaign: true,
      run: async () => {
        await approveAllClean(form({ id: campaignId! }))
        return `approved the clean drafts in ${here} — flagged ones still need you`
      },
    },
    {
      name: 'send',
      hint: 'send — start sending this letter',
      campaign: true,
      run: async () => {
        await startSending(form({ id: campaignId! }))
        return `${here} is sending`
      },
    },
    {
      name: 'pause',
      hint: 'pause — stop sending this letter',
      campaign: true,
      run: async () => {
        await pauseSending(form({ id: campaignId! }))
        return `${here} is paused`
      },
    },
    {
      name: 'sendnow',
      hint: 'sendnow — work one send right now, by hand',
      run: async () => {
        const tick = await sendNow()
        return [
          `${tick.sent} sent${tick.dryRun ? ' (dry run)' : ''}`,
          ...tick.halted.map((email) => `halted ${email}`),
          ...tick.detail,
        ]
          .slice(0, 3)
          .join(' · ')
      },
    },
    {
      name: 'find',
      hint: 'find <text> — search contacts',
      needs: 'something to search for',
      run: (arg) => router.push(`/?view=book&q=${encodeURIComponent(arg)}`),
    },
    { name: 'contacts', hint: 'contacts — everyone we may write to', run: () => router.push('/?view=book') },
    {
      name: 'import',
      hint: 'import — take in a CSV of contacts',
      run: () => router.push('/?view=book&panel=import'),
    },
    {
      name: 'suppress',
      hint: 'suppress <email> — never send to this address again',
      needs: 'an address',
      run: async (arg) => {
        await suppressEmail(form({ email: arg }))
        return `${arg} will never be sent to`
      },
    },
    {
      name: 'block',
      hint: 'block <domain> — never send to a whole domain',
      needs: 'a domain',
      run: async (arg) => {
        await blockDomain(form({ domain: arg, reason: 'manual' }))
        return `@${arg.replace(/^@/, '')} blocked`
      },
    },
    { name: 'senders', hint: 'senders — the mailboxes we send from', run: () => router.push('/?view=boxes') },
    {
      name: 'blocked',
      hint: 'blocked — everyone we may never send to',
      run: () => router.push('/?view=returned'),
    },
    { name: 'list', hint: 'list — every letter, as a list', run: () => router.push('/?as=list') },
    { name: 'letters', hint: 'letters — back to the stack', run: () => router.push('/') },
  ]

  const [head = '', ...rest] = text.trim().split(/\s+/)
  const arg = rest.join(' ')
  const typing = rest.length === 0 && !text.endsWith(' ')
  // Capped: the list pops upward out of a fixed bar, so it may never be taller
  // than the room above it.
  const matches = (typing && head ? commands.filter((c) => c.name.startsWith(head)) : []).slice(0, 6)
  const exact = commands.find((c) => c.name === head)
  const chosen = matches[Math.min(pick, Math.max(matches.length - 1, 0))]

  // Typing something that is not a command turns the stack into the list,
  // narrowed to what you typed. That is the whole point of the bar being where
  // it is: you type, and the letters you can see become the ones you meant.
  //
  // The guard makes it converge — once the URL matches what is typed, nothing
  // more is scheduled.
  const finding = text.trim()
  const already = listed && (params.get('find') ?? '') === finding
  useEffect(() => {
    if (matches.length > 0 || exact || already) return
    // An empty bar on the stack is the resting state, not a search for nothing.
    if (!finding && !listed) return
    const timer = setTimeout(() => {
      router.replace(finding ? `/?as=list&find=${encodeURIComponent(finding)}` : '/', {
        scroll: false,
      })
    }, 250)
    return () => clearTimeout(timer)
  })

  // ⌘K from anywhere. There is one screen, so the shortcut cannot mean
  // something different somewhere else.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'k') {
        event.preventDefault()
        box.current?.focus()
        box.current?.select()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  function submit() {
    const trimmed = text.trim()
    if (!trimmed || busy) return

    // A whole command, or enough of one to be unambiguous. Anything else is a
    // search for a letter — which the effect above has already run; pressing
    // enter just skips the wait. The text stays, because it is what the list
    // is currently narrowed by.
    const cmd = exact ?? chosen
    if (!cmd) {
      router.push(`/?as=list&find=${encodeURIComponent(trimmed)}`)
      return
    }
    if (cmd.campaign && !campaignId) return say(`${cmd.name} acts on a letter — open one first`)
    if (cmd.needs && !arg) return say(`${cmd.name} needs ${cmd.needs}`)

    setText('')
    start(async () => {
      try {
        const line = await cmd.run(arg)
        if (line) say(line)
      } catch (cause) {
        say(cause instanceof Error ? cause.message : String(cause))
      }
    })
  }

  return (
    <div className="chrome relative z-20 shrink-0 border-t border-line px-6 py-3">
      {matches.length > 0 && (
        <ul className="panel absolute inset-x-5 bottom-full mb-2 overflow-hidden rounded-[6px]">
          {matches.map((cmd, index) => (
            <li key={cmd.name}>
              <button
                type="button"
                onMouseEnter={() => setPick(index)}
                onMouseDown={(event) => {
                  event.preventDefault()
                  setText(`${cmd.name} `)
                  box.current?.focus()
                }}
                className={`block w-full px-3 py-2 text-left text-small transition-colors ${
                  cmd === chosen ? 'bg-raise text-ink' : 'text-dim hover:text-ink'
                }`}
              >
                {cmd.hint}
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-center gap-3">
        {/* What this bar is, before you type anything into it. The stack and the
            list are the same letters — this says so, and switches between them. */}
        <div
          role="group"
          aria-label="How to show the letters"
          className="flex shrink-0 items-center rounded-full border border-line p-0.5"
        >
          {(
            [
              ['/', 'Stack', !listed],
              ['/?as=list', 'List', listed],
            ] as const
          ).map(([href, label, on]) => (
            <Link
              key={label}
              href={href}
              aria-current={on ? 'true' : undefined}
              className={`rounded-full px-3 py-1 transition-colors ${
                on ? 'bg-primary text-secondary' : 'text-dim hover:text-ink'
              }`}
            >
              {label}
            </Link>
          ))}
        </div>

        <span
          className={`shrink-0 text-body ${busy ? 'animate-pulse text-ink' : 'text-dim'}`}
          aria-hidden
        >
          {busy ? '•••' : '⌕'}
        </span>

        <input
          ref={box}
          value={text}
          // Typing changes which commands match, so the highlight goes back to
          // the top with it. Reset here rather than in an effect — this is the
          // only place the typed word can change.
          onChange={(event) => {
            setText(event.target.value)
            setPick(0)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') return submit()
            if (event.key === 'Escape') return setText('')
            if (event.key === 'Tab' && chosen) {
              event.preventDefault()
              setText(`${chosen.name} `)
            }
            if (event.key === 'ArrowDown' && matches.length > 0) {
              event.preventDefault()
              setPick((n) => (n + 1) % matches.length)
            }
            if (event.key === 'ArrowUp' && matches.length > 0) {
              event.preventDefault()
              setPick((n) => (n - 1 + matches.length) % matches.length)
            }
          }}
          placeholder="Find a letter, or type a command"
          aria-label="Find a letter, or type a command"
          className="min-w-0 flex-1 bg-transparent text-small text-ink outline-none placeholder:text-dim/80"
        />

        <kbd className="hidden shrink-0 rounded border border-line px-2 py-0.5 text-micro text-dim sm:block">
          ⌘K
        </kbd>

        {log.length > 0 && (
          <p className="hidden min-w-0 max-w-[46%] truncate text-right text-small text-dim md:block">
            {log[0]}
          </p>
        )}
      </div>
    </div>
  )
}

/* ── The franking meter ───────────────────────────────────────────────────── */

export type Box = {
  id: string
  email: string
  cap: number
  sentToday: number
  sendsCatchAll: boolean
  active: boolean
  halted: boolean
  bounceRate: number
}

const SPAN = WINDOW.end - WINDOW.start
const clock = (m: number) =>
  `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`

/**
 * The clock, once, for everything that depends on it.
 *
 * Rendered on the server too, where "now" is a different instant. Starting at
 * null and filling in on mount keeps the markup identical on both sides.
 */
function useMinute() {
  const [minute, setMinute] = useState<number | null>(null)
  useEffect(() => {
    const read = () => {
      const now = new Date()
      setMinute(now.getHours() * 60 + now.getMinutes())
    }
    read()
    const timer = setInterval(read, 30_000)
    return () => clearInterval(timer)
  }, [])
  return minute
}

const owedNow = (boxes: Box[], minute: number) =>
  boxes
    .filter((box) => box.active && !box.halted)
    .reduce((total, box) => total + allowanceNow(box.cap, box.sentToday, minute), 0)

/**
 * How much may go out this minute, in the strip.
 *
 * This is the one number on the desk you cannot work out by looking at a list.
 * Everything else — who is written to, what is signed, what went out — is a
 * count you can read off a page. The allowance is a function of the clock: the
 * day's postage is released evenly across the window, so it changes every
 * minute and is nothing outside 09:00 to 17:00. Without it an idle machine
 * looks exactly like a broken one.
 */
export function Postage({ boxes }: { boxes: Box[] }) {
  const minute = useMinute()
  if (minute === null) return <span className="text-dim">— owed</span>

  const owed = owedNow(boxes, minute)
  const outside = minute < WINDOW.start || minute >= WINDOW.end
  return (
    <span className={owed > 0 ? 'text-ink' : 'text-dim'}>
      <strong className="font-medium">{owed}</strong> owed
      {outside && <span className="text-dim"> · outside the window</span>}
    </span>
  )
}

/**
 * The same rule, drawn against the clock. The number comes from the same
 * allowanceNow() the sender uses, so this is not a second opinion about the
 * rule — it is the rule, with a shape.
 */
export function Valve({ boxes }: { boxes: Box[] }) {
  const minute = useMinute()
  const live = boxes.filter((box) => box.active && !box.halted)
  const cap = live.reduce((total, box) => total + box.cap, 0)
  const sentToday = boxes.reduce((total, box) => total + box.sentToday, 0)

  // The same three blocks the real thing is made of, at the same sizes. A flat
  // 132px box was shorter than what replaced it, so the whole panel jumped once
  // on hydration — and the chart's height depends on the panel's width, so no
  // single number could have been right. The aspect ratio is the svg's viewBox,
  // which makes the placeholder exactly the right height at any width.
  if (minute === null)
    return (
      <div className="animate-pulse" aria-hidden>
        <div className="h-[30px] w-28 rounded-[4px] bg-raise" />
        <div className="mt-2 w-full rounded-[4px] bg-raise" style={{ aspectRatio: `${SPAN} / 116` }} />
        <div className="mt-1 h-5 w-3/4 rounded-[4px] bg-raise" />
      </div>
    )

  const owed = owedNow(boxes, minute)
  const before = minute < WINDOW.start
  const after = minute >= WINDOW.end
  const outside = before || after

  // One unit of the viewBox per minute of the window, so nothing has to be
  // rescaled to be read against the clock.
  const top = 10
  const plot = 74
  const ceiling = Math.max(cap, sentToday, 1)
  const y = (value: number) => top + plot * (1 - value / ceiling)
  const x = Math.min(Math.max(minute - WINDOW.start, 0), SPAN)
  const unlocked = outside ? (after ? cap : 0) : Math.floor((cap * x) / SPAN)

  return (
    <div>
      <div className="flex items-baseline gap-2">
        <span className="text-display font-medium leading-none tracking-[-0.03em]">{owed}</span>
        <span className="min-w-0 flex-1 text-dim">may go out now</span>
        <span className="text-small tabular-nums text-dim">{clock(minute)}</span>
      </div>

      <svg
        viewBox={`0 0 ${SPAN} 116`}
        className="mt-2 w-full"
        role="img"
        aria-label={`${owed} may go out at ${clock(minute)}`}
      >
        {/* Hour marks. The window is the only part of the day that exists here. */}
        {Array.from({ length: 5 }, (_, i) => WINDOW.start + (i * SPAN) / 4).map((m, i, all) => (
          <g key={m}>
            <line
              x1={m - WINDOW.start}
              y1={top}
              x2={m - WINDOW.start}
              y2={top + plot}
              stroke="var(--color-line)"
              strokeWidth="1"
            />
            {/* The first mark sits at x=0 and the last at the full width, so
                centring their labels puts half of each outside the viewBox —
                09:00 rendered as ":00" and 17:00 as "17:". The two ends anchor
                inward; every mark between still centres on its own line. */}
            <text
              x={m - WINDOW.start}
              y={108}
              fill="var(--color-dim)"
              fontSize="11"
              textAnchor={i === 0 ? 'start' : i === all.length - 1 ? 'end' : 'middle'}
            >
              {clock(m)}
            </text>
          </g>
        ))}

        {/* The release ramp: how much postage each moment has unlocked. */}
        <line x1="0" y1={y(0)} x2={SPAN} y2={y(cap)} stroke="var(--color-primary)" strokeWidth="1.5" opacity="0.45" />

        {/* What has actually gone out. The gap up to the ramp is the debt. */}
        <line x1="0" y1={y(sentToday)} x2={x} y2={y(sentToday)} stroke="var(--color-ink)" strokeWidth="1.5" />

        {!outside && (
          <>
            <rect x={x - 0.5} y={top} width="1" height={plot} fill="var(--color-ink)" opacity="0.2" />
            <line x1={x} y1={y(sentToday)} x2={x} y2={y(unlocked)} stroke="var(--color-primary)" strokeWidth="3" />
            <circle cx={x} cy={y(unlocked)} r="3.5" fill="var(--color-primary)" />
          </>
        )}
        <circle cx={x} cy={y(sentToday)} r="3.5" fill="var(--color-ink)" />
      </svg>

      <p className="text-dim">
        {outside
          ? `Outside ${clock(WINDOW.start)}–${clock(WINDOW.end)}, so nothing may go out${before ? ' yet' : ' today'}. Waiting is the rule working.`
          : `${sentToday} of ${cap} posted today, released evenly across the window.`}
      </p>
    </div>
  )
}

/* ── Book controls ────────────────────────────────────────────────────────── */

/** Every control writes to the URL. The URL is the only state this desk has. */
function useParamWriter() {
  const params = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()

  return (patch: Record<string, string | undefined>) => {
    const next = new URLSearchParams(params)
    for (const [key, value] of Object.entries(patch)) {
      if (value) next.set(key, value)
      else next.delete(key)
    }
    // Any change to the query puts you back on page one; page 3 of a brand new
    // set of results reads as "my search found nothing".
    next.delete('page')
    const qs = next.toString()
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
  }
}

export function Search({ placeholder = 'Search a name, company or address' }) {
  const params = useSearchParams()
  const write = useParamWriter()
  const [value, setValue] = useState(params.get('q') ?? '')
  const [pending, startSearch] = useTransition()

  // No submit button: results follow typing. The guard makes this converge —
  // once the URL matches what is typed, nothing more is scheduled.
  useEffect(() => {
    if (value === (params.get('q') ?? '')) return
    const timer = setTimeout(() => startSearch(() => write({ q: value || undefined })), 180)
    return () => clearTimeout(timer)
  })

  return (
    <div className="relative flex-1 sm:max-w-xs">
      <svg
        viewBox="0 0 16 16"
        fill="none"
        className={`pointer-events-none absolute left-0 top-1/2 size-3.5 -translate-y-1/2 transition-opacity ${
          pending ? 'opacity-100' : 'opacity-40'
        }`}
      >
        <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.3" />
        <path d="m10.5 10.5 3 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      </svg>
      <input
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className="w-full border-0 border-b border-line bg-transparent py-2 pl-6 transition-colors placeholder:text-dim/70 focus:border-primary"
      />
    </div>
  )
}

export function Filter({
  name,
  label,
  options,
}: {
  name: string
  label: string
  options: readonly string[]
}) {
  const params = useSearchParams()
  const write = useParamWriter()
  const value = params.get(name) ?? ''

  return (
    <select
      value={value}
      aria-label={label}
      onChange={(event) => write({ [name]: event.target.value || undefined })}
      // An applied filter is a state, not an action — it inverts to ink rather
      // than going blue, so it never competes with the one forward button.
      className={`rounded-[3px] border py-2 pl-2 pr-7 capitalize transition-colors ${
        value ? 'border-ink bg-ink text-ground' : 'border-line bg-transparent text-dim hover:text-ink'
      }`}
    >
      <option value="">{label}</option>
      {options.map((option) => (
        <option key={option} value={option}>
          {option.replace('_', ' ')}
        </option>
      ))}
    </select>
  )
}

export function ClearFilters({ active }: { active: boolean }) {
  const write = useParamWriter()
  if (!active) return null
  return (
    <button
      onClick={() => write({ q: undefined, status: undefined, consent: undefined })}
      className="px-2 py-2 text-dim underline-offset-4 transition-colors hover:text-ink hover:underline"
    >
      Clear
    </button>
  )
}
