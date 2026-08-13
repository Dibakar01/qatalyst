'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { signOut } from './actions'

const NAV = [
  { href: '/control', label: 'Control', match: (p: string) => p.startsWith('/control') },
  { href: '/', label: 'Campaigns', match: (p: string) => p === '/' || p.startsWith('/c/') },
  { href: '/contacts', label: 'Contacts', match: (p: string) => p.startsWith('/contacts') },
  { href: '/settings', label: 'Settings', match: (p: string) => p.startsWith('/settings') },
] as const

export default function Sidebar() {
  const pathname = usePathname()

  return (
    <aside className="hidden w-[196px] shrink-0 flex-col p-3 md:flex">
      <div className="flex items-center gap-2.5 px-2 py-2.5">
        <span className="grid size-7 place-items-center rounded-lg bg-accent text-[11px] font-bold text-canvas">
          Q
        </span>
        <span className="text-[12.5px] font-semibold tracking-[0.16em]">QATALYST</span>
      </div>

      <nav className="mt-5 flex flex-col gap-0.5">
        {NAV.map((item) => {
          const here = item.match(pathname)
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={here ? 'page' : undefined}
              // The lime rule is the only thing marking place. No filled block,
              // no bold — where you are is a single mark, not a shout.
              className={`relative rounded-lg px-2.5 py-2 transition-colors ${
                here
                  ? 'bg-raised text-ink before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:rounded-full before:bg-accent'
                  : 'text-muted hover:bg-raised/60 hover:text-ink'
              }`}
            >
              {item.label}
            </Link>
          )
        })}
      </nav>

      <form action={signOut} className="mt-auto border-t border-line pt-3">
        <button className="w-full rounded-lg px-2.5 py-2 text-left text-muted transition-colors hover:bg-raised/60 hover:text-ink">
          Sign out
        </button>
      </form>
    </aside>
  )
}
