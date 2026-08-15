/**
 * What Google actually thinks of a sending domain.
 *
 * Google judges senders on a user-reported spam rate below 0.3% and publishes
 * that figure through exactly one place: Postmaster Tools. No open-source tool
 * can produce it — only Google holds the data — so this is the one closed
 * dependency in the system, and it is free.
 *
 * Everything the sender does until now is inference: bounces tell us an
 * address is dead, opt-outs tell us somebody was annoyed enough to click. This
 * is the number itself.
 *
 * https://support.google.com/a/answer/81126
 * https://developers.google.com/workspace/gmail/postmaster/reference/rest/v1/domains.trafficStats
 */

const API = 'https://gmailpostmastertools.googleapis.com/v1'

/** Google's own categories, worst first. */
export type Reputation = 'BAD' | 'LOW' | 'MEDIUM' | 'HIGH'

export type TrafficStats = {
  name?: string
  userReportedSpamRatio?: number
  userReportedSpamRatioLowerBound?: number
  userReportedSpamRatioUpperBound?: number
  domainReputation?: Reputation | 'REPUTATION_CATEGORY_UNSPECIFIED'
  spfSuccessRatio?: number
  dkimSuccessRatio?: number
  dmarcSuccessRatio?: number
}

/** The line Google enforces, in basis points. 30 = 0.30%. */
export const SPAM_LIMIT = 30

/** Where to get worried, well before the line. */
export const SPAM_WARN = 10

export type Verdict = {
  /** Basis points, upper bound. Null when Google has no data for this domain. */
  spamRatio: number | null
  reputation: Reputation | null
  /** Over Google's own line — this domain is in trouble now. */
  over: boolean
  /** Heading there. Worth acting on while it is still cheap. */
  warn: boolean
  auth: { spf: number | null; dkim: number | null; dmarc: number | null }
  note: string
}

/**
 * Read a day's stats into a verdict.
 *
 * Pure, so the thresholds can be tested without a Google account.
 *
 * Uses the **upper** bound rather than the point estimate. Google publishes a
 * 95% interval and the honest question before burning a domain is "how bad
 * could this be", not "what is the average" — the same reasoning the advice
 * engine already applies to our own rates.
 */
export function readStats(stats: TrafficStats | null | undefined): Verdict {
  const ratio =
    stats?.userReportedSpamRatioUpperBound ?? stats?.userReportedSpamRatio ?? null
  const spamRatio = ratio === null ? null : Math.round(ratio * 10_000)

  const category = stats?.domainReputation
  const reputation =
    category && category !== 'REPUTATION_CATEGORY_UNSPECIFIED' ? category : null

  const over = spamRatio !== null && spamRatio > SPAM_LIMIT
  const warn = !over && spamRatio !== null && spamRatio >= SPAM_WARN

  const pct = (n: number) => `${(n / 100).toFixed(2)}%`
  const note =
    spamRatio === null
      ? 'No data yet. Postmaster Tools needs a few hundred messages a day to Gmail before it reports.'
      : over
        ? `${pct(spamRatio)} of recipients marked it as spam — over Google's 0.30% line.`
        : warn
          ? `${pct(spamRatio)} marked as spam. Under the 0.30% line, but heading for it.`
          : `${pct(spamRatio)} marked as spam. Comfortably under the line.`

  return {
    spamRatio,
    reputation,
    over,
    warn,
    auth: {
      spf: stats?.spfSuccessRatio ?? null,
      dkim: stats?.dkimSuccessRatio ?? null,
      dmarc: stats?.dmarcSuccessRatio ?? null,
    },
    note,
  }
}

/** Postmaster reports a day at a time, and the latest complete one is yesterday. */
export const statsDay = (now = new Date()) => {
  const d = new Date(now)
  d.setDate(d.getDate() - 1)
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
}

/**
 * Yesterday's figures for one domain. Null when Google has nothing to say.
 *
 * Never throws: this is a nice-to-have on top of the sender, and a Postmaster
 * outage or a domain that was never verified must not stop mail going out.
 */
export async function trafficFor(domain: string, token: string, now = new Date()) {
  try {
    const response = await fetch(`${API}/domains/${domain}/trafficStats/${statsDay(now)}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    })
    // 404 is the normal answer for a domain below the reporting threshold, or
    // one not yet verified — not an error worth shouting about.
    if (!response.ok) return null
    return (await response.json()) as TrafficStats
  } catch {
    return null
  }
}
