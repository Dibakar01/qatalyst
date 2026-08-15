import Link from 'next/link'
import Mark from '../mark'
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
      <header className="chrome relative z-20 flex shrink-0 items-center justify-center px-6 py-3">
        {/* The name sits in the corner where names go; the mark stands alone in
            the middle. They were stuck together in the centre, which made the
            wordmark do the icon's job and left this corner empty. */}
        <span className="absolute left-6 font-semibold tracking-[-0.04em] text-dim">qatalyst</span>

        <Link href="/" aria-label="qatalyst — the desk" className="flex items-center">
          <Mark size={20} />
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
