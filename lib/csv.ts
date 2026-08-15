import type { NewContact } from '../db/schema.ts'
import { isValidEmail, normalise } from './email.ts'

export const FIELDS = [
  'first_name',
  'last_name',
  'email',
  'company',
  'title',
  'linkedin_url',
  'source',
  'email_status',
  'consent_status',
] as const

export type Field = (typeof FIELDS)[number]
/** field -> CSV header. Set by hand in the UI; headers are never guessed. */
export type Mapping = Partial<Record<Field, string>>

export type Row = Record<string, string>

export type MapResult = { contact: NewContact } | { error: string }

type EmailStatus = NonNullable<NewContact['emailStatus']>

/**
 * Verification vendors all spell these differently. Anything unrecognised falls
 * back to `unverified`, which is the never-send default — a typo in a CSV must
 * not be able to promote an address to sendable.
 */
const EMAIL_STATUS_ALIASES: Record<string, EmailStatus> = {
  valid: 'verified',
  verified: 'verified',
  deliverable: 'verified',
  ok: 'verified',
  safe: 'verified',
  catch_all: 'catch_all',
  'catch-all': 'catch_all',
  catchall: 'catch_all',
  accept_all: 'catch_all',
  'accept-all': 'catch_all',
  invalid: 'invalid',
  undeliverable: 'invalid',
  bounced: 'invalid',
  bounce: 'invalid',
}

export const asEmailStatus = (raw: string): EmailStatus =>
  EMAIL_STATUS_ALIASES[raw.trim().toLowerCase().replace(/\s+/g, '_')] ?? 'unverified'

// Consent is opt-in only when the CSV says so unambiguously.
const CONSENT_YES = new Set(['opted_in', 'opted-in', 'opt_in', 'true', 'yes', 'y', '1', 'subscribed'])

/**
 * Pure: one CSV row + a mapping -> a contact, or a reason it was rejected.
 * Every column the mapping does not claim lands in `context` rather than the bin.
 */
export function mapRow(row: Row, mapping: Mapping): MapResult {
  const get = (f: Field) => {
    const header = mapping[f]
    return header ? String(row[header] ?? '').trim() : ''
  }

  const email = normalise(get('email'))
  const linkedinUrl = get('linkedin_url')

  if (!email && !linkedinUrl) return { error: 'no email or linkedin_url' }
  if (email && !isValidEmail(email)) return { error: `malformed email: ${email}` }

  const claimed = new Set(Object.values(mapping).filter(Boolean) as string[])
  const context: Record<string, string> = {}
  for (const [k, v] of Object.entries(row)) {
    const value = String(v ?? '').trim()
    if (!claimed.has(k) && value) context[k] = value
  }

  return {
    contact: {
      firstName: get('first_name') || null,
      lastName: get('last_name') || null,
      email: email || null,
      company: get('company') || null,
      title: get('title') || null,
      linkedinUrl: linkedinUrl || null,
      source: get('source') || null,
      emailStatus: asEmailStatus(get('email_status')),
      consentStatus: CONSENT_YES.has(get('consent_status').toLowerCase()) ? 'opted_in' : 'none',
      context,
    },
  }
}
