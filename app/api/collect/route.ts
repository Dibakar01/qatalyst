import { recordConversion, type ConversionEvent } from '@/lib/funnel'
import { keyAllowed, originAllowed, parseKeys, parseOrigins } from '@/lib/origins'
import { readLink } from '@/lib/token'

/**
 * Where the pixel reports.
 *
 * `/api/conversion` cannot take this traffic: it authenticates with a bearer
 * secret, and a secret shipped to a browser is not a secret. So the browser
 * gets its own door with browser-shaped auth — the `Origin` header, which the
 * browser sets itself and page script cannot forge.
 *
 * **Everything returns 204, including refusal.** Two reasons. A pixel cannot
 * act on an error, so a status code it will never read is wasted. And this
 * endpoint sits on the open internet: an error that distinguishes "wrong
 * origin" from "bad event" tells a prober how the allowlist is configured.
 * Boring to attack is the design.
 */
export const dynamic = 'force-dynamic'

const EVENTS: ConversionEvent[] = ['visited', 'signed_up', 'subscribed']

const done = (origin?: string) =>
  new Response(null, {
    status: 204,
    headers: origin
      ? { 'access-control-allow-origin': origin, vary: 'Origin' }
      : { vary: 'Origin' },
  })

/** A conversion report is small. Anything larger is not one. */
const MAX_BODY = 4 * 1024

export async function POST(req: Request) {
  const origin = req.headers.get('origin')
  if (!originAllowed(origin, parseOrigins(process.env.SITE_ORIGINS))) return done()

  // Refuse before reading, when the sender declares a size.
  const declared = Number(req.headers.get('content-length') ?? 0)
  if (declared > MAX_BODY) return done(origin!)

  try {
    // Sent as text/plain so `sendBeacon` need not preflight, so it is parsed
    // here rather than by the framework.
    const text = await req.text()
    if (text.length > MAX_BODY) return done(origin!)
    const body = JSON.parse(text) as Record<string, unknown>

    // `Origin` alone is not authentication — a browser sets it, and curl sets
    // it to anything. Without this key the endpoint is an open write on the
    // internet: fabricated revenue in your reports from a one-line request.
    // The key is not secret (it ships in page source); it stops an untargeted
    // prober and lets one site be revoked without touching the others.
    if (!keyAllowed(body.key ? String(body.key) : null, parseKeys(process.env.SITE_KEYS))) {
      return done(origin!)
    }

    const event = String(body.event ?? '')
    if (!EVENTS.includes(event as ConversionEvent)) return done(origin!)

    // A forged or expired token reads as null and the event still counts if it
    // carries an address — the signature is what makes attribution
    // trustworthy, not what makes the visit real.
    const trace = body.click ? readLink(String(body.click)) : null
    const email = body.email ? String(body.email) : null
    if (!trace && !email) return done(origin!)

    const raw = body.value
    const value = raw === undefined || raw === null ? null : Number(raw)

    await recordConversion({
      trace,
      email,
      event: event as ConversionEvent,
      eventId: body.event_id ? String(body.event_id) : null,
      // Money is in minor units and must be whole. A float here is a bug on
      // the sending side; dropping the value keeps the event rather than
      // losing the conversion over it.
      value: value !== null && Number.isInteger(value) ? value : null,
      currency: body.currency ? String(body.currency) : null,
      // Deliberately absent: this caller is authenticated by a key that ships
      // in page source, so it may report a conversion and may not move a
      // contact along the pipeline. `advance()` never goes backwards.
    })
  } catch {
    // Malformed JSON, an unknown address, a database hiccup. None of it is
    // the visitor's problem and none of it should colour a page.
  }

  return done(origin!)
}

/** The browser asks before a cross-origin POST it cannot treat as simple. */
export async function OPTIONS(req: Request) {
  const origin = req.headers.get('origin')
  if (!originAllowed(origin, parseOrigins(process.env.SITE_ORIGINS))) return done()
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': origin!,
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
      'access-control-max-age': '86400',
      vary: 'Origin',
    },
  })
}
