import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'
import Ground from './ground'

// Self-hosted at build time, so the app makes no request to Google at runtime
// and there is no layout shift on first paint.
const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' })

export const metadata: Metadata = {
  title: 'Qatalyst',
  description: 'Internal outbound tool',
}

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" className={inter.variable}>
      <body>
        <Ground />
        {children}
      </body>
    </html>
  )
}
