import { NextResponse, type NextRequest } from 'next/server'
import { COOKIE } from '@/lib/auth'

/**
 * Optimistic only (no crypto: this runs on the edge runtime). Real auth is
 * `requireAuth()` inside each page and server action.
 *
 * PUBLIC_ONLY=1 is what the internet-facing deployment runs with: it serves the
 * unsubscribe handler and nothing else, so the contact list never leaves the laptop.
 */
export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl

  if (pathname.startsWith('/u/')) return NextResponse.next()
  if (process.env.PUBLIC_ONLY === '1') return new NextResponse('Not found', { status: 404 })
  if (pathname === '/login') return NextResponse.next()
  if (!req.cookies.get(COOKIE)) return NextResponse.redirect(new URL('/login', req.url))

  return NextResponse.next()
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
