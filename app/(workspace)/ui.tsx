import Link from 'next/link'

/* ── Stamps ───────────────────────────────────────────────────────────────────
   A status is not a badge, it is a mark struck onto the page. Ink colour is the
   whole vocabulary: oxblood stops, mustard asks for a person, blue is in
   motion, and anything settled is plain ink. Nothing is coloured for decoration,
   so a page with no colour on it is a page with nothing wrong. */

const INK: Record<string, string> = {
  invalid: 'text-stop',
  bounced: 'text-stop',
  halted: 'text-stop',
  suppressed: 'text-stop',
  flagged: 'text-mark',
  catch_all: 'text-mark',
  draft: 'text-dim',
  unverified: 'text-dim',
  paused: 'text-dim',
  sending: 'text-go',
  opted_in: 'text-go',
  verified: 'text-ink',
  approved: 'text-ink',
  sent: 'text-ink',
  ready: 'text-ink',
  done: 'text-ink',
}

export function Stamp({ children, tone }: { children: string; tone?: string }) {
  return (
    <span className={`stamp inline-block shrink-0 ${INK[tone ?? children] ?? 'text-dim'}`}>
      {children.replace(/_/g, ' ')}
    </span>
  )
}

/** The same mark, struck on the dark card rather than on paper. */
export function CardStamp({ children, tone }: { children: string; tone?: string }) {
  const ink =
    INK[tone ?? children] === 'text-stop'
      ? 'text-[#E8837B]'
      : INK[tone ?? children] === 'text-mark'
        ? 'text-[#E0B45E]'
        : INK[tone ?? children] === 'text-go'
          ? 'text-[#8F8FFF]'
          : 'text-card-dim'
  return <span className={`stamp inline-block shrink-0 ${ink}`}>{children.replace(/_/g, ' ')}</span>
}

/* ── The sheet ────────────────────────────────────────────────────────────────
   Every view is one sheet of paper on the stage. It always opens with a
   letterhead — a small struck label saying what this page is, the title in the
   serif, and a rule under it — so you always know which page you are holding. */

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
    <article className="sheet grain relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-[4px]">
      <header className="flex shrink-0 items-end justify-between gap-4 border-b border-rule px-8 pb-4 pt-7">
        <div className="min-w-0">
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-dim">{label}</p>
          <h1 className="mt-1.5 truncate font-serif text-[27px] leading-[1.1] tracking-[-0.01em]">
            {title}
          </h1>
          {note ? <p className="mt-1 text-dim">{note}</p> : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2 pb-1">{actions}</div> : null}
      </header>
      {children}
    </article>
  )
}

/**
 * One numbered clause of a docket. The number is set in the margin the way a
 * printed form numbers its sections, so the eye can run down the left edge and
 * find step three without reading anything.
 */
export function Clause({
  n,
  title,
  note,
  children,
}: {
  n: number
  title: string
  note?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="border-b border-rule/70 px-8 py-7 last:border-b-0">
      <div className="mb-4 flex items-baseline gap-3">
        <span className="w-4 shrink-0 font-mono text-[11px] text-dim">{n}</span>
        <h2 className="font-serif text-[19px] leading-none">{title}</h2>
        {note ? <span className="text-dim">{note}</span> : null}
      </div>
      <div className="pl-7">{children}</div>
    </section>
  )
}

/** Ruled lines, the way a ledger is ruled. Rows sit in it, nothing else. */
export function Ledger({ children }: { children: React.ReactNode }) {
  return <div className="min-h-0 flex-1 overflow-auto">{children}</div>
}

export function Empty({ title, note }: { title: string; note: React.ReactNode }) {
  return (
    <div className="grid flex-1 place-items-center px-8 py-20 text-center">
      <div className="max-w-sm">
        <p className="font-serif text-[21px]">{title}</p>
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
      <Link href={closeHref} aria-label="Close" className="veil-in absolute inset-0 bg-stage/75" />
      <div
        className={`panel-in sheet grain absolute right-3 top-3 flex h-[calc(100%-1.5rem)] w-[calc(100%-1.5rem)] flex-col overflow-hidden rounded-[4px] ${
          wide ? 'max-w-3xl' : 'max-w-lg'
        }`}
      >
        <div className="flex shrink-0 items-end justify-between border-b border-rule px-7 pb-4 pt-6">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-dim">{label}</p>
            <h2 className="mt-1 font-serif text-[22px] leading-tight">{title}</h2>
          </div>
          <Link
            href={closeHref}
            aria-label="Close"
            className="grid size-7 place-items-center rounded-full border border-rule text-dim transition-colors hover:border-ink hover:text-ink"
          >
            ✕
          </Link>
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-7 py-6">{children}</div>
      </div>
    </div>
  )
}

/* ── Controls ─────────────────────────────────────────────────────────────────
   Squared off, because everything here is printed matter. There is exactly one
   blue button on any sheet — the thing this page is for. */

/** The one forward action on a sheet: write, approve, send. */
export const go =
  'inline-flex items-center justify-center rounded-[4px] bg-go px-4 py-2 font-medium text-white transition-[filter,opacity] hover:brightness-115 disabled:opacity-30 disabled:hover:brightness-100'

/** Commit what is on screen. Never blue — a save is not a forward action. */
export const ink =
  'inline-flex items-center justify-center rounded-[4px] bg-ink px-4 py-2 font-medium text-paper transition-opacity hover:opacity-85 disabled:opacity-25'

export const quiet =
  'inline-flex items-center justify-center rounded-[4px] border border-rule px-4 py-2 font-medium transition-colors hover:border-ink/40 hover:bg-ink/[0.04]'

export const stop =
  'inline-flex items-center justify-center rounded-[4px] border border-stop/35 px-4 py-2 font-medium text-stop transition-colors hover:bg-stop/[0.06]'

export const field =
  'w-full rounded-[3px] border border-rule bg-white/60 px-2.5 py-2 transition-colors placeholder:text-dim/70 focus:border-ink/50'

/** A line ruled under handwriting, rather than a box drawn around it. */
export const ruled =
  'w-full border-0 border-b border-rule bg-transparent px-0 py-1.5 transition-colors placeholder:text-dim/60 focus:border-ink focus:ring-0'
