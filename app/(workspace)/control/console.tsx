'use client'

import { useActionState, useEffect, useState } from 'react'
import { allowanceNow, WINDOW } from '@/lib/rules'
import type { TickResult } from '@/lib/send'
import { sendNow } from '../actions'
import { accent, ghost, Pill } from '../ui'

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
const clock = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`

/**
 * The one thing in this system you cannot work out by looking at a list.
 *
 * Everything else — who is written to, what is approved, what went out — is a
 * count you can read off a table. The allowance is different: it is a function
 * of the clock. The daily cap is released evenly across the window, so "how
 * many may go out right now" changes every minute and is zero outside 09:00 to
 * 17:00. Without this, an idle sender is indistinguishable from a broken one.
 *
 * The number is computed here with the same allowanceNow() the sender uses, so
 * this is not a second opinion about the rule — it is the rule, drawn.
 */
export function Valve({ boxes }: { boxes: Box[] }) {
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

  if (minute === null) {
    return <div className="h-[236px] animate-pulse rounded-xl border border-line bg-raised/30" />
  }

  const owed = live.reduce(
    (total, box) => total + allowanceNow(box.cap, box.sentToday, minute),
    0,
  )
  const before = minute < WINDOW.start
  const after = minute >= WINDOW.end
  const outside = before || after

  // One unit of the viewBox per minute of the window, so nothing has to be
  // rescaled to be read against the clock.
  const top = 12
  const plot = 78
  const ceiling = Math.max(cap, sentToday, 1)
  const y = (value: number) => top + plot * (1 - value / ceiling)
  const x = Math.min(Math.max(minute - WINDOW.start, 0), SPAN)
  const unlocked = outside ? (after ? cap : 0) : Math.floor((cap * x) / SPAN)

  return (
    <div className="overflow-hidden rounded-xl border border-line bg-surface/50">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-line px-4 py-3">
        <span className="text-[28px] font-semibold leading-none tracking-[-0.02em] text-accent">
          {owed}
        </span>
        <span className="font-medium">
          {owed === 1 ? 'send is owed right now' : 'sends are owed right now'}
        </span>
        <span className="ml-auto text-muted">
          {clock(minute)} · {sentToday} of {cap} sent today
        </span>
      </div>

      <svg viewBox={`0 0 ${SPAN} 120`} className="w-full" role="img" aria-label={`${owed} sends owed at ${clock(minute)}`}>
        {/* Hour grid. The window is the only part of the day that exists here. */}
        {Array.from({ length: 5 }, (_, i) => WINDOW.start + (i * SPAN) / 4).map((m) => (
          <g key={m}>
            <line x1={m - WINDOW.start} y1={top} x2={m - WINDOW.start} y2={top + plot} stroke="#1f242b" strokeWidth="1" />
            <text x={m - WINDOW.start} y={112} fill="#868d97" fontSize="11" textAnchor="middle">
              {clock(m)}
            </text>
          </g>
        ))}

        {/* The release ramp: how many sends are unlocked by each moment. */}
        <line x1="0" y1={y(0)} x2={SPAN} y2={y(cap)} stroke="#9adc70" strokeWidth="1.5" opacity="0.5" />

        {/* What has actually gone out. The vertical gap to the ramp is the debt. */}
        <line x1="0" y1={y(sentToday)} x2={x} y2={y(sentToday)} stroke="#fefefe" strokeWidth="1.5" />

        {!outside && (
          <>
            <rect x={x - 0.5} y={top} width="1" height={plot} fill="#fefefe" opacity="0.25" />
            <line x1={x} y1={y(sentToday)} x2={x} y2={y(unlocked)} stroke="#9adc70" strokeWidth="3" />
            <circle cx={x} cy={y(unlocked)} r="3.5" fill="#9adc70" />
          </>
        )}
        <circle cx={x} cy={y(sentToday)} r="3.5" fill="#fefefe" />
      </svg>

      {outside && (
        <p className="border-t border-line px-4 py-2.5 text-muted">
          Outside the {clock(WINDOW.start)}–{clock(WINDOW.end)} window, so nothing may go out
          {before ? ' yet' : ' today'}. The sender is not stuck — it is waiting, which is the rule
          working.
        </p>
      )}

      <div className="border-t border-line">
        {boxes.map((box) => {
          const allowance =
            box.active && !box.halted ? allowanceNow(box.cap, box.sentToday, minute) : 0
          return (
            <div
              key={box.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-4 py-2.5 last:border-b-0"
            >
              <span className="min-w-0 flex-1 truncate font-medium">{box.email}</span>
              {box.sendsCatchAll && <Pill tone="catch_all">catch-all</Pill>}
              {box.halted ? (
                <Pill tone="bounced">halted</Pill>
              ) : !box.active ? (
                <Pill>paused</Pill>
              ) : null}
              <span className="text-muted">
                {box.bounceRate > 0 && `${(box.bounceRate * 100).toFixed(1)}% bounce · `}
                {box.sentToday}/{box.cap} today
              </span>
              <span
                className={`w-16 text-right font-medium ${allowance > 0 ? 'text-accent' : 'text-muted'}`}
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

/**
 * The lever. `npm run send` does this on a timer; pressing it here runs exactly
 * one tick and shows what the sender decided, which is the only way to watch
 * the rules make a decision without waiting a minute for the worker.
 */
export function RunTick({ armed }: { armed: boolean }) {
  const [result, run, pending] = useActionState<TickResult | null, FormData>(
    async () => sendNow(),
    null,
  )

  return (
    <form action={run} className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <button className={armed ? accent : ghost} disabled={pending}>
          {pending ? 'Running…' : 'Run one tick now'}
        </button>
        <span className="text-muted">
          {armed
            ? 'At most one send per mailbox, and only what the allowance permits.'
            : 'Nothing is approved and sending, so a tick will do nothing.'}
        </span>
      </div>

      {result && (
        <div className="rounded-xl border border-line bg-surface/50">
          <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
            <span className="font-medium">
              {result.sent} {result.sent === 1 ? 'send' : 'sends'}
            </span>
            {result.dryRun && <Pill tone="catch_all">dry run</Pill>}
            {result.halted.map((email) => (
              <Pill key={email} tone="bounced">{`halted ${email}`}</Pill>
            ))}
          </div>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap px-4 py-2.5 font-mono text-[12px] text-muted">
            {result.detail.length > 0
              ? result.detail.join('\n')
              : 'Nothing was eligible this tick.'}
          </pre>
        </div>
      )}
    </form>
  )
}
