import Link from 'next/link'
import { Fit } from './fit'

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
    <p className="text-micro font-medium uppercase tracking-[0.16em] text-dim">{children}</p>
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
  /** Where the exit goes. The desk unless a panel has somewhere nearer. */
  closeHref = '/',
  children,
}: {
  label: string
  title: React.ReactNode
  note?: React.ReactNode
  actions?: React.ReactNode
  closeHref?: string
  children: React.ReactNode
}) {
  return (
    <section className="panel grain relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-[10px]">
      <header className="flex shrink-0 items-start justify-between gap-4 border-b border-line p-6">
        <div className="min-w-0">
          <Label>{label}</Label>
          <h1 className="mt-1.5 truncate text-title font-medium leading-[1.1] tracking-[-0.028em]">
            {title}
          </h1>
          {/* Always rendered, empty or not. Only four of the twelve surfaces
            carry a note, and its line is the difference between a header 90px
            tall and one 114px tall — so the content under it started 24px
            higher or lower depending on which panel you opened, which is most
            of what "the placements keep changing" was. An empty line costs
            20px and buys every surface opening in the same place. */}
        <p className="mt-1 min-h-5 text-dim">{note}</p>
        </div>

        <div className="flex shrink-0 items-center gap-3">
          {actions}
          {/* The way out lives here rather than in each caller.
              Eleven panels, and seven of them had forgotten one — which is
              what happens when the exit is left to whoever writes the panel.
              Same place on every surface, impossible to omit. */}
          <Link
            href={closeHref}
            aria-label="Close"
            title="Close · esc"
            className="grid size-8 shrink-0 place-items-center rounded-full border border-line text-dim transition-[color,border-color,transform] hover:border-primary hover:text-primary active:scale-95"
          >
            ✕
          </Link>
        </div>
      </header>
      {children}
    </section>
  )
}

/**
 * Rows, and never more than fit.
 *
 * Nothing on this desk scrolls. A list that is longer than the space is paged,
 * not scrolled — which means the page size has to be however many rows fit, and
 * it used to be a hard-coded twelve. Twelve needs about 771px of viewport once
 * everything around it has taken its share, and a 13" laptop has about 760: so
 * the last row was drawn under an `overflow-hidden` that had no scrollbar to
 * admit it, and the pager went on counting it. Ticking a checkbox opened the
 * bulk strip and quietly ate another one.
 *
 * `Fit` measures the real box and a real row and reports back, so the page size
 * is a consequence of the space after all. It keeps a quiet scroll underneath —
 * not because anything should reach it, but because a wrong measurement should
 * cost a scrollbar rather than a row nobody knows is missing.
 */
export function Ledger({ children }: { children: React.ReactNode }) {
  return <Fit>{children}</Fit>
}

/**
 * The franking bars, in HTML.
 *
 * Drawn from the same `frankingCode()` the shader uses, so a row in the list
 * and the envelope on the stage are recognisably the same letter. Bars hang
 * from a common baseline, tall or short by one bit each — identical geometry
 * to the GL version, twelve bars, 45% duty.
 */
export function Franking({ code, className = 'h-2.5 w-9' }: { code: number; className?: string }) {
  return (
    <svg viewBox="0 0 36 10" className={`${className} shrink-0`} aria-hidden preserveAspectRatio="none">
      {Array.from({ length: 12 }, (_, i) => {
        const tall = ((code >> i) & 1) === 1
        const height = tall ? 10 : 5.5
        return (
          <rect key={i} x={i * 3} y={10 - height} width={1.4} height={height} fill="currentColor" />
        )
      })}
    </svg>
  )
}

export type StepState = 'done' | 'now' | 'todo'

/**
 * How far along the letter is, and where you are in it.
 *
 * It guides rather than locks — every step stays clickable — but the shape
 * tells you at a glance what is behind you and what is left.
 */
