'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { signOut } from './actions'

const icons = {
  contacts: 'M7 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM1.5 14.5c0-2.5 2.5-4 5.5-4s5.5 1.5 5.5 4M12 7.5a2 2 0 1 0 0-4',
  suppressions: 'M8 14.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13ZM3.4 3.4l9.2 9.2',
  mailboxes: 'M2 4.5h12v7a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-7ZM2 5l6 4 6-4',
} as const

const NAV = [
  { href: '/', label: 'Contacts', icon: icons.contacts },
  { href: '/suppressions', label: 'Suppressions', icon: icons.suppressions },
  { href: '/mailboxes', label: 'Mailboxes', icon: icons.mailboxes },
] as const

export default function Sidebar() {
  const pathname = usePathname()

  return (
    <aside className="hidden w-[228px] shrink-0 flex-col rounded-2xl border border-line bg-surface p-3 md:flex">
      <div className="flex items-center gap-2.5 px-2 py-2.5">
        <span className="grid size-7 place-items-center rounded-lg bg-ink text-[11px] font-semibold tracking-tight text-white">
          Q
        </span>
        <span className="text-[13px] font-semibold tracking-[0.14em]">QATALYST</span>
      </div>

      <nav className="mt-4 flex flex-col gap-0.5">
        {NAV.map((item) => {
          const active = pathname === item.href
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? 'page' : undefined}
              className={`flex items-center gap-2.5 rounded-lg px-2.5 py-2 transition-colors ${
                active ? 'bg-faint font-medium text-ink' : 'text-muted hover:bg-faint hover:text-ink'
              }`}
            >
              <svg viewBox="0 0 16 16" fill="none" className="size-4 shrink-0">
                <path
                  d={item.icon}
                  stroke="currentColor"
                  strokeWidth="1.3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              {item.label}
            </Link>
          )
        })}
      </nav>

      <div className="mt-auto border-t border-line pt-3">
        <p className="px-2.5 text-[11px] text-muted">Phase 1 · contacts and suppression</p>
        <form action={signOut}>
          <button className="mt-1 w-full rounded-lg px-2.5 py-2 text-left text-muted transition-colors hover:bg-faint hover:text-ink">
            Sign out
          </button>
        </form>
      </div>
    </aside>
  )
}
