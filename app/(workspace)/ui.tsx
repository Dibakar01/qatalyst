import Link from 'next/link'

/* ── Stamps ───────────────────────────────────────────────────────────────────
   With two colours the vocabulary has to be small and absolute:

     red   something is wrong, or wants a person
     ink   settled, correct, nothing to do
     dim   not started

   That is the whole scheme. A screen with no red on it needs nothing from you,
   which is a thing you can check from across the room. */

const MARK: Record<string, string> = {
  invalid: 'text-primary',
  bounced: 'text-primary',
  halted: 'text-primary',
  suppressed: 'text-primary',
  flagged: 'text-primary',
  catch_all: 'text-primary',
  competitor: 'text-primary',
  customer: 'text-primary',
  manual: 'text-primary',
  unsubscribed: 'text-primary',

  draft: 'text-dim',
  unverified: 'text-dim',
  paused: 'text-dim',
  none: 'text-dim',
}

export function Stamp({ children, tone }: { children: string; tone?: string }) {
  return (
    <span className={`stamp inline-block shrink-0 ${MARK[tone ?? children] ?? 'text-ink'}`}>
      {children.replace(/_/g, ' ')}
    </span>
  )
}

/** Small struck label. The only typographic ornament in the app. */
export function Label({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[9.5px] font-medium uppercase tracking-[0.16em] text-dim">{children}</p>
  )
}

/**
 * A working surface, set down over the stage. Everything except the letter
 * itself lives on one of these, and every one of them opens the same way: what
 * this is, what it is called, and what you can do to it.
 */