export function Stepper({
  steps,
  href,
}: {
  steps: readonly { name: string; state: StepState }[]
  href: (step: number) => string
}) {
  return (
    <nav className="flex shrink-0 items-center gap-1 border-t border-line px-6 py-3">
      {steps.map(({ name, state }, index) => (
        <Link
          key={name}
          href={href(index + 1)}
          aria-current={state === 'now' ? 'step' : undefined}
          className={`group flex flex-1 items-center gap-2 rounded-[6px] px-3 py-2 transition-colors ${
            state === 'now' ? 'bg-primary text-secondary' : 'text-dim hover:bg-raise hover:text-ink'
          }`}
        >
          <span
            className={`grid size-4 shrink-0 place-items-center rounded-full text-micro tabular-nums ${
              state === 'now'
                ? 'bg-secondary text-primary'
                : state === 'done'
                  ? 'bg-ink text-ground'
                  : 'border border-current'
            }`}
          >
            {state === 'done' ? '✓' : index + 1}
          </span>
          <span className="truncate">{name}</span>
        </Link>
      ))}
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
    'rounded-[5px] border border-line px-3 py-2 transition-colors hover:border-ink/40 hover:bg-raise'
  const dead = 'rounded-[5px] border border-line/60 px-3 py-2 text-dim/40'
  return (
    <div className="flex shrink-0 items-center gap-3 border-t border-line px-6 py-3">
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
    <div className="grid flex-1 place-items-center p-6 text-center">
      <div className="max-w-sm">
        <p className="text-title font-medium tracking-[-0.02em]">{title}</p>
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
        <div className="flex shrink-0 items-end justify-between border-b border-line p-6">
          <div>
            <Label>{label}</Label>
            <h2 className="mt-1.5 text-title font-medium leading-tight tracking-[-0.025em]">
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
        <div className="quiet-scroll fade-foot min-h-0 flex-1 p-6">{children}</div>
      </div>
    </div>
  )
}

/* ── Controls ─────────────────────────────────────────────────────────────────
   Exactly one red button on a surface: the thing that surface is for. */

export const go =
  'inline-flex items-center justify-center rounded-[5px] bg-primary px-3 py-2 font-medium text-secondary transition-[filter,opacity] hover:brightness-110 disabled:opacity-30 disabled:hover:brightness-100'

/**
 * The same forward action, sized for a strip rather than a surface.
 *
 * A real variant, because the alternative was an `!important` override on `go`
 * at the one call site that needed it — which is how a scale stops being one.
 */
export const small =
  'inline-flex shrink-0 items-center justify-center rounded-full bg-primary px-3 py-2 font-medium text-secondary transition-[filter] hover:brightness-110'

/** Commit what is on screen. Never red — a save is not a forward action. */
export const ink =
  'inline-flex items-center justify-center rounded-[5px] bg-ink px-3 py-2 font-medium text-ground transition-opacity hover:opacity-85 disabled:opacity-25'

export const quiet =
  'inline-flex items-center justify-center rounded-[5px] border border-line px-3 py-2 font-medium transition-colors hover:border-ink/40 hover:bg-raise'

/** Destructive. Outlined rather than filled, so it can never be the fast path. */
export const stop =
  'inline-flex items-center justify-center rounded-[5px] border border-primary/40 px-3 py-2 font-medium text-primary transition-colors hover:bg-primary/[0.07]'

export const field =
  'w-full rounded-[4px] border border-line bg-raise px-3 py-2 transition-colors placeholder:text-dim/70 focus:border-primary'

/**
 * A line ruled under an entry, rather than a box drawn around it.
 *
 * No width. It used to carry `w-full`, and six call sites tried to narrow it
 * with `w-40`, `w-32`, `w-24` and so on — every one of them lost, because two
 * utilities for the same property are settled by their order in the stylesheet
 * and not by the order they are written in the attribute. So the bulk strip
 * came out as four full-width rows stacked 210px tall instead of one, and the
 * new-letter name, the destination and the block-domain row all spanned their
 * surface. A width is the call site's business; this is a look.
 *
 * The stacked forms need no replacement: their labels are flex columns, which
 * stretch a child to the full width on their own.
 */
export const ruled =
  'border-0 border-b border-line bg-transparent px-0 py-2 transition-colors placeholder:text-dim/70 focus:border-primary'
