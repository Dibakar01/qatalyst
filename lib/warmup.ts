import { domainOf } from './email.ts'

/**
 * Earning a new domain its reputation, rather than just going slowly on it.
 *
 * `warmupCap()` throttles: it decides how few a young domain may send. That
 * protects against sending too much too soon, but it produces no evidence that
 * anyone wants our mail — and a brand-new domain whose entire history is cold
 * outreach to strangers has nothing good on its record. The throttle and the
 * reputation are different problems, and only one of them was solved.
 *
 * So during the ramp our own mailboxes write to each other and answer. That is
 * real delivered, threaded, replied-to mail on a real domain, which is exactly
 * what the paid warm-up services manufacture.
 *
 * Honest about the limit: twenty-five mailboxes warming each other is a small
 * pool, and weaker than the large vetted ones those services run. It is
 * meaningfully better than nothing, needs no scope we do not already have, and
 * nothing leaves our own infrastructure.
 *
 * Prior art: https://github.com/warmbly/warmbly (Apache-2.0) — its shared pool
 * is the part that needs their cloud rather than ours.
 */

export type Box = { email: string; domainId: string | null }

/**
 * Who writes to whom this round.
 *
 * Across domains only. A domain talking to itself proves nothing — the same
 * infrastructure vouching for itself is the weakest possible signal, and an
 * obvious pattern besides.
 *
 * The offset walks the list so pairings vary between rounds rather than the
 * same two mailboxes writing to each other forever, which would read as a
 * loop rather than correspondence.
 */
export function pairs(boxes: Box[], round = 0): { from: string; to: string }[] {
  if (boxes.length < 2) return []

  const out: { from: string; to: string }[] = []
  for (let i = 0; i < boxes.length; i++) {
    const from = boxes[i]

    // Walk forward from a rotating offset until a different domain turns up.
    for (let step = 1; step < boxes.length; step++) {
      const to = boxes[(i + round + step) % boxes.length]
      if (to.email === from.email) continue
      if (sameDomain(from, to)) continue
      out.push({ from: from.email, to: to.email })
      break
    }
  }
  return out
}

function sameDomain(a: Box, b: Box) {
  // The id is the truth when both have one; the address is the fallback, so a
  // mailbox not yet attached to a domain row still cannot warm itself.
  if (a.domainId && b.domainId) return a.domainId === b.domainId
  return domainOf(a.email) === domainOf(b.email)
}

/**
 * Whether a domain still needs warming.
 *
 * Stops on its own at the end of the ramp. Warm-up that never ends is just
 * background traffic that costs allowance forever.
 */
export const RAMP_DAYS = 21

export function stillWarming(daysWarming: number | null) {
  return daysWarming !== null && daysWarming <= RAMP_DAYS
}

/* ── what they say ─────────────────────────────────────────────────────────
   Short, plausible, internal. It has to read as a person writing to a
   colleague, because a receiving spam filter is looking at exactly that. No
   links, no attachments, nothing that resembles the outreach itself. */

const OPENERS = [
  'Quick one',
  'Following up',
  'Note on the schedule',
  'Re: the numbers',
  'Small thing',
  'This week',
  'Draft for review',
  'Checking in',
]

const BODIES = [
  'Had a look this morning — nothing blocking from my side. Will pick it up again tomorrow.',
  'Sending this over so it is written down somewhere. No action needed today.',
  'That looks right to me. I will confirm the rest once the figures are in.',
  'Thanks for turning that around quickly. Reading it properly this afternoon.',
  'Noted — I have put it on the list for next week rather than rushing it.',
  'All fine at this end. Shout if anything changes before Thursday.',
]

const REPLIES = [
  'Got it, thanks.',
  'Makes sense — nothing from me.',
  'Thanks, that answers it.',
  'Understood. Will follow up if anything shifts.',
  'Appreciated, all clear.',
]

/** Deterministic from the seed, so a given pairing reads consistently. */
const pick = <T>(list: T[], seed: number) => list[Math.abs(seed) % list.length]

const hash = (text: string) => {
  let n = 0
  for (let i = 0; i < text.length; i++) n = (n * 31 + text.charCodeAt(i)) | 0
  return n
}

export function note(from: string, to: string, round = 0) {
  const seed = hash(`${from}${to}${round}`)
  return {
    subject: pick(OPENERS, seed),
    body: `${pick(BODIES, seed >> 3)}\n\n—\n${from.split('@')[0]}`,
  }
}

export function reply(subject: string, seed = 0) {
  return {
    subject: subject.toLowerCase().startsWith('re:') ? subject : `Re: ${subject}`,
    body: pick(REPLIES, hash(subject) + seed),
  }
}
