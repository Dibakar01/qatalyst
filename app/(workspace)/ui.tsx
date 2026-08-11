// Colour only ever says something: verified reads as go, invalid as stop,
// catch_all as caution, unverified stays neutral because "not checked yet" is
// an absence rather than a warning.
const TONE: Record<string, string> = {
  verified: 'bg-emerald-50 text-emerald-700 ring-emerald-600/15',
  approved: 'bg-emerald-50 text-emerald-700 ring-emerald-600/15',
  sent: 'bg-emerald-50 text-emerald-700 ring-emerald-600/15',
  opted_in: 'bg-sky-50 text-sky-700 ring-sky-600/15',
  sending: 'bg-sky-50 text-sky-700 ring-sky-600/15',
  catch_all: 'bg-amber-50 text-amber-700 ring-amber-600/15',
  flagged: 'bg-amber-50 text-amber-700 ring-amber-600/15',
  invalid: 'bg-rose-50 text-rose-700 ring-rose-600/15',
  bounced: 'bg-rose-50 text-rose-700 ring-rose-600/15',
}

export function Pill({ children, tone }: { children: string; tone?: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11.5px] font-medium capitalize ring-1 ring-inset ${
        TONE[tone ?? children] ?? 'bg-faint text-muted ring-line'
      }`}
    >
      {children.replace('_', ' ')}
    </span>
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
    <section className="border-b border-line px-5 py-5 last:border-b-0">
      <div className="mb-3 flex items-baseline gap-2.5">
        <span className="grid size-5 shrink-0 place-items-center rounded-full bg-ink text-[11px] font-medium text-white">
          {n}
        </span>
        <h2 className="font-medium">{title}</h2>
        {note ? <span className="text-muted">{note}</span> : null}
      </div>
      <div className="pl-8">{children}</div>
    </section>
  )
}

export const button = 'rounded-lg bg-ink px-3 py-1.5 font-medium text-white transition-opacity hover:opacity-85 disabled:opacity-30'
export const ghost = 'rounded-lg border border-line px-3 py-1.5 font-medium transition-colors hover:bg-faint'
export const field = 'w-full rounded-lg border border-line bg-faint px-2.5 py-1.5 focus:bg-surface'
