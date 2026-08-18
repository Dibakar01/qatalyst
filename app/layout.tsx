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

/**
 * React warns in development whenever a render produces a `<script>` tag. The
 * script itself is the documented way to prevent a flash before hydration —
 * see next/dist/docs/01-app/02-guides/preventing-flash-before-hydration.md —
 * so the warning is about *how* it is rendered, not whether it should exist.
 *
 * The guide's remedy: `text/javascript` on the server so the browser runs it
 * during parsing, `text/plain` on the client so a re-render is inert, and
 * `suppressHydrationWarning` so React accepts the DOM's type over the payload's.
 */
function InlineScript({ html }: { html: string }) {
  return (
    <script
      type={typeof window === 'undefined' ? 'text/javascript' : 'text/plain'}
      suppressHydrationWarning
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Stays in <head>, deliberately. The guide's "place it after the
            element it modifies" applies to scripts patching rendered content;
            this one sets data-theme on documentElement, which exists the moment
            <html> is parsed. Moving it after <body> would reintroduce the flash
            it is here to prevent. The attribute also survives client-side
            navigation because React never renders data-theme and so never
            reconciles it away. */}
        <InlineScript html={THEME} />
      </head>
      {/* Helvetica is on every machine this runs on, so there is no font to
          load, no layout shift on first paint and no request to Google. */}
      <body>{children}</body>
    </html>
  )
}
