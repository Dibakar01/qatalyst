'use client'

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
import { CardStamp } from './ui'

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
}: {
  campaignId?: string
  campaignName?: string
}) {
  const router = useRouter()
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
      name: 'sign',
      hint: 'sign — approve every draft that passed both readers',
      campaign: true,
      run: async () => {
        await approveAllClean(form({ id: campaignId! }))
        return `signed the clean drafts in ${here} — marked ones still need you`
      },
    },
    {
      name: 'post',
      hint: 'post — start sending this letter',
      campaign: true,
      run: async () => {
        await startSending(form({ id: campaignId! }))
        return `${here} is in the post`
      },
    },
    {
      name: 'hold',
      hint: 'hold — stop sending this letter',
      campaign: true,
      run: async () => {
        await pauseSending(form({ id: campaignId! }))
        return `${here} is held`
      },
    },
    {
      name: 'collect',
      hint: 'collect — work one collection right now',
      run: async () => {
        const tick = await sendNow()
        return [
          `${tick.sent} posted${tick.dryRun ? ' (dry run)' : ''}`,
          ...tick.halted.map((email) => `halted ${email}`),
          ...tick.detail,
        ]
          .slice(0, 3)
          .join(' · ')
      },
    },
    {
      name: 'find',
      hint: 'find <text> — search the address book',
      needs: 'something to search for',
      run: (arg) => router.push(`/?view=book&q=${encodeURIComponent(arg)}`),
    },
    { name: 'book', hint: 'book — the whole address book', run: () => router.push('/?view=book') },
    {
      name: 'import',
      hint: 'import — take in a CSV of addresses',
      run: () => router.push('/?view=book&panel=import'),
    },
    {
      name: 'suppress',
      hint: 'suppress <email> — never write to this address again',
      needs: 'an address',
      run: async (arg) => {
        await suppressEmail(form({ email: arg }))
        return `${arg} added to the returned register`
      },
    },
    {
      name: 'block',
      hint: 'block <domain> — return everything from a whole domain',
      needs: 'a domain',
      run: async (arg) => {
        await blockDomain(form({ domain: arg, reason: 'manual' }))
        return `@${arg.replace(/^@/, '')} blocked`
      },
    },
    { name: 'boxes', hint: 'boxes — the post boxes we send from', run: () => router.push('/?view=boxes') },
    {
      name: 'returned',
      hint: 'returned — everyone we may never write to',
      run: () => router.push('/?view=returned'),
    },
    { name: 'desk', hint: 'desk — back to the letters on the desk', run: () => router.push('/') },
  ]

  const [head = '', ...rest] = text.trim().split(/\s+/)
  const arg = rest.join(' ')
  const typing = rest.length === 0 && !text.endsWith(' ')
  const matches = typing && head ? commands.filter((c) => c.name.startsWith(head)) : []
  const exact = commands.find((c) => c.name === head)
  const chosen = matches[Math.min(pick, Math.max(matches.length - 1, 0))]

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
    // search, because that is what a bare word usually means.
    const cmd = exact ?? chosen
    if (!cmd) {
      router.push(`/?view=book&q=${encodeURIComponent(trimmed)}`)
      setText('')
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
    <div className="relative shrink-0 border-t border-card-line/70 px-5 py-2.5">
      {matches.length > 0 && (
        <ul className="card absolute inset-x-5 bottom-full mb-2 overflow-hidden rounded-[6px]">
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
                className={`block w-full px-4 py-2 text-left font-mono text-[12px] transition-colors ${
                  cmd === chosen ? 'bg-white/[0.07] text-card-ink' : 'text-card-dim hover:text-card-ink'
                }`}
              >
                {cmd.hint}
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-center gap-2.5">
        <span
          className={`font-mono text-[13px] ${busy ? 'animate-pulse text-card-ink' : 'text-card-dim'}`}
          aria-hidden
        >
          {busy ? '•••' : '›'}
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
          placeholder="write · sign · post · collect · find someone — or ⌘K"
          aria-label="Command"
          className="min-w-0 flex-1 bg-transparent font-mono text-[12.5px] text-card-ink outline-none placeholder:font-sans placeholder:text-card-dim/80"
        />

        {log.length > 0 && (
          <p className="hidden min-w-0 max-w-[46%] truncate text-right font-mono text-[11px] text-card-dim md:block">
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
 * The one thing here you cannot work out by looking at a list.
 *
 * Everything else — who is written to, what is signed, what went out — is a
 * count you can read off a page. The allowance is different: it is a function
 * of the clock. The day's postage is released evenly across the window, so
 * "how much may go out right now" changes every minute and is nothing outside
 * 09:00 to 17:00. Without this, an idle machine looks exactly like a broken one.
 *
 * The number comes from the same allowanceNow() the sender uses, so this is not
 * a second opinion about the rule — it is the rule, drawn.
 */
export function Meter({ boxes }: { boxes: Box[] }) {
  // Rendered on the server too, where "now" is a different instant. Starting at
  // null and filling in on mount keeps the markup identical on both sides.
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

  const live = boxes.filter((box) => box.active && !box.halted)
  const cap = live.reduce((total, box) => total + box.cap, 0)
  const sentToday = boxes.reduce((total, box) => total + box.sentToday, 0)

  if (minute === null) return <div className="h-[150px] animate-pulse rounded-[3px] bg-white/[0.04]" />

  const owed = live.reduce((total, box) => total + allowanceNow(box.cap, box.sentToday, minute), 0)
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
        <span className="font-serif text-[30px] leading-none text-card-ink">{owed}</span>
        <span className="min-w-0 flex-1 leading-tight text-card-dim">
          {owed === 1 ? 'may go out now' : 'may go out now'}
        </span>
        <span className="font-mono text-[11px] text-card-dim">{clock(minute)}</span>
      </div>

      <svg
        viewBox={`0 0 ${SPAN} 116`}
        className="mt-2 w-full"
        role="img"
        aria-label={`${owed} may go out at ${clock(minute)}`}
      >
        {/* Hour marks. The window is the only part of the day that exists here. */}
        {Array.from({ length: 5 }, (_, i) => WINDOW.start + (i * SPAN) / 4).map((m) => (
          <g key={m}>
            <line
              x1={m - WINDOW.start}
              y1={top}
              x2={m - WINDOW.start}
              y2={top + plot}
              stroke="#2b2b30"
              strokeWidth="1"
            />
            <text
              x={m - WINDOW.start}
              y={108}
              fill="#8a8a8f"
              fontSize="11"
              fontFamily="var(--font-plex-mono)"
              textAnchor="middle"
            >
              {clock(m)}
            </text>
          </g>
        ))}

        {/* The release ramp: how much postage each moment has unlocked. */}
        <line x1="0" y1={y(0)} x2={SPAN} y2={y(cap)} stroke="#8f8fff" strokeWidth="1.5" opacity="0.45" />

        {/* What has actually gone out. The gap up to the ramp is the debt. */}
        <line x1="0" y1={y(sentToday)} x2={x} y2={y(sentToday)} stroke="#f3f1ed" strokeWidth="1.5" />

        {!outside && (
          <>
            <rect x={x - 0.5} y={top} width="1" height={plot} fill="#f3f1ed" opacity="0.2" />
            <line x1={x} y1={y(sentToday)} x2={x} y2={y(unlocked)} stroke="#8f8fff" strokeWidth="3" />
            <circle cx={x} cy={y(unlocked)} r="3.5" fill="#8f8fff" />
          </>
        )}
        <circle cx={x} cy={y(sentToday)} r="3.5" fill="#f3f1ed" />
      </svg>

      <p className="text-card-dim">
        {outside
          ? `Outside ${clock(WINDOW.start)}–${clock(WINDOW.end)}, so nothing may go out${before ? ' yet' : ' today'}. Waiting is the rule working.`
          : `${sentToday} of ${cap} posted today, released evenly across the window.`}
      </p>

      <div className="mt-3.5 space-y-2">
        {boxes.map((box) => {
          const allowance =
            box.active && !box.halted ? allowanceNow(box.cap, box.sentToday, minute) : 0
          return (
            <div key={box.id} className="flex items-center gap-2" title={box.email}>
              <span className="min-w-0 flex-1 truncate text-card-ink">{box.email.split('@')[0]}</span>
              {box.halted ? (
                <CardStamp tone="halted">halted</CardStamp>
              ) : !box.active ? (
                <CardStamp tone="paused">paused</CardStamp>
              ) : box.sendsCatchAll ? (
                <CardStamp tone="catch_all">catch all</CardStamp>
              ) : null}
              <span className="font-mono text-[11px] text-card-dim">
                {box.sentToday}/{box.cap}
              </span>
              <span
                className={`w-7 text-right font-mono text-[11px] ${allowance > 0 ? 'text-[#8f8fff]' : 'text-card-dim/60'}`}
              >
                {allowance > 0 ? `+${allowance}` : '—'}
              </span>
            </div>
          )
        })}
      </div>
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
        className="w-full border-0 border-b border-rule bg-transparent py-1.5 pl-6 transition-colors placeholder:text-dim/70 focus:border-ink"
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
      className={`rounded-[3px] border py-1.5 pl-2 pr-7 capitalize transition-colors ${
        value ? 'border-ink bg-ink text-paper' : 'border-rule bg-transparent text-dim hover:text-ink'
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
      className="px-1 py-1.5 text-dim underline-offset-4 transition-colors hover:text-ink hover:underline"
    >
      Clear
    </button>
  )
}
