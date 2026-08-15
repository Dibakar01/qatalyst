import { resolveTxt } from 'node:dns/promises'

/**
 * Is this domain allowed to send mail as itself?
 *
 * SPF, DKIM and DMARC are the largest single factor in whether cold mail lands
 * in an inbox or a spam folder, and nothing here checked them. A domain can be
 * perfectly warmed, perfectly paced, and still fail because a DNS record is
 * missing — which looks exactly like the copy being bad.
 *
 * `node:dns` rather than a library: this is three TXT lookups.
 */

export type Check = { ok: boolean; note: string; value?: string }
export type Authentication = {
  spf: Check
  dkim: Check
  dmarc: Check
  /** Safe to send from. False means fix DNS before doing anything else. */
  ok: boolean
}

/** Flattened, because a long TXT record arrives as several strings. */
async function txt(name: string): Promise<string[]> {
  try {
    return (await resolveTxt(name)).map((chunks) => chunks.join(''))
  } catch {
    // NXDOMAIN and friends. Absence is the answer, not an error to throw.
    return []
  }
}

/** The rules, kept pure so they can be tested against fixture records. */
export function readSpf(records: string[]): Check {
  const spf = records.find((r) => r.toLowerCase().startsWith('v=spf1'))
  if (!spf) return { ok: false, note: 'No SPF record. Receivers cannot tell our mail from a forgery.' }
  // +all publishes "anyone may send as us", which is worse than no record.
  if (/[+]all\b/.test(spf)) return { ok: false, note: 'SPF ends in +all, which authorises the whole internet.', value: spf }
  if (!/[-~]all\b/.test(spf)) {
    return { ok: false, note: 'SPF has no -all or ~all, so it never actually fails anyone.', value: spf }
  }
  return { ok: true, note: 'Signed for by SPF.', value: spf }
}

export function readDkim(records: string[]): Check {
  const dkim = records.find((r) => r.toLowerCase().includes('v=dkim1'))
  if (!dkim) return { ok: false, note: 'No DKIM key at google._domainkey. Mail is unsigned.' }
  if (/\bp=\s*(;|$)/.test(dkim)) {
    return { ok: false, note: 'DKIM key is empty, which revokes the signature.', value: dkim }
  }
  return { ok: true, note: 'Mail is signed.', value: dkim }
}

export function readDmarc(records: string[]): Check {
  const dmarc = records.find((r) => r.toLowerCase().startsWith('v=dmarc1'))
  if (!dmarc) {
    return { ok: false, note: 'No DMARC record. Gmail and Yahoo now require one for bulk senders.' }
  }
  const policy = dmarc.match(/\bp=(none|quarantine|reject)\b/i)?.[1]?.toLowerCase()
  if (!policy) return { ok: false, note: 'DMARC record has no policy.', value: dmarc }
  // p=none is a valid, published policy: it monitors rather than enforces, and
  // it satisfies the bulk-sender requirement. Worth saying, not worth blocking.
  if (policy === 'none') {
    return { ok: true, note: 'DMARC is monitoring only (p=none). Tighten it once reports look clean.', value: dmarc }
  }
  return { ok: true, note: `DMARC is enforcing (p=${policy}).`, value: dmarc }
}

/** All three, for one domain. */
export async function checkDomain(domain: string): Promise<Authentication> {
  const [spfRecords, dkimRecords, dmarcRecords] = await Promise.all([
    txt(domain),
    // Google's default selector. A domain signing with another one will read as
    // missing here, which is a false alarm worth the true ones it catches.
    txt(`google._domainkey.${domain}`),
    txt(`_dmarc.${domain}`),
  ])

  const spf = readSpf(spfRecords)
  const dkim = readDkim(dkimRecords)
  const dmarc = readDmarc(dmarcRecords)
  return { spf, dkim, dmarc, ok: spf.ok && dkim.ok && dmarc.ok }
}
