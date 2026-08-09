import { createHash, timingSafeEqual } from 'node:crypto'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'

export const COOKIE = 'qat'

const sha = (s: string) => createHash('sha256').update(s).digest()

export function cookieValue() {
  const pw = process.env.APP_PASSWORD
  if (!pw) throw new Error('APP_PASSWORD is not set')
  return sha(`qatalyst:${pw}`).toString('hex')
}

export function passwordMatches(input: string) {
  const pw = process.env.APP_PASSWORD
  if (!pw) return false
  return timingSafeEqual(sha(input), sha(pw))
}

/**
 * Real check. `proxy.ts` only does the optimistic redirect — server actions are
 * reachable by direct POST, so every page and action calls this itself.
 */
export async function requireAuth() {
  const c = (await cookies()).get(COOKIE)?.value
  if (!c || c !== cookieValue()) redirect('/login')
}
