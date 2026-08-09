'use client'

import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useEffect, useState, useTransition } from 'react'

/** Every control writes to the URL. The URL is the only state the list has. */
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
    next.delete('page') // any change to the query puts you back on page one
    const qs = next.toString()
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
  }
}

export function Search({ placeholder = 'Search name, company or email' }) {
  const params = useSearchParams()
  const write = useParamWriter()
  const [value, setValue] = useState(params.get('q') ?? '')
  const [pending, start] = useTransition()

  // No submit button: results follow typing. The guard makes this converge —
  // once the URL matches what is typed, nothing more is scheduled.
  useEffect(() => {
    if (value === (params.get('q') ?? '')) return
    const timer = setTimeout(() => start(() => write({ q: value || undefined })), 180)
    return () => clearTimeout(timer)
  })

  return (
    <div className="relative flex-1 sm:max-w-xs">
      <svg
        viewBox="0 0 16 16"
        fill="none"
        className={`pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 transition-opacity ${
          pending ? 'opacity-100' : 'opacity-45'
        }`}
      >
        <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.3" />
        <path d="m10.5 10.5 3 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      </svg>
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className="w-full rounded-lg border border-line bg-faint py-1.5 pl-8 pr-3 placeholder:text-muted focus:bg-surface"
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
      onChange={(e) => write({ [name]: e.target.value || undefined })}
      className={`rounded-lg border border-line py-1.5 pl-2.5 pr-7 transition-colors ${
        value ? 'bg-ink text-white' : 'bg-faint text-muted hover:text-ink'
      }`}
    >
      <option value="">{label}</option>
      {options.map((option) => (
        <option key={option} value={option} className="bg-surface text-ink">
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
      className="rounded-lg px-2 py-1.5 text-muted underline-offset-2 hover:text-ink hover:underline"
    >
      Clear
    </button>
  )
}
