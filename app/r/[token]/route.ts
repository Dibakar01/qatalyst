import { recordClick } from '@/lib/funnel'
import { readLink } from '@/lib/token'

// Public, like /u/. This is the hop between the email and the website, so it
// must work for someone who has never seen the app.
export const dynamic = 'force-dynamic'

export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params
  const trace = readLink(token)

  // A forged or stale token still lands the person on the form. Refusing to
  // redirect would punish a reader for a link we generated.
  if (trace) {
    try {
      await recordClick(trace)
    } catch {
      // Recording the click is bookkeeping. Never let it cost the click.
    }
  }

  const to = new URL('/enquire', req.url)
  if (trace) to.searchParams.set('t', token)
  return Response.redirect(to, 302)
}
