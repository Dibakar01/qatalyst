import { suppress } from '@/lib/suppression'
import { readToken } from '@/lib/token'

// This route is the one part of the app that faces the public internet: the
// local app writes unsubscribe links pointing here, so it must stay reachable
// and must never require a session.
export const dynamic = 'force-dynamic'

function page(message: string, status = 200) {
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>Unsubscribe</title>` +
      `<body style="font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem">` +
      `<p>${message}</p>`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8' } },
  )
}

export async function GET(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params
  const email = readToken(token)
  if (!email) return page('This unsubscribe link is not valid.', 400)

  await suppress(email, 'unsubscribed')
  return page('You have been unsubscribed. We will not email you again.')
}
