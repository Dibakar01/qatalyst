import type { Metadata } from 'next'
import { IBM_Plex_Mono, Inter, Newsreader } from 'next/font/google'
import './globals.css'

// Self-hosted at build time, so the app makes no request to Google at runtime
// and there is no layout shift on first paint.
//
// Three families, each with one job. Newsreader is the voice: headings and the
// letters themselves, because a letter set in a UI grotesque is a form, not a
// letter. Inter is the machinery — labels, numbers, controls. Plex Mono is the
// franking: stamps, postmarks, the command line, anything struck by a machine
// rather than written by a person.
const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' })

const newsreader = Newsreader({
  subsets: ['latin'],
  variable: '--font-newsreader',
  display: 'swap',
  style: ['normal', 'italic'],
})

const plexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-plex-mono',
  display: 'swap',
})

export const metadata: Metadata = {
  title: 'Qatalyst',
  description: 'Internal outbound tool',
}

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${newsreader.variable} ${plexMono.variable}`}
    >
      <body>{children}</body>
    </html>
  )
}
