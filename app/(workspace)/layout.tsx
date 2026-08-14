import Image from 'next/image'
import Link from 'next/link'
import { requireAuth } from '@/lib/auth'
import ThemeSwitch from '../theme'
import { signOut } from './actions'

/**
 * The room, and the lit box in the middle of it.
 *
 * Nothing in here is content. The stage is held perfectly still during
 * navigation — only the working panel on it is allowed to move — and the letter
 * inside it is never unmounted, so turning it over survives everything you do.
 */
export default async function DeskLayout({ children }: LayoutProps<'/'>) {
  await requireAuth()

  return (
    <div className="flex h-dvh flex-col">
      <header className="relative flex shrink-0 items-center justify-center px-6 py-3">
        <Link href="/" className="flex items-center gap-2">
          <Image src="/mark.png" alt="" width={18} height={18} priority className="rounded-[3px]" />
          <span className="font-semibold tracking-[-0.04em]">qatalyst</span>
        </Link>
        <div className="absolute right-6 flex items-center gap-3">
          <ThemeSwitch />
          <form action={signOut}>
            <button className="rounded-full border border-line px-3 py-2 text-dim transition-colors hover:border-primary hover:text-primary">
              Sign out
            </button>
          </form>
        </div>
      </header>

      <div className="min-h-0 flex-1 px-3 pb-3">
        <div
          className="stage grain relative flex h-full flex-col overflow-hidden rounded-[18px]"
          style={{ viewTransitionName: 'stage' }}
        >
          {children}
        </div>
      </div>
    </div>
  )
}
