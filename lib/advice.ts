import type { LetterRow, MailboxRow, SourceRow } from './reports.ts'
import type { Tuning } from './rules.ts'

/**
 * What the numbers are telling you to do.
 *
 * The mechanism is the one an ad platform uses: track an outcome, attribute it
 * to the thing that caused it, then shift effort toward what works. We already
 * track and attribute — clicks and enquiries carry their campaign and contact.
 * This is the third part, and it is deliberately a pure function over the
 * report rows so it can be tested without a database.
 *
 * The whole difficulty is **sample size**. A source with one enquiry from four
 * sends looks like a 250/1000 winner and is actually nothing. Every rule below
 * refuses to speak until it has enough to speak about, which is the same
 * principle as the bounce halt's twenty-attempt floor. Advice that fires on
 * noise gets ignored, and then the real advice gets ignored with it.
 */

export type Advice = {
  /** `acted` already happened by rule; `urgent` needs you; `idea` can wait. */
  level: 'acted' | 'urgent' | 'idea'
  title: string
  /** Why this is being said, in numbers. */
  why: string
  /** A one-click fix, when there is an honest one. */
  fix?: { label: string; href: string }
}

/** Below these, a rate is noise and no advice is offered at all. */
export const ENOUGH = {
  /** Sends before a click or reply rate means anything. */
  outcome: 40,
  /** Drafts before a flag rate means anything. */
  drafts: 12,
  /** Contacts before a source's quality can be judged. */
  imported: 25,
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`

export function advise(input: {
  mailboxes: MailboxRow[]
  sources: SourceRow[]
  letters: LetterRow[]
  tuning: Required<Tuning>
}): Advice[] {
  const { mailboxes, sources, letters, tuning } = input
  const out: Advice[] = []

  /* ── already done, by rule ─────────────────────────────────────────────
     Surfaced rather than announced: the sender halted these on its own, and
     a person who does not know that will spend an afternoon wondering why
     nothing is going out. */
  for (const box of mailboxes.filter((m) => m.halted)) {
    out.push({
      level: 'acted',
      title: `${box.email} stopped itself`,
      why: `${pct(box.bounceRate)} of ${box.sentEver + box.bounced} attempts bounced, over your ${(tuning.bounceThreshold / 100).toFixed(1)}% line. Its campaigns were paused automatically.`,
      fix: { label: 'See the list behind it', href: '/?view=book&status=catch_all' },
    })
  }

  /* ── needs a person now ────────────────────────────────────────────── */

  // Close to the line but not over it: the one moment where acting early is
  // worth something, because after the halt the damage is already done.
  for (const box of mailboxes) {
    if (box.halted || box.towardHalt < 0.7) continue
    out.push({
      level: 'urgent',
      title: `${box.email} is close to stopping`,
      why: `${pct(box.bounceRate)} bounced, and your line is ${(tuning.bounceThreshold / 100).toFixed(1)}%. Verify the addresses it is sending to before it halts on its own.`,
      fix: { label: 'Enrich unverified', href: '/?view=book&status=unverified' },
    })
  }

  // A prompt that invents things. Flag rate is the only direct read on prompt
  // quality anywhere in the system.
  for (const letter of letters) {
    if (letter.written < ENOUGH.drafts || letter.flagRate <= 0.3) continue
    out.push({
      level: 'urgent',
      title: `“${letter.name}” is inventing things`,
      why: `${pct(letter.flagRate)} of ${letter.written} drafts were flagged. That is the prompt reaching past what we actually know about these people.`,
      fix: { label: 'Open the prompt', href: `/?c=${letter.id}&step=1` },
    })
  }

  /* ── worth doing, once there is enough to judge ────────────────────── */

  // The shift: which letter is actually producing. Only spoken when both have
  // enough sends to be compared at all.
  const ranked = letters.filter((l) => l.sent >= ENOUGH.outcome)
  if (ranked.length >= 2) {
    const rate = (l: LetterRow) => l.clickRate + l.replyRate
    const best = ranked.reduce((a, b) => (rate(b) > rate(a) ? b : a))
    const worst = ranked.reduce((a, b) => (rate(b) < rate(a) ? b : a))
    // A difference worth acting on, not a rounding error between two.
    if (best !== worst && rate(best) >= rate(worst) * 2 && rate(best) > 0) {
      out.push({
        level: 'idea',
        title: `“${best.name}” is working ${(rate(best) / Math.max(rate(worst), 0.001)).toFixed(1)}× better than “${worst.name}”`,
        why: `${pct(rate(best))} of ${best.sent} sent got a click or a reply, against ${pct(rate(worst))} of ${worst.sent}. Write the next one like the first.`,
        fix: { label: `Read “${best.name}”`, href: `/?c=${best.id}&step=1` },
      })
    }
  }

  // A source that imports a lot and produces nothing sendable is the most
  // expensive kind of useless — you pay per record, not per usable record.
  for (const source of sources) {
    if (source.contacts < ENOUGH.imported) continue
    const usable = source.sendable / source.contacts
    if (usable >= 0.5) continue
    out.push({
      level: 'idea',
      title: `Only ${pct(usable)} of “${source.source}” can be written to`,
      why: `${source.contacts} imported, ${source.sendable} usable. The rest are unverified or invalid — enrichment may rescue them, or the source is not worth its price.`,
      fix: { label: 'Enrich unverified', href: '/?view=book&status=unverified' },
    })
  }

  // And the opposite: a source that is quietly the best one you have.
  const producing = sources.filter((s) => s.sent >= ENOUGH.outcome)
  if (producing.length >= 2) {
    const best = producing.reduce((a, b) => (b.yieldPerThousand > a.yieldPerThousand ? b : a))
    if (best.enquired > 0) {
      out.push({
        level: 'idea',
        title: `“${best.source}” is your best source`,
        why: `${best.enquired} ${best.enquired === 1 ? 'enquiry' : 'enquiries'} from ${best.sent} sent — ${best.yieldPerThousand.toFixed(1)} per thousand, ahead of everything else. Buy more of this shape of list.`,
        fix: { label: 'Sources', href: '/?view=sources' },
      })
    }
  }

  // Nothing measurable yet is itself worth saying, so an empty report does not
  // read as a broken one.
  if (out.length === 0) {
    const sent = letters.reduce((t, l) => t + l.sent, 0)
    out.push({
      level: 'idea',
      title: sent === 0 ? 'Nothing has gone out yet' : 'Too early to tell',
      why:
        sent === 0
          ? 'Advice needs outcomes to work from. Approve some drafts and put a letter in the post.'
          : `${sent} sent so far. Rates start meaning something around ${ENOUGH.outcome} per letter.`,
    })
  }

  // Acted first — you need to know what the machine already did — then urgent,
  // then ideas.
  const order = { acted: 0, urgent: 1, idea: 2 }
  return out.sort((a, b) => order[a.level] - order[b.level])
}
