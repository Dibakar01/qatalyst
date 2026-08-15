import { createHmac, timingSafeEqual } from 'node:crypto'
import { normalise } from './email.ts'

function secret() {
  const s = process.env.UNSUBSCRIBE_SECRET
  // Empty key would still "sign", and every token would be forgeable. Fail loud.
  if (!s) throw new Error('UNSUBSCRIBE_SECRET is not set')
  return s
}

const mac = (payload: string) => createHmac('sha256', secret()).update(payload).digest('base64url')

/**
 * One signing primitive, two payload shapes.
 *
 * Every token this app puts in an email is `base64url(payload).hmac` — nothing
 * is stored, so the public deployment needs only the secret and can verify a
 * token it has never seen. Unsubscribe tokens carry an address; tracked links
 * carry a contact and a campaign.
 */
export function seal(payload: string) {
  const body = Buffer.from(payload).toString('base64url')
  return `${body}.${mac(body)}`
}

export function unseal(token: string): string | null {
  const [body, signature] = token.split('.')
  if (!body || !signature) return null
  const expected = Buffer.from(mac(body))
  const got = Buffer.from(signature)
  // Length check first: timingSafeEqual throws on a mismatch rather than
  // returning false, and a forged token is allowed to be rejected, not to 500.
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) return null
  return Buffer.from(body, 'base64url').toString()
}

/* ── unsubscribe: the address itself ──────────────────────────────────────── */

export const makeToken = (email: string) => seal(normalise(email))

export function readToken(token: string): string | null {
  const email = unseal(token)
  return email && email.includes('@') ? email : null
}

export const unsubscribeUrl = (email: string) =>
  `${process.env.UNSUBSCRIBE_BASE_URL ?? ''}/u/${makeToken(email)}`

/* ── tracked links: who, and which campaign ───────────────────────────────── */

export type Trace = { contactId: string; campaignId: string }

/**
 * The contact and campaign, not the message.
 *
 * Both are known while the body is being written; the message id is not — it
 * does not exist until the row is inserted. The pair resolves to exactly one
 * message anyway, because `(campaign_id, contact_id)` is unique.
 */
export const makeLink = ({ contactId, campaignId }: Trace) => seal(`t:${contactId}.${campaignId}`)

export function readLink(token: string): Trace | null {
  const raw = unseal(token)
  if (!raw?.startsWith('t:')) return null
  const [contactId, campaignId] = raw.slice(2).split('.')
  return contactId && campaignId ? { contactId, campaignId } : null
}

/** Where `{{link}}` points: our own tracked hop, which lands on the enquiry form. */
export const trackedUrl = (trace: Trace) =>
  `${process.env.UNSUBSCRIBE_BASE_URL ?? ''}/r/${makeLink(trace)}`
