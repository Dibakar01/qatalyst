import type { Contact } from '../db/schema.ts'

/**
 * Checking an address without writing to it.
 *
 * `maySend()` refuses `unverified` and `invalid` outright, so every unverified
 * row is money already spent on a contact we can never write to. Vendors sell
 * verification per record; this is the open-source alternative, run once and
 * used forever.
 *
 * Reacher — https://github.com/reacherhq/check-if-email-exists — connects to
 * the recipient's mail server and asks, without delivering anything. Rust, and
 * self-hosted as `reacherhq/backend`, so no list ever leaves the machine.
 *
 * **It needs outbound port 25.** GCP blocks that permanently and never lifts
 * it; AWS only on request; Hetzner and OVH leave it open. That is a fact about
 * where the service can run, not about this code.
 *
 * With `REACHER_URL` unset, nothing here does anything and every caller
 * behaves exactly as it did before — so this is safe to ship long before the
 * box exists.
 */

/** Reacher's verdict. Its vocabulary, kept intact rather than renamed. */
type Reachable = 'safe' | 'risky' | 'invalid' | 'unknown'

type CheckResponse = {
  is_reachable?: Reachable
  smtp?: { is_catch_all?: boolean; is_disabled?: boolean }
  misc?: { is_disposable?: boolean; is_role_account?: boolean }
}

export const verifierConfigured = () => Boolean(process.env.REACHER_URL)

/**
 * Reacher's answer, in our own vocabulary.
 *
 * Pure, so the mapping is testable without a service running — and the mapping
 * is the part that can quietly lose contacts.
 *
 * `unknown` deliberately stays `unverified` rather than becoming `invalid`: the
 * common cause is a server that would not talk to us, which says nothing about
 * whether the person exists. Treating silence as proof of absence would throw
 * away good contacts permanently.
 */
export function statusFor(result: CheckResponse): Contact['emailStatus'] | null {
  switch (result.is_reachable) {
    case 'safe':
      return 'verified'
    case 'invalid':
      return 'invalid'
    case 'risky':
      // A catch-all accepts everything, so acceptance proves nothing. We have
      // a status for exactly this, and its own daily cap.
      if (result.smtp?.is_catch_all) return 'catch_all'
      // Disabled mailboxes and disposable addresses are risky for a reason
      // that will not improve.
      if (result.smtp?.is_disabled || result.misc?.is_disposable) return 'invalid'
      return 'catch_all'
    default:
      return null
  }
}

/**
 * Ask about one address. Null when there is no verifier, or it could not say.
 *
 * Never throws: a verifier being down must not stop an import. The worst case
 * is that a contact stays unverified, which is where it already was.
 */
export async function verify(email: string, timeoutMs = 15_000) {
  const base = process.env.REACHER_URL
  if (!base) return null

  const stop = AbortSignal.timeout(timeoutMs)
  try {
    const response = await fetch(`${base.replace(/\/$/, '')}/v0/check_email`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(process.env.REACHER_SECRET ? { authorization: process.env.REACHER_SECRET } : {}),
      },
      body: JSON.stringify({ to_email: email }),
      signal: stop,
    })
    if (!response.ok) return null
    return statusFor((await response.json()) as CheckResponse)
  } catch {
    return null
  }
}

/**
 * A batch, gently.
 *
 * Every check opens an SMTP conversation with someone else's server, and doing
 * that in parallel across one provider is indistinguishable from an attack —
 * which gets the verifier's IP blocked and defeats the point. Three at a time,
 * which is slow and stays welcome.
 */
export async function verifyMany(emails: string[], each: (email: string, status: Contact['emailStatus']) => Promise<void>) {
  if (!verifierConfigured()) return { checked: 0, changed: 0 }

  let checked = 0
  let changed = 0
  const queue = [...emails]

  const worker = async () => {
    for (let email = queue.shift(); email; email = queue.shift()) {
      const status = await verify(email)
      checked++
      if (status) {
        await each(email, status)
        changed++
      }
    }
  }

  await Promise.all([worker(), worker(), worker()])
  return { checked, changed }
}
