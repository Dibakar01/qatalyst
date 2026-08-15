import { NextResponse, type NextRequest } from 'next/server'
import { COOKIE } from '@/lib/auth'

/**
 * Optimistic only (no crypto: this runs on the edge runtime). Real auth is
 * `requireAuth()` inside each page and server action.
 *
 * PUBLIC_ONLY=1 is what the internet-facing deployment runs with: it serves the
 * unsubscribe handler and nothing else, so the contact list never leaves the laptop.
 */
/**
 * The three things that appear in an email and must work for a stranger with
 * no session: unsubscribing, the tracked link, and the form it lands on. These
 * are the whole of the public surface — everything else is the contact list.
 */
const PUBLIC = ['/u/', '/r/', '/enquire']

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl

  if (PUBLIC.some((path) => pathname.startsWith(path))) return NextResponse.next()
  if (process.env.PUBLIC_ONLY === '1') return new NextResponse('Not found', { status: 404 })

  // Webhooks cannot carry a session cookie, so the route checks a bearer secret
  // of its own. Private-side only: this writes contacts.
  if (pathname.startsWith('/api/ingest/') || pathname === '/api/conversion') {
    return NextResponse.next()
  }

  if (pathname === '/login') return NextResponse.next()
  if (!req.cookies.get(COOKIE)) return NextResponse.redirect(new URL('/login', req.url))

  return NextResponse.next()
}

// The brand mark has to be reachable without a session, or the sign-in page
// has no favicon — the browser asks for it before anyone has logged in.
export const config = {
  matcher: ['/((?!_next/static|_next/image|icon\\.png|apple-icon\\.png|mark\\.png).*)'],
}
