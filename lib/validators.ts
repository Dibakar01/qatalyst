import type { Contact } from '../db/schema.ts'

export type Flag = 'ungrounded' | 'thin' | 'salesy' | 'links' | 'shouting'

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
/**
 * The words that get mail filtered.
 *
 * Deliberately short. A long list flags every honest sentence and trains people
 * to ignore the warning, which costs more than it saves — these are the ones
 * that read as advertising rather than as a person writing.
 */
const SPAM = [
  /\bfree\s+(trial|demo|consultation)\b/i,
  /\bact\s+now\b/i,
  /\blimited\s+time\b/i,
  /\bno\s+obligation\b/i,
  /\bguarantee[ds]?\b/i,
  /\brisk[- ]free\b/i,
  /\bclick\s+here\b/i,
  /\b100%\b/,
  /\bcheapest\b/i,
  /\bbest\s+price\b/i,
]

/**
 * What would send this to spam, on the text itself.
 *
 * Runs beside the two validators that were already here rather than as a
 * separate surface, so a draft has one verdict rather than three.
 */
export function spammy(text: string): Flag[] {
  const flags: Flag[] = []

  if (SPAM.some((pattern) => pattern.test(text))) flags.push('salesy')

  // More than one link in a first touch reads as a campaign, not a note. The
  // opt-out link is added after this runs, so it is not counted here.
  if ((text.match(/https?:\/\//g) ?? []).length > 1) flags.push('links')

  // Shouting. Measured on words rather than characters so an acronym like CTO
  // or API does not trip it.
  // Only words of four letters or more, which is what keeps CTO, API and SDK
  // out of it — and is why the floor below can be low enough to catch a short
  // shouted line without flagging ordinary B2B copy.
  const words = text.split(/\s+/).filter((w) => /[A-Za-z]{4,}/.test(w))
  const shouted = words.filter((w) => w === w.toUpperCase())
  if (words.length >= 5 && shouted.length / words.length > 0.2) flags.push('shouting')

  // Punctuation that reads as a advert rather than a person.
  if (/!{2,}|\?{2,}/.test(text)) flags.push('shouting')

  return [...new Set(flags)]
}

export function validate(personalised: string, contact: Subject): Flag[] {
  const flags: Flag[] = []
  if (ungrounded(personalised, contact).length > 0) flags.push('ungrounded')
  if (substance(personalised, contact).size < SUBSTANCE_MINIMUM) flags.push('thin')
  flags.push(...spammy(personalised))
  return [...new Set(flags)]
}
