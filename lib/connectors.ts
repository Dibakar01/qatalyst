import type { Mapping, Row } from './csv.ts'

/**
 * Where contacts come from.
 *
 * A connector's whole job is to produce rows and say which column is which.
 * Everything after that — deduplication, the suppression check, keeping the
 * unmapped columns as context, refusing a malformed address — already happens
 * in `runImport()`, and a source that skipped it would be a source that can
 * mail someone who asked us to stop. So there is deliberately no second import
 * path: every connector feeds the one that already exists.
 *
 * Two shapes:
 *
 *   pull   we call them          (Apollo)
 *   push   rows arrive at us     (a CSV drop, a LinkedIn exporter's webhook)
 *
 * Push connectors need no code beyond a column preset, which is why the
 * LinkedIn integration is a table of header names rather than a scraper.
 */

export type Pull = { rows: Row[]; mapping: Mapping; source: string }

/** Whether a connector can run right now, and in plain words why not. */
export type Ready = { ok: true } | { ok: false; why: string }

/* ── push: column presets ─────────────────────────────────────────────────────
   Sales Navigator has no export API, so in practice a list leaves LinkedIn
   through one of these tools. Each spells the same six fields differently;
   that difference is the entire integration. Headers are still never guessed —
   a preset is a decision someone made once, written down. */

export const PRESETS: Record<string, { label: string; note: string; mapping: Mapping }> = {
  evaboot: {
    label: 'Evaboot',
    note: 'Sales Navigator export, emails already verified by Evaboot.',
    mapping: {
      first_name: 'First Name',
      last_name: 'Last Name',
      email: 'Email',
      company: 'Company',
      title: 'Title',
      linkedin_url: 'Linkedin Profile',
      email_status: 'Email Status',
    },
  },
  phantombuster: {
    label: 'PhantomBuster',
    note: 'Sales Navigator Search Export phantom.',
    mapping: {
      first_name: 'firstName',
      last_name: 'lastName',
      email: 'email',
      company: 'companyName',
      title: 'title',
      linkedin_url: 'profileUrl',
    },
  },
  clay: {
    label: 'Clay',
    note: 'A Clay table exported as CSV, or posted from a Clay webhook.',
    mapping: {
      first_name: 'First Name',
      last_name: 'Last Name',
      email: 'Work Email',
      company: 'Company Name',
      title: 'Job Title',
      linkedin_url: 'LinkedIn URL',
    },
  },
  apollo_csv: {
    label: 'Apollo (CSV export)',
    note: "Apollo's own export, for lists pulled from their UI rather than the API.",
    mapping: {
      first_name: 'First Name',
      last_name: 'Last Name',
      email: 'Email',
      company: 'Company',
      title: 'Title',
      linkedin_url: 'Person Linkedin Url',
      email_status: 'Email Status',
    },
  },
}

export type Preset = keyof typeof PRESETS

/* ── pull: Apollo ─────────────────────────────────────────────────────────── */

const APOLLO = 'https://api.apollo.io/api/v1'

export const apolloReady = (): Ready =>
  process.env.APOLLO_API_KEY
    ? { ok: true }
    : { ok: false, why: 'APOLLO_API_KEY is not set, so nothing can be pulled or enriched.' }

async function apollo(path: string, body: Record<string, unknown>) {
  const key = process.env.APOLLO_API_KEY
  if (!key) throw new Error('APOLLO_API_KEY is not set')

  const res = await fetch(`${APOLLO}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      'x-api-key': key,
    },
    body: JSON.stringify(body),
  })

  // Apollo gates most of search behind a paid plan and answers 403. Saying so
  // is the whole point — a connector that returned zero rows would look like a
  // search that found nobody.
  if (res.status === 403) {
    throw new Error(
      'Apollo refused this endpoint on the current plan. People Search needs a paid plan; enrichment works on free.',
    )
  }
  if (res.status === 429) throw new Error('Apollo rate limit reached. Try again shortly.')
  if (!res.ok) throw new Error(`Apollo ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return res.json() as Promise<Record<string, unknown>>
}

type ApolloPerson = {
  first_name?: string
  last_name?: string
  email?: string
  title?: string
  linkedin_url?: string
  organization?: { name?: string; website_url?: string }
  email_status?: string
  city?: string
  country?: string
}

/** Apollo's field names, once, so both search and enrich land the same shape. */
const APOLLO_MAPPING: Mapping = {
  first_name: 'first_name',
  last_name: 'last_name',
  email: 'email',
  company: 'company',
  title: 'title',
  linkedin_url: 'linkedin_url',
  email_status: 'email_status',
}

const asRow = (p: ApolloPerson): Row => ({
  first_name: p.first_name ?? '',
  last_name: p.last_name ?? '',
  email: p.email ?? '',
  company: p.organization?.name ?? '',
  title: p.title ?? '',
  linkedin_url: p.linkedin_url ?? '',
  email_status: p.email_status ?? '',
  // Everything else rides along as context, which is what the personalisation
  // is allowed to draw on later.
  location: [p.city, p.country].filter(Boolean).join(', '),
  website: p.organization?.website_url ?? '',
})

export type ApolloSearch = {
  titles?: string
  locations?: string
  domains?: string
  perPage?: string
}

/**
 * People Search. Paid-plan only in practice — it throws a sentence you can read
 * rather than returning nothing, so a gated plan never looks like an empty
 * result.
 */
export async function apolloPull(config: ApolloSearch, limit = 25): Promise<Pull> {
  const split = (v?: string) =>
    (v ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)

  const body = await apollo('/mixed_people/search', {
    person_titles: split(config.titles),
    person_locations: split(config.locations),
    q_organization_domains_list: split(config.domains),
    page: 1,
    per_page: Math.min(limit, 100),
  })

  const people = (body.people ?? body.contacts ?? []) as ApolloPerson[]
  return {
    rows: people.map(asRow).filter((r) => r.email || r.linkedin_url),
    mapping: APOLLO_MAPPING,
    source: `apollo:${split(config.titles).join('/') || 'search'}`,
  }
}

/**
 * Enrichment, which is what the free plan actually reaches.
 *
 * Takes addresses you already hold and fills in what Apollo knows about them —
 * including `email_status`, which is the field that decides whether an address
 * may ever be sent to at all.
 */
export async function apolloEnrich(emails: string[]): Promise<Pull> {
  if (emails.length === 0) return { rows: [], mapping: APOLLO_MAPPING, source: 'apollo:enrich' }

  const body = await apollo('/people/bulk_match', {
    details: emails.slice(0, 10).map((email) => ({ email })),
  })

  const matches = (body.matches ?? []) as (ApolloPerson | null)[]
  return {
    rows: matches.filter((p): p is ApolloPerson => Boolean(p?.email)).map(asRow),
    mapping: APOLLO_MAPPING,
    source: 'apollo:enrich',
  }
}
