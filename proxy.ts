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
 * The five things that must work for a stranger with no session.
 *
 * Three appear in an email: unsubscribing, the tracked link, and the form it
 * lands on. Two are the pixel: the script your site loads, and the endpoint it
 * reports to. That endpoint is authenticated by Origin rather than by a
 * secret, because a secret shipped to a browser is not a secret.
 *
 * Everything else is the contact list.
 */
const PUBLIC = ['/u/', '/r/', '/enquire', '/qt.js', '/api/collect']

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

// The mark has to be reachable without a session, or the sign-in page has no
// favicon — the browser asks for it before anyone has logged in, and a redirect
// to /login is not an image. `apple-icon` is unanchored because Next serves it
// from a generated route with a hash in the path.
export const config = {
  matcher: ['/((?!_next/static|_next/image|icon\\.svg|apple-icon).*)'],
}
