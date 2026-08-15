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
 * Rule 4, enforced in code: every body carries a plain-language opt-out and a
 * working link. This is the only function that produces a sendable body, so
 * there is no path that forgets it. No List-Unsubscribe header — that is a bulk
 * sender's signal and hurts a person-to-person email.
 */
export function assembleBody(rendered: string, unsubscribeUrl: string) {
  return `${rendered.trimEnd()}\n\nIf you would rather I did not write again, tell me and I will stop — or unsubscribe here:\n${unsubscribeUrl}\n`
}
