import { requireAuth } from '@/lib/auth'
import Sidebar from './sidebar'

/**
 * One shell, not a stack of cards. The sidebar and the screen are the same
 * piece of material with a hairline between them, floating on the ground —
 * which is what makes moving between screens feel like moving within one thing
 * rather than swapping documents.
 *
 * `view-transition-name` anchors it: during navigation the shell is lifted into
 * its own snapshot and told not to animate, so it holds perfectly still while
 * the screen inside it changes.
 */
export default async function WorkspaceLayout({ children }: LayoutProps<'/'>) {
  await requireAuth()

  return (
    <div className="flex h-dvh p-3">
      <div
        className="shell flex min-h-0 flex-1 overflow-hidden rounded-[20px]"
        style={{ viewTransitionName: 'shell' }}
      >
        <Sidebar />
        <main className="flex min-w-0 flex-1 flex-col overflow-hidden md:border-l md:border-line">
          {children}
        </main>
      </div>
    </div>
  )
}
