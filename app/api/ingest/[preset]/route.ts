import { PRESETS } from '@/lib/connectors'
import { runImport } from '@/lib/contacts'
import type { Row } from '@/lib/csv'

/**
 * The push door: a LinkedIn exporter posts its rows here.
 *
 * Sales Navigator has no export API, so a list leaves LinkedIn through
 * Evaboot, PhantomBuster or Clay. Each of those can POST a webhook, and each
 * spells the same fields differently — which is why this endpoint is a preset
 * lookup and nothing more. The rows then go through `runImport()` like every
 * other source, so suppression, deduplication and malformed-address handling
 * are the same code that handles a hand-uploaded CSV.
 *
 *   curl -X POST /api/ingest/evaboot \
 *     -H "authorization: Bearer $INGEST_SECRET" \
 *     -H "content-type: application/json" \
 *     -d '[{"First Name":"Ada","Email":"ada@example.com"}]'
 */
export const dynamic = 'force-dynamic'

const problem = (message: string, status: number) =>
  Response.json({ error: message }, { status })

export async function POST(req: Request, ctx: { params: Promise<{ preset: string }> }) {
  const secret = process.env.INGEST_SECRET
  // No secret configured means the door is not open, rather than open to all.
  if (!secret) return problem('INGEST_SECRET is not set, so ingestion is closed.', 503)
  if (req.headers.get('authorization') !== `Bearer ${secret}`) return problem('Unauthorized', 401)

  const { preset } = await ctx.params
  const chosen = PRESETS[preset]
  if (!chosen) {
    return problem(`Unknown preset "${preset}". Known: ${Object.keys(PRESETS).join(', ')}.`, 404)
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return problem('Body must be JSON.', 400)
  }

  // Exporters differ on whether they post an array or wrap it. Accept both.
  const rows = (Array.isArray(body) ? body : (body as { rows?: unknown }).rows) as Row[] | undefined
  if (!Array.isArray(rows)) return problem('Expected an array of rows, or { rows: [...] }.', 400)
  if (rows.length > 5000) return problem('Too many rows in one post. Send 5000 at a time.', 413)

  const counts = await runImport(chosen.mapping, rows, `${preset}:webhook`)
  return Response.json({ preset, ...counts })
}
