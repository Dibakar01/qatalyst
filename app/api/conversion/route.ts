import { recordConversion, type ConversionEvent } from '@/lib/funnel'

/**
 * The conversions API: your product telling us it worked.
 *
 * Server-to-server, the same shape an ad platform uses. No pixel and no
 * cross-domain cookie, which means it survives ad blockers, Safari, and a
 * subscription that lands three months after the email.
 *
 *   curl -X POST /api/conversion \
 *     -H "authorization: Bearer $INGEST_SECRET" \
 *     -H "content-type: application/json" \
 *     -d '{"email":"ada@example.com","event":"subscribed","value":4900,"currency":"INR"}'
 *
 * Retry it as often as you like — the unique index on (contact, event) means a
 * repeat is recorded once. Webhook delivery is at-least-once almost everywhere,
 * and revenue that double-counts is worse than revenue that arrives late.
 */
export const dynamic = 'force-dynamic'

const EVENTS: ConversionEvent[] = ['visited', 'signed_up', 'subscribed']

const problem = (message: string, status: number) => Response.json({ error: message }, { status })

export async function POST(req: Request) {
  const secret = process.env.INGEST_SECRET
  if (!secret) return problem('INGEST_SECRET is not set, so conversions are closed.', 503)
  if (req.headers.get('authorization') !== `Bearer ${secret}`) return problem('Unauthorized', 401)

  let body: Record<string, unknown>
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return problem('Body must be JSON.', 400)
  }

  const event = String(body.event ?? '')
  if (!EVENTS.includes(event as ConversionEvent)) {
    return problem(`event must be one of ${EVENTS.join(', ')}.`, 400)
  }

  // Money arrives in minor units so nothing is ever a float. A value that is
  // not a whole number is a bug on the sending side worth reporting, not
  // rounding away.
  const raw = body.value
  const value = raw === undefined || raw === null ? null : Number(raw)
  if (value !== null && !Number.isInteger(value)) {
    return problem('value must be a whole number of minor units (paise, cents).', 400)
  }

  try {
    const result = await recordConversion({
      email: String(body.email ?? ''),
      event: event as ConversionEvent,
      value,
      currency: body.currency ? String(body.currency) : null,
      at: body.at ? new Date(String(body.at)) : undefined,
    })

    // A conversion from someone we never wrote to is still worth keeping — it
    // is inbound — so this is 200 with the truth in it rather than an error.
    return Response.json(result)
  } catch (cause) {
    return problem(cause instanceof Error ? cause.message : 'Could not record that.', 400)
  }
}
