import type { Metadata } from 'next'
import Link from 'next/link'
import './globals.css'

export const metadata: Metadata = {
  title: 'Qatalyst',
  description: 'Internal outbound tool',
}

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">
        <nav className="flex gap-4 border-b border-neutral-300 px-4 py-2">
          <Link href="/contacts" className="font-medium hover:underline">
            Contacts
          </Link>
          <Link href="/import" className="hover:underline">
            Import
          </Link>
        </nav>
        <main className="flex-1 p-4">{children}</main>
      </body>
    </html>
  )
}
