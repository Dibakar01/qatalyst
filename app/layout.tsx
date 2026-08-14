import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Qatalyst',
  description: 'Internal outbound tool',
}

// The theme has to be on the element before the first paint or the page flashes
// the wrong room. This is the one thing that cannot wait for React, so it is a
// blocking inline script and nothing else is.
const THEME = `try{var t=localStorage.getItem('qat-theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}`

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME }} />
      </head>
      {/* Helvetica is on every machine this runs on, so there is no font to
          load, no layout shift on first paint and no request to Google. */}
      <body>{children}</body>
    </html>
  )
}
