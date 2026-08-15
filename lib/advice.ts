import type { LetterRow, MailboxRow, SourceRow } from './reports.ts'
import type { Tuning } from './rules.ts'
import { interval, readable, sendsNeeded, separates } from './stats.ts'

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

/**
 * The floors that remain, and why only these.
 *
 * Rates are no longer judged against a constant — `lib/stats.ts` decides
 * whether two of them are actually different. These are only the point below
 * which it is not worth doing the arithmetic at all.
 *
 * The old `ENOUGH.outcome = 40` claimed forty sends could pick a winner. At the
 * published 3.4% median reply rate it takes around 750 per variant, so that
 * number was wrong by nearly twenty times and every winner it called was noise.
 */
export const ENOUGH = {
  /** Anything at all to compute a rate from. */
  outcome: 10,
  /** Flag rate has a high base rate, so it settles fast — but not at n=2. */
  drafts: 12,
  /** Contacts before a source's usable share is worth reporting. */
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

  // Which letter is actually producing — decided by whether the confidence
  // intervals separate, not by whether one number is bigger than another.
  // At cold-email response rates they usually will not, and saying so with a
  // figure for how much more would settle it is more use than a false winner.
  const ranked = letters.filter((l) => l.sent >= ENOUGH.outcome)
  if (ranked.length >= 2) {
    const band = (l: LetterRow) => interval(l.clicked + l.replied, l.sent)
    const best = ranked.reduce((a, b) => (band(b).rate > band(a).rate ? b : a))
    const worst = ranked.reduce((a, b) => (band(b).rate < band(a).rate ? b : a))

    if (best !== worst) {
      const high = band(best)
      const low = band(worst)

      if (separates(high, low)) {
        out.push({
          level: 'idea',
          title: `“${best.name}” really is beating “${worst.name}”`,
          why: `${readable(high)} of ${high.n} sent got a click or a reply, against ${readable(low)} of ${low.n}. The ranges do not overlap, so this is a real difference. Write the next one like the first.`,
          fix: { label: `Read “${best.name}”`, href: `/?c=${best.id}&step=1` },
        })
      } else if (high.rate > low.rate) {
        const more = sendsNeeded(high, low)
        out.push({
          level: 'idea',
          title: `“${best.name}” looks better, but not provably`,
          why:
            more === null
              ? `Both are running at the same rate so far.`
              : `${readable(high)} against ${readable(low)} — the ranges still overlap, so the gap could be luck. About ${more.toLocaleString()} more sends each would settle it.`,
        })
      }
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
    const got = letters.reduce((t, l) => t + l.clicked + l.replied, 0)
    const band = interval(got, sent)
    out.push({
      level: 'idea',
      title: sent === 0 ? 'Nothing has gone out yet' : 'Nothing conclusive yet',
      why:
        sent === 0
          ? 'Advice needs outcomes to work from. Approve some drafts and put a letter in the post.'
          : `${got} of ${sent} sent got a click or a reply — somewhere between ${readable(band)}. Cold outbound runs around 3% and it takes several hundred sends before a rate means much.`,
    })
  }

  // Acted first — you need to know what the machine already did — then urgent,
  // then ideas.
  const order = { acted: 0, urgent: 1, idea: 2 }
  return out.sort((a, b) => order[a.level] - order[b.level])
}
