import Link from 'next/link'
import { requireAuth } from '@/lib/auth'
import { signOut } from './actions'

/**
 * The room, and the lit box in the middle of it.
 *
 * Nothing in here is content. The frame is quiet near-white so the stage reads
 * as the only thing worth looking at, and the stage is held perfectly still
 * during navigation — only the sheet on it is allowed to change.
 */
export default async function DeskLayout({ children }: LayoutProps<'/'>) {
  await requireAuth()

  return (
    <div className="flex h-dvh flex-col">
      <header className="relative flex shrink-0 items-center justify-center px-5 py-3">
        <Link href="/" className="font-serif text-[19px] tracking-[-0.02em]">
          qatalyst
        </Link>
        <form action={signOut} className="absolute right-5">
          <button className="rounded-full px-3 py-1.5 text-dim transition-colors hover:bg-ink/[0.05] hover:text-ink">
            Sign out
          </button>
        </form>
      </header>

      <div className="min-h-0 flex-1 px-3 pb-3">
        <div
          className="stage grain relative flex h-full flex-col overflow-hidden rounded-[22px]"
          style={{ viewTransitionName: 'stage' }}
        >
          {children}
        </div>
      </div>
    </div>
  )
}