export function Sheet({
  label,
  title,
  note,
  actions,
  children,
}: {
  label: string
  title: React.ReactNode
  note?: React.ReactNode
  actions?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="panel grain relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-[10px]">
      <header className="flex shrink-0 items-end justify-between gap-4 border-b border-line px-7 pb-4 pt-6">
        <div className="min-w-0">
          <Label>{label}</Label>
          <h1 className="mt-1.5 truncate text-[25px] font-medium leading-[1.1] tracking-[-0.028em]">
            {title}
          </h1>
          {note ? <p className="mt-1 text-dim">{note}</p> : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2 pb-1">{actions}</div> : null}
      </header>
      {children}
    </section>
  )
}

/**
 * Rows, and never more than fit.
 *
 * Nothing on this desk scrolls. A list that is longer than the space is paged,
 * not scrolled — which means the page size has to be a decision rather than a
 * consequence, and the row height below is that decision.
 */
export function Ledger({ children }: { children: React.ReactNode }) {
  return <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
}

/** How many rows fit a panel. A page size is a decision, so it is written down. */
export const ROWS = 12

/** Where you are in a run of four, and a way to jump. */
export function Stepper({
  at,
  steps,
  href,
}: {
  at: number
  steps: readonly string[]
  href: (step: number) => string
}) {
  return (
    <nav className="flex shrink-0 items-center gap-1 border-t border-line px-7 py-3">
      {steps.map((name, index) => {
        const n = index + 1
        const on = n === at
        return (
          <Link
            key={name}
            href={href(n)}
            aria-current={on ? 'step' : undefined}
            className={`flex items-center gap-2 rounded-[5px] px-2.5 py-1.5 transition-colors ${
              on ? 'bg-primary text-secondary' : 'text-dim hover:bg-raise hover:text-ink'
            }`}
          >
            <span className="text-[10px] tabular-nums opacity-70">{n}</span>
            {name}
          </Link>
        )
      })}
    </nav>
  )
}

/** Prev and next through whatever the search matched. */
export function Pager({
  page,
  pages,
  href,
  note,
}: {
  page: number
  pages: number
  href: (page: number) => string
  note?: React.ReactNode
}) {
  const arrow =
    'rounded-[5px] border border-line px-2.5 py-1 transition-colors hover:border-ink/40 hover:bg-raise'
  const dead = 'rounded-[5px] border border-line/60 px-2.5 py-1 text-dim/40'
  return (
    <div className="flex shrink-0 items-center gap-3 border-t border-line px-7 py-2.5">
      {note ? <span className="min-w-0 flex-1 truncate text-dim">{note}</span> : <span className="flex-1" />}
      <span className="text-dim tabular-nums">
        {page} of {pages}
      </span>
      {page > 1 ? (
        <Link href={href(page - 1)} className={arrow} rel="prev">
          ‹
        </Link>
      ) : (
        <span className={dead}>‹</span>
      )}
      {page < pages ? (
        <Link href={href(page + 1)} className={arrow} rel="next">
          ›
        </Link>
      ) : (
        <span className={dead}>›</span>
      )}
    </div>
  )
}

export function Empty({ title, note }: { title: string; note: React.ReactNode }) {
  return (
    <div className="grid flex-1 place-items-center px-7 py-16 text-center">
      <div className="max-w-sm">
        <p className="text-[18px] font-medium tracking-[-0.02em]">{title}</p>
        <p className="mt-1.5 text-dim">{note}</p>
      </div>
    </div>
  )
}

/** The plane above everything. Nothing stacks above this. */
export function Drawer({
  title,
  label,
  closeHref,
  wide,
  children,
}: {
  title: string
  label: string
  closeHref: string
  wide?: boolean
  children: React.ReactNode
}) {
  return (
    <div className="fixed inset-0 z-50">
      <Link href={closeHref} aria-label="Close" className="veil-in absolute inset-0 bg-black/55" />
      <div
        className={`panel-in panel grain absolute right-3 top-3 flex h-[calc(100%-1.5rem)] w-[calc(100%-1.5rem)] flex-col overflow-hidden rounded-[10px] ${
          wide ? 'max-w-3xl' : 'max-w-lg'
        }`}
      >
        <div className="flex shrink-0 items-end justify-between border-b border-line px-7 pb-4 pt-6">
          <div>
            <Label>{label}</Label>
            <h2 className="mt-1.5 text-[20px] font-medium leading-tight tracking-[-0.025em]">
              {title}
            </h2>
          </div>
          <Link
            href={closeHref}
            aria-label="Close"
            className="grid size-7 place-items-center rounded-full border border-line text-dim transition-colors hover:border-primary hover:text-primary"
          >
            ✕
          </Link>
        </div>
        <div className="quiet-scroll min-h-0 flex-1 px-7 py-6">{children}</div>
      </div>
    </div>
  )
}

/* ── Controls ─────────────────────────────────────────────────────────────────
   Exactly one red button on a surface: the thing that surface is for. */

export const go =
  'inline-flex items-center justify-center rounded-[5px] bg-primary px-4 py-2 font-medium text-secondary transition-[filter,opacity] hover:brightness-110 disabled:opacity-30 disabled:hover:brightness-100'

/** Commit what is on screen. Never red — a save is not a forward action. */
export const ink =
  'inline-flex items-center justify-center rounded-[5px] bg-ink px-4 py-2 font-medium text-ground transition-opacity hover:opacity-85 disabled:opacity-25'

export const quiet =
  'inline-flex items-center justify-center rounded-[5px] border border-line px-4 py-2 font-medium transition-colors hover:border-ink/40 hover:bg-raise'

/** Destructive. Outlined rather than filled, so it can never be the fast path. */
export const stop =
  'inline-flex items-center justify-center rounded-[5px] border border-primary/40 px-4 py-2 font-medium text-primary transition-colors hover:bg-primary/[0.07]'

export const field =
  'w-full rounded-[4px] border border-line bg-raise px-2.5 py-2 transition-colors placeholder:text-dim/70 focus:border-primary'

/** A line ruled under an entry, rather than a box drawn around it. */
export const ruled =
  'w-full border-0 border-b border-line bg-transparent px-0 py-1.5 transition-colors placeholder:text-dim/70 focus:border-primary'
