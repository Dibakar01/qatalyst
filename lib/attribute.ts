import type { Trace } from './token.ts'

/**
 * Who gets the credit, and which letter earned it.
 *
 * The rule, in one line: **the token names the campaign, the address names the
 * person.** When they disagree that is a forward — Ada got the letter, sent it
 * to Bob, Bob signed up — and both halves are true at once. Bob is the
 * customer; Ada's letter is what produced him.
 *
 * The click id also beats last-touch on the campaign. Cold outbound runs
 * intro → nudge → revive over a quarter, so a click on letter one can easily
 * arrive after letter three went out. Last-touch would credit the newest send;
 * the token is evidence of the specific letter that was actually clicked, and
 * specific evidence wins over a default.
 *
 * Pure, and separate from the database work, because this precedence is the
 * part that is easy to get subtly wrong and impossible to notice afterwards —
 * a mis-attributed conversion looks exactly like a correctly attributed one.
 */

export type LastTouch = { id: string; campaignId: string } | null | undefined

export type Attribution = {
  contactId: string | null
  campaignId: string | null
  messageId: string | null
  /** How the campaign was decided, so a report can say rather than imply. */
  basis: 'click' | 'last-touch' | 'none'
  /** The letter went to one person and somebody else converted. */
  forwarded: boolean
}

export function attribute(
  trace: Trace | null | undefined,
  knownByEmail: string | null | undefined,
  lastTouch: LastTouch,
): Attribution {
  // The campaign: the clicked letter first, the most recent send otherwise.
  const campaignId = trace?.campaignId ?? lastTouch?.campaignId ?? null
  const basis = trace?.campaignId ? 'click' : lastTouch?.campaignId ? 'last-touch' : 'none'

  // The person: whoever this address belongs to, and only then whoever we
  // mailed. An address we recognise is a fact; the token is an inference about
  // who would be reading.
  const contactId = knownByEmail ?? trace?.contactId ?? null

  // Only a forward if we can see both halves and they differ. An unknown
  // address is not a forward — it is a stranger, which is its own good news.
  const forwarded = Boolean(trace?.contactId && knownByEmail && knownByEmail !== trace.contactId)

  return {
    contactId,
    campaignId,
    // The message belongs to the letter we credited, so a forwarded
    // conversion still points at the send that caused it rather than at
    // something the new person never received.
    messageId: trace?.campaignId ? null : (lastTouch?.id ?? null),
    basis,
    forwarded,
  }
}
