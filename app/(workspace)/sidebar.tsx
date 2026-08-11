'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { signOut } from './actions'

const NAV = [
  { href: '/', label: 'Campaigns', match: (p: string) => p === '/' || p.startsWith('/c/') },
  { href: '/contacts', label: 'Contacts', match: (p: string) => p.startsWith('/contacts') },
  { href: '/settings', label: 'Settings', match: (p: string) => p.startsWith('/settings') },
] as const

export default function Sidebar() {
  const pathname = usePathname()

  return (
    <aside className="hidden w-[190px] shrink-0 flex-col rounded-2xl border border-line bg-surface p-3 md:flex">
      <div className="flex items-center gap-2.5 px-2 py-2.5">
        <span className="grid size-7 place-items-center rounded-lg bg-ink text-[11px] font-semibold text-white">
          Q
        </span>
        <span className="text-[13px] font-semibold tracking-[0.14em]">QATALYST</span>
      </div>

      <nav className="mt-4 flex flex-col gap-0.5">
        {NAV.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            aria-current={item.match(pathname) ? 'page' : undefined}
            className={`rounded-lg px-2.5 py-2 transition-colors ${
              item.match(pathname)
                ? 'bg-faint font-medium text-ink'
                : 'text-muted hover:bg-faint hover:text-ink'
            }`}
          >
            {item.label}
          </Link>
        ))}
      </nav>

      <form action={signOut} className="mt-auto border-t border-line pt-3">
        <button className="w-full rounded-lg px-2.5 py-2 text-left text-muted transition-colors hover:bg-faint hover:text-ink">
          Sign out
        </button>
      </form>
    </aside>
  )
}
