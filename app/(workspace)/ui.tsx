// Colour is only ever used to say something. verified/opted_in read as go,
// invalid reads as stop, catch_all reads as caution, unverified stays neutral
// because "we have not checked yet" is not a warning, it is an absence.
const EMAIL_TONE = {
  verified: 'bg-emerald-50 text-emerald-700 ring-emerald-600/15',
  catch_all: 'bg-amber-50 text-amber-700 ring-amber-600/15',
  unverified: 'bg-faint text-muted ring-line',
  invalid: 'bg-rose-50 text-rose-700 ring-rose-600/15',
} as const

export function EmailStatusPill({ status }: { status: keyof typeof EMAIL_TONE }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11.5px] font-medium capitalize ring-1 ring-inset ${EMAIL_TONE[status]}`}
    >
      {status.replace('_', ' ')}
    </span>
  )
}

export function ConsentPill({ status }: { status: 'none' | 'opted_in' }) {
  if (status === 'none') return <span className="text-muted">—</span>
  return (
    <span className="inline-flex items-center rounded-full bg-sky-50 px-2 py-0.5 text-[11.5px] font-medium text-sky-700 ring-1 ring-inset ring-sky-600/15">
      Opted in
    </span>
  )
}

export function Stat({
  label,
  value,
  note,
  tone = 'neutral',
}: {
  label: string
  value: number
  note?: string
  tone?: 'neutral' | 'warn'
}) {
  return (
    <div className="rounded-xl border border-line px-3.5 py-3">
      <p className="text-[11.5px] uppercase tracking-wider text-muted">{label}</p>
      <p className="mt-1 flex items-baseline gap-1.5">
        <span className="text-2xl font-semibold tracking-tight">{value.toLocaleString()}</span>
        {note ? (
          <span className={tone === 'warn' ? 'text-amber-600' : 'text-muted'}>{note}</span>
        ) : null}
      </p>
    </div>
  )
}

export function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="grid flex-1 place-items-center px-6 py-16 text-center">
      <div>
        <p className="font-medium">{title}</p>
        {hint ? <p className="mt-1 text-muted">{hint}</p> : null}
      </div>
    </div>
  )
}
