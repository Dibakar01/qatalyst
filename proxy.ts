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

  // Build output. `_next/static` used to be excluded from the matcher below, so
  // this decision could not be made at all: both deployments run the same build,
  // and the public one therefore served the workspace's client chunks — which
  // carry its server-action ids — to anyone who asked. Not exploitable, since
  // requireAuth() holds on every action but signOut, but it is a free map of the
  // thing being guarded.
  //
  // The public deployment still needs these: /u/ and /enquire are Next pages and
  // load their own chunks from here. Turbopack emits them flat, with opaque
  // hashed names and no route grouping, so there is no prefix that separates the
  // workspace's chunks from the public pages'.
  //
  // ponytail: the public deployment is still served the four chunks its own
  // pages never reference. Closing that needs two builds rather than one shared
  // one — a deployment change, not a proxy change. Until then this is where it
  // would go, and this branch is the one line that has to change.
  if (pathname.startsWith('/_next/static')) return NextResponse.next()

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
//
// `_next/static` is deliberately *not* excluded here any more. A matcher is
// evaluated at build time and both deployments share one build, so an exclusion
// here cannot tell them apart — the decision has to be made in `proxy()`, at
// request time, where `PUBLIC_ONLY` is actually readable.
export const config = {
  matcher: ['/((?!_next/image|icon\\.svg|apple-icon).*)'],
}
