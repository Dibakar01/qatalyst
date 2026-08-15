/**
 * Writing the letter, from three questions rather than a blank template.
 *
 * The old flow handed you a textarea and a mail-merge syntax and wished you
 * luck. This asks the three things that actually determine whether a cold email
 * works — what kind of message, what you genuinely know about them, and the one
 * thing you are asking for — and assembles the template from that.
 *
 * The numbers below are from published cold-email research rather than taste:
 * 100–125 words, one call to action, a subject about them and not the product,
 * roughly 20% genuinely personal and 80% about the persona. The Cold Email Hall
 * of Fame is a gallery of examples rather than a rulebook, so what is encoded
 * here is the consensus across the guides, and every one of these is checkable.
 */

/** How long a body may be before it stops being read. */
export const WORDS = { min: 40, best: 125, max: 180 }

export type Kind = 'intro' | 'nudge' | 'revive'

export type Shape = {
  kind: Kind
  label: string
  /** What this message is for, in one line. */
  about: string
  /** The subject line template. */
  subject: string
  /** The body, with {{personalised}} where the model writes. */
  body: string
  /** What the model is told to put in that one slot. */
  prompt: string
}

/**
 * The three messages worth sending, as openable shapes.
 *
 * Not a template gallery — three because there are three moments: you have
 * never written to them, you have and they did not answer, or it has been long
 * enough that the old thread is dead. Each one is a different email, not a
 * different wording.
 */
export function shape(kind: Kind, ask: string, signoff: string): Shape {
  const closing = ask.trim() || 'Worth a quick word?'
  const from = signoff.trim() || 'Dibakar'

  const shapes: Record<Kind, Omit<Shape, 'kind'>> = {
    intro: {
      label: 'First time',
      about: 'They have never heard from us. Earn the reply with one specific observation.',
      // Lowercase, about them, no product name — a subject that looks like a
      // colleague wrote it rather than a campaign.
      subject: '{{company}}',
      body: `Hi {{first_name}},\n\n{{personalised}}\n\n${closing}\n\n${from}`,
      prompt:
        'Open with one specific, checkable observation about this person or their company, drawn only from the fields you are given. Then one sentence on why that makes us worth a conversation. Never flatter, never claim to have read something you were not told about.',
    },
    nudge: {
      label: 'No answer yet',
      about: 'A short second touch. Adds one new thing — never "just bumping this".',
      subject: 're: {{company}}',
      body: `Hi {{first_name}},\n\n{{personalised}}\n\n${closing}\n\n${from}`,
      prompt:
        'They did not reply to a first note. Add exactly one new and useful thing — a relevant example, a number, a short thought about their situation. Do not apologise, do not say you are following up, do not repeat the first email.',
    },
    revive: {
      label: 'Long time',
      about: 'Months have passed. Give a reason for writing now, or do not write.',
      subject: '{{company}} — a thought',
      body: `Hi {{first_name}},\n\n{{personalised}}\n\n${closing}\n\n${from}`,
      prompt:
        'It has been a long time. Give a concrete reason this is landing now — something that changed for them or for us. One sentence of context, one of why it matters to them.',
    },
  }

  return { kind, ...shapes[kind] }
}

export const KINDS: Kind[] = ['intro', 'nudge', 'revive']

/**
 * How many questions the compose flow asks: kind, audience, name, ask.
 *
 * Lives here because the page renders against it and the server action clamps
 * against it, and those two disagreeing sends Back to the wrong step.
 */
export const COMPOSE_STEPS = 4

/* ── the checks ───────────────────────────────────────────────────────────── */

export type Note = { level: 'stop' | 'warn'; text: string }

const words = (text: string) => text.trim().split(/\s+/).filter(Boolean).length

/**
 * Phrases that mark an email as bulk, and what to do instead.
 *
 * These are not banned words — they are the openings that tell a reader in the
 * first three words that a machine wrote this. Warned, never blocked: you are
 * allowed to disagree with the guidance.
 */
