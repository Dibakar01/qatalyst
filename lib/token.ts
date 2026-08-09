import { createHmac, timingSafeEqual } from 'node:crypto'
import { normalise } from './email.ts'

function secret() {
  const s = process.env.UNSUBSCRIBE_SECRET
  // Empty key would still "sign", and every token would be forgeable. Fail loud.
  if (!s) throw new Error('UNSUBSCRIBE_SECRET is not set')
  return s
}

const sign = (payload: string) => createHmac('sha256', secret()).update(payload).digest('base64url')

/**
 * Self-contained unsubscribe token: base64url(email).hmac. No token table, so the
 * public handler needs nothing but the secret and a Postgres URL.
 */
export function makeToken(email: string) {
  const payload = Buffer.from(normalise(email)).toString('base64url')
  return `${payload}.${sign(payload)}`
}

export function readToken(token: string): string | null {
  const [payload, mac] = token.split('.')
  if (!payload || !mac) return null
  const expected = Buffer.from(sign(payload))
  const got = Buffer.from(mac)
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) return null
  const email = Buffer.from(payload, 'base64url').toString()
  return email.includes('@') ? email : null
}

export const unsubscribeUrl = (email: string) =>
  `${process.env.UNSUBSCRIBE_BASE_URL ?? ''}/u/${makeToken(email)}`
