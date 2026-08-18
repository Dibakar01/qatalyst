import type { Contact } from '../db/schema.ts'

/** The one slot the model writes. Everything else in a template is fixed text. */
export const SLOT = 'personalised'

const TOKEN = /\{\{\s*([^{}]+?)\s*\}\}/g

/**
 * Values a template may reference: the mapped fields plus anything in context.
 *
 * `{{link}}` and `{{personalised}}` are supplied by the generator rather than
 * here, because both need to know which campaign is being written.
 */
export function variables(contact: Pick<Contact, 'firstName' | 'lastName' | 'company' | 'title' | 'context'>) {
  return {
    first_name: contact.firstName ?? '',
    last_name: contact.lastName ?? '',
    company: contact.company ?? '',
    title: contact.title ?? '',
    ...Object.fromEntries(Object.entries(contact.context).map(([k, v]) => [`context.${k}`, v])),
  } as Record<string, string>
}

export function fill(template: string, values: Record<string, string>) {
  return template.replace(TOKEN, (_, name: string) => values[name] ?? '')
}

/** Template variables this contact has no value for — an empty gap in the email. */
export function missing(template: string, values: Record<string, string>) {
  const gaps = new Set<string>()
  for (const [, name] of template.matchAll(TOKEN)) {
    if (name !== SLOT && !values[name]) gaps.add(name)
  }
  return [...gaps]
}

/**
 * RFC 8058 one-click unsubscribe, as the headers a transport must attach.
 *
 * These were left out on the argument that List-Unsubscribe is a bulk sender's
 * signal and hurts a person-to-person email. The threshold is 5,000 messages a
 * day to Gmail addresses and this sends around a thousand in total, so the
 * omission was defensible — but the classification is not reversible. Cross
 * 5,000 once, on any subdomain, and Gmail treats the parent domain as a bulk
 * sender from then on; dropping the volume again does not undo it. Enforcement
 * moved to permanent rejections in November 2025. A few lines now, against a
 * classification that can be crossed by accident.
 *
 * Exactly one HTTPS URI, which is what One-Click asks for — a mailto alongside
 * it is legal but gives a provider a second thing to choose between, and this
 * link is already a POST target. `List-Unsubscribe-Post` is emitted only for an
 * HTTPS link: over anything else a provider is entitled to ignore it, and
 * advertising a one-click we cannot honour is worse than not advertising one.
 */
export function unsubscribeHeaders(unsubscribeUrl: string): Record<string, string> {
  const headers: Record<string, string> = { 'List-Unsubscribe': `<${unsubscribeUrl}>` }
  if (unsubscribeUrl.startsWith('https://')) {
    headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click'
  }
  return headers
}

/**
 * Rule 4, enforced in code: every body carries a plain-language opt-out and a
 * working link. This is the only function that produces a sendable body, so
 * there is no path that forgets it.
 *
 * It returns the headers with the text because the opt-out is one thing in two
 * places — the sentence a person reads and the header their mail client acts on
 * — and separating them is how one of them goes stale. `lib/gmail.ts` builds the
 * same headers from the same function at the wire, for the same reason the
 * suppression check is repeated there: a caller assembling a message by hand
 * must not be able to leave it off.
 */
export function assembleBody(rendered: string, unsubscribeUrl: string) {
  return {
    body: `${rendered.trimEnd()}\n\nIf you would rather I did not write again, tell me and I will stop — or unsubscribe here:\n${unsubscribeUrl}\n`,
    headers: unsubscribeHeaders(unsubscribeUrl),
  }
}