const TIRED: [RegExp, string][] = [
  [/\bi hope (this|you)\b/i, 'Opening with "I hope this finds you well" reads as a template.'],
  [/\bjust (checking|following|bumping|circling)\b/i, 'A nudge should add something, not announce itself.'],
  [/\bquick question\b/i, '"Quick question" is the most-used cold open there is.'],
  [/\breach(ing)? out\b/i, '"Reaching out" says nothing — say what you want.'],
  [/\bpick your brain\b/i, '"Pick your brain" asks for time without offering anything.'],
  [/\bgame.?chang(er|ing)|revolutionary|cutting.?edge|synerg/i, 'Hype words read as marketing.'],
  [/\b(free|guarantee|act now|limited time|risk.?free)\b/i, 'Reads as promotional and hurts deliverability.'],
]

/**
 * What is wrong with this letter, in the order it matters.
 *
 * `stop` is structural — the letter cannot do its job at all. `warn` is
 * practice: worth heeding, but yours to overrule. The split matters because a
 * checker that treats a stylistic quibble like a broken template gets ignored.
 */
export function review(subject: string, body: string, slot: string): Note[] {
  const notes: Note[] = []

  if (!body.includes(`{{${slot}}}`)) {
    notes.push({ level: 'stop', text: `No {{${slot}}} in the body, so the model has nothing to write.` })
  }
  if (!subject.trim()) {
    notes.push({ level: 'stop', text: 'No subject line.' })
  }

  // Count the fixed text only: the generated line is checked separately, by the
  // two readers, per message.
  const fixed = words(body.replace(new RegExp(`\\{\\{${slot}\\}\\}`, 'g'), ''))
  const whole = fixed + 45 // a generated paragraph is roughly this long
  if (whole > WORDS.max) {
    notes.push({
      level: 'warn',
      text: `About ${whole} words once written. Under ${WORDS.best} gets read; past ${WORDS.max} gets skimmed.`,
    })
  }
  if (fixed < WORDS.min - 20) {
    notes.push({ level: 'warn', text: 'Very short. There is no context around the generated line.' })
  }

  const subjectWords = words(subject.replace(/\{\{[^}]+\}\}/g, 'x'))
  if (subjectWords > 8) {
    notes.push({ level: 'warn', text: 'Subject is long. Short, specific subjects open better.' })
  }
  if (/[!?]{1}.*[!?]|[A-Z]{4,}/.test(subject)) {
    notes.push({ level: 'warn', text: 'Shouting in a subject line reads as bulk mail.' })
  }

  // One ask. Two questions give the reader a decision to make before replying.
  const asks = (body.match(/\?/g) ?? []).length
  if (asks > 1) {
    notes.push({ level: 'warn', text: `${asks} questions. One ask replies better than a choice.` })
  }
  if (asks === 0) {
    notes.push({ level: 'warn', text: 'No question, so there is nothing easy to reply to.' })
  }

  // Links in a first touch cost deliverability and are rarely clicked.
  if (/https?:\/\//i.test(body)) {
    notes.push({ level: 'warn', text: 'A raw link in the body hurts deliverability. {{link}} is tracked and added only if you want it.' })
  }

  for (const [pattern, text] of TIRED) {
    if (pattern.test(body) || pattern.test(subject)) notes.push({ level: 'warn', text })
  }

  return notes
}

/**
 * Which contact fields this letter actually leans on.
 *
 * A template that references a field half the list does not have produces half
 * an email with a hole in it. Naming the fields up front is what lets the
 * audience step warn before anything is generated.
 */
export function fieldsUsed(subject: string, body: string, prompt: string) {
  const used = new Set<string>()
  for (const text of [subject, body, prompt]) {
    for (const [, name] of text.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)) {
      if (name !== 'personalised' && name !== 'link') used.add(name)
    }
  }
  return [...used]
}
