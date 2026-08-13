import { ViewTransition } from 'react'

// Colour only ever says something: verified reads as go, invalid as stop,
// catch_all as caution, unverified stays neutral because "not checked yet" is
// an absence rather than a warning. The four hues are the brand's own — lime,
// blue, amber — retuned for a dark ground, where saturated fills glare and a
// tinted wash inside a hairline does not.
const TONE: Record<string, string> = {
  verified: 'bg-accent/10 text-accent ring-accent/25',
  approved: 'bg-accent/10 text-accent ring-accent/25',
  sent: 'bg-accent/10 text-accent ring-accent/25',
  opted_in: 'bg-[#0068F7]/15 text-[#7FB0FF] ring-[#0068F7]/30',
  sending: 'bg-[#0068F7]/15 text-[#7FB0FF] ring-[#0068F7]/30',
  catch_all: 'bg-[#FFB62B]/12 text-[#FFC65C] ring-[#FFB62B]/25',
  flagged: 'bg-[#FFB62B]/12 text-[#FFC65C] ring-[#FFB62B]/25',
  invalid: 'bg-[#FF6B6B]/12 text-[#FF8F8F] ring-[#FF6B6B]/25',
  bounced: 'bg-[#FF6B6B]/12 text-[#FF8F8F] ring-[#FF6B6B]/25',
}

export function Pill({ children, tone }: { children: string; tone?: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11.5px] font-medium capitalize ring-1 ring-inset ${
        TONE[tone ?? children] ?? 'bg-raised text-muted ring-line'
      }`}
    >
      {children.replace('_', ' ')}
    </span>
  )
}

/**
 * Every screen is a fixed header over a body that scrolls under it, and every
 * screen crossfades on the way in. Both live here so the four pages cannot
 * drift apart, and so navigation is tuned in one place rather than four.
 */
export function Screen({
  title,
  note,
  actions,
  children,
}: {
  title: React.ReactNode
  note?: React.ReactNode
  actions?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <ViewTransition enter="screen" exit="screen" default="none">
      <div className="flex min-h-0 flex-1 flex-col">
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-line px-6 py-4">
          <div className="min-w-0">
            <h1 className="truncate text-[15px] font-semibold tracking-[-0.01em]">{title}</h1>
            {note ? <p className="mt-0.5 text-muted">{note}</p> : null}
          </div>
          {actions}
        </header>
        {children}
      </div>
    </ViewTransition>
  )
}

export function Step({
  n,
  title,
  note,
  children,
}: {
  n: number
  title: string
  note?: string
  children: React.ReactNode
}) {
  return (
    <section className="border-b border-line px-6 py-6 last:border-b-0">
      <div className="mb-3.5 flex items-baseline gap-2.5">
        <span className="grid size-5 shrink-0 translate-y-0.5 place-items-center rounded-full border border-line text-[10.5px] font-medium text-muted">
          {n}
        </span>
        <h2 className="font-medium">{title}</h2>
        {note ? <span className="text-muted">{note}</span> : null}
      </div>
      <div className="pl-8">{children}</div>
    </section>
  )
}

/** Commit what is on screen. */
export const button =
  'rounded-lg bg-ink px-3.5 py-2 font-medium text-canvas transition-opacity hover:opacity-85 disabled:opacity-25'

/**
 * The one forward action on a screen — write, approve, send. Lime is the go
 * signal everywhere else in the app, so it may never be spent on a save.
 */
export const accent =
  'rounded-lg bg-accent px-3.5 py-2 font-medium text-canvas transition-[filter,opacity] hover:brightness-110 disabled:opacity-25'

export const ghost =
  'rounded-lg border border-line px-3.5 py-2 font-medium transition-colors hover:bg-raised'

export const danger =
  'rounded-lg border border-[#FF6B6B]/30 px-3.5 py-2 font-medium text-[#FF8F8F] transition-colors hover:bg-[#FF6B6B]/10'

export const field =
  'w-full rounded-lg border border-line bg-raised px-2.5 py-2 transition-colors placeholder:text-muted focus:border-accent/40'
