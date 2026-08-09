import { requireAuth } from '@/lib/auth'
import Sidebar from './sidebar'

export default async function WorkspaceLayout({ children }: LayoutProps<'/'>) {
  await requireAuth()

  return (
    <div className="flex h-screen gap-2.5 p-2.5">
      <Sidebar />
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-line bg-surface">
        {children}
      </main>
    </div>
  )
}
