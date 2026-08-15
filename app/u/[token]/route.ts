import { suppress } from '@/lib/suppression'
import { readToken } from '@/lib/token'

// This route is the one part of the app that faces the public internet: the
// local app writes unsubscribe links pointing here, so it must stay reachable
// and must never require a session.
export const dynamic = 'force-dynamic'

function page(body: string, status = 200) {
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>Unsubscribe</title>` +
      `<body style="font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem">` +
      body,
    {
      status,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        // The token identifies a person. Keep it out of anyone's referrer log.
        'referrer-policy': 'no-referrer',
      },
    },
  )
}

/**
 * Ask, then act.
 *
 * This used to suppress on the GET. Outlook SafeLinks, corporate AV
 * link-rewriters, browser prefetchers and an `<img src>` in a forwarded copy
 * all fetch a URL without a person deciding anything — and suppression is
 * permanent: nothing in this codebase deletes a suppression row, and
 * `lib/suppression.ts` then excludes that address from every future campaign.
 *
 * So the machines were unsubscribing people who never asked, in the one
 * direction nobody notices. You get no bounce and no complaint; you simply
 * stop being able to contact someone, and never learn why.
 *
 * A GET is safe and idempotent, as it always should have been. The POST behind
 * a button is what a person actually did.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params
  if (!readToken(token)) return page('<p>This unsubscribe link is not valid.</p>', 400)

  return page(
    `<p>Would you like to stop receiving email from us?</p>` +
      `<form method="post">` +
      `<button style="font:inherit;padding:.6rem 1.1rem;border:1px solid #d92819;background:#d92819;color:#fff;border-radius:6px;cursor:pointer">` +
      `Yes, unsubscribe me</button>` +
      `</form>` +
      `<p style="color:#666;font-size:14px;margin-top:1.5rem">Nothing has changed yet.</p>`,
  )
}

export async function POST(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params
  const email = readToken(token)
  if (!email) return page('<p>This unsubscribe link is not valid.</p>', 400)

  await suppress(email, 'unsubscribed')
  return page('<p>You have been unsubscribed. We will not email you again.</p>')
}
