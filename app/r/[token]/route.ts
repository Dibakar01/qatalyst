import { recordClick } from '@/lib/funnel'
import { readLink } from '@/lib/token'

// Public, like /u/. This is the hop between the email and the website, so it
// must work for someone who has never seen the app.
export const dynamic = 'force-dynamic'

export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params
  const trace = readLink(token)

  // A forged or stale token still lands the person somewhere. Refusing to
  // redirect would punish a reader for a link we generated.
  let destination: string | null = null
  if (trace) {
    try {
      destination = await recordClick(trace)
    } catch {
      // Recording the click is bookkeeping. Never let it cost the click, and
      // never let it cost the destination either — a failure here falls back
      // to the enquiry form rather than to an error page.
    }
  }

  // Resolved now, not baked into the body at draft time. That is what lets a
  // changed destination fix letters already sitting in inboxes.
  const to = new URL(destination ?? '/enquire', req.url)

  // `t` for the enquiry form, which reads it server-side; `qt` for the pixel,
  // which re-parks it in first-party storage. Same token, two readers — no
  // second id is minted, because the one we already have is better than
  // anything we could invent: it is signed, and it names both parties.
  if (trace) {
    to.searchParams.set('t', token)
    to.searchParams.set('qt', token)
  }
  return Response.redirect(to, 302)
}
