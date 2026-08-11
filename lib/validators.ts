import type { Contact } from '../db/schema.ts'

export type Flag = 'ungrounded' | 'thin'

type Subject = Pick<Contact, 'firstName' | 'lastName' | 'company' | 'title' | 'context'>

const STOPWORDS = new Set(
  `a an and are as at be been but by for from had has have he her hi hello his i if in is it its
   me my of on or our so that the their them there they this to us was we were what when which who
   will with you your yours just really very much thanks thank`.split(/\s+/),
)

const words = (text: string) =>
  text
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .filter(Boolean)

/**
 * Every word we actually know about this contact. A set of whole words, not one
 * long string — "Series B" must not count as grounded just because some other
 * field happens to contain the letter b.
 */
const known = (contact: Subject) =>
  new Set(
    [
      contact.firstName,
      contact.lastName,
      contact.company,
      contact.title,
      ...Object.values(contact.context),
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  )

/**
 * Grounding (rule 5a). Pulls the specific claims out of the personalised text —
 * numbers, and capitalised words that are not just the start of a sentence —
 * and requires each to appear in what we know about this contact. A model that
 * invents a funding round, a conference or a colleague gets caught here.
 *
 * ponytail: deliberate heuristic, not an LLM judge. It is deterministic, free
 * and unit-testable; an LLM judge would be none of those. Two known blind
 * spots, both in the safe direction bar one: it over-flags unusual proper nouns
 * (fine — flagged means reviewed), and it ignores the first word of a sentence,
 * so an invented name that opens a sentence slips through. Upgrade to a real
 * NER pass if that shows up in practice.
 */
export function claims(text: string) {
  const found = new Set<string>()

  for (const [number] of text.matchAll(/\d[\d,.]*\d|\d/g)) found.add(number.replace(/[.,]$/, ''))

  for (const sentence of text.split(/(?<=[.!?:;])\s+|\n+/)) {
    const tokens = sentence.trim().split(/\s+/)
    tokens.forEach((raw, index) => {
      const token = raw.replace(/^[^\w]+|[^\w]+$/g, '')
      if (index === 0 || !token || token === 'I') return
      if (/^[A-Z0-9]/.test(token)) found.add(token)
    })
  }

  return [...found]
}

const parts = (claim: string) => claim.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)

export function ungrounded(text: string, contact: Subject) {
  const vocabulary = known(contact)
  return claims(text).filter((claim) => parts(claim).some((part) => !vocabulary.has(part)))
}

/**
 * Substance (rule 5b). Strip the contact's own name, title and company, plus
 * ordinary filler, and see whether anything is left. If not, the "personalised"
 * line is mail-merge wearing a costume, which reads worse than a short honest
 * email.
 */
const SUBSTANCE_MINIMUM = 4

export function substance(text: string, contact: Subject) {
  const own = new Set(
    words([contact.firstName, contact.lastName, contact.company, contact.title].filter(Boolean).join(' ')),
  )
  return new Set(words(text).filter((word) => !own.has(word) && !STOPWORDS.has(word) && word.length > 1))
}

/** Both validators. A message can only reach `approved` with an empty result. */
export function validate(personalised: string, contact: Subject): Flag[] {
  const flags: Flag[] = []
  if (ungrounded(personalised, contact).length > 0) flags.push('ungrounded')
  if (substance(personalised, contact).size < SUBSTANCE_MINIMUM) flags.push('thin')
  return flags
}
