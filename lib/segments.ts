import { and, eq, inArray, isNull, sql as raw } from 'drizzle-orm'
import { db } from '../db/index.ts'
import { contacts, STAGES, type Contact } from '../db/schema.ts'
import { SENDABLE } from './contacts.ts'

/**
 * Who a letter is for.
 *
 * Two different questions, so two different mechanisms. A **segment** says what
 * kind of person this is — "SaaS founders", "met at PyCon" — and someone can be
 * in several. A **stage** says how far the conversation has got, and someone is
 * in exactly one.
 *
 * The stages the system can know, it advances itself: writing to someone makes
 * them `contacted`, an enquiry makes them `replied`. The last two are
 * judgements and stay manual. A pipeline nobody updates is worse than no
 * pipeline, so the machine keeps the part it can.
 */

export type Stage = (typeof STAGES)[number]

/** Every segment in use, with how many are in it. */
export async function listSegments() {
  return db.execute<{ name: string; n: number; sendable: number }>(raw`
    select
      s.name,
      count(*)::int as n,
      count(*) filter (
        where c.email_status in ('verified','catch_all') and c.erased_at is null
      )::int as sendable
    from contacts c, lateral unnest(c.segments) as s(name)
    where c.erased_at is null
    group by s.name
    order by 2 desc
  `)
}

export async function stageCounts() {
  const rows = await db.execute<{ stage: Stage; n: number }>(raw`
    select stage::text as stage, count(*)::int as n
    from contacts where erased_at is null group by 1
  `)
  const by = new Map(rows.map((r) => [r.stage, Number(r.n)]))
  return STAGES.map((s) => ({ stage: s, n: by.get(s) ?? 0 }))
}

/** Add or remove a segment across a selection, in one statement. */
export async function tag(ids: string[], name: string, on: boolean) {
  if (ids.length === 0 || !name.trim()) return
  const value = name.trim()
  await db
    .update(contacts)
    .set({
      segments: on
        ? raw`(select array(select distinct unnest(${contacts.segments} || array[${value}])))`
        : raw`array_remove(${contacts.segments}, ${value})`,
      updatedAt: new Date(),
    })
    .where(inArray(contacts.id, ids))
}

export async function moveStage(ids: string[], to: Stage) {
  if (ids.length === 0) return
  await db
    .update(contacts)
    .set({ stage: to, stageAt: new Date(), updatedAt: new Date() })
    .where(inArray(contacts.id, ids))
}

/**
 * Move someone forward, never backwards.
 *
 * Called by the machine when it learns something — a send, an enquiry. Going
 * backwards would mean a later campaign could demote a customer to `contacted`,
 * which is how a pipeline stops being trusted.
 */
export async function advance(contactId: string, to: Stage) {
  const rank = STAGES.indexOf(to)
  await db
    .update(contacts)
    .set({ stage: to, stageAt: new Date() })
    .where(
      and(
        eq(contacts.id, contactId),
        // Only if they are behind where this would put them.
        raw`array_position(${raw.raw(`ARRAY[${STAGES.map((s) => `'${s}'`).join(',')}]`)}, ${contacts.stage}::text) < ${rank + 1}`,
      ),
    )
}

/**
 * The audience filter a campaign targets, as SQL.
 *
 * Empty means everyone sendable — which is what a campaign written before
 * segments existed still means, so nothing had to be migrated.
 */
export function audienceWhere(segments: string[], stages: string[]) {
  // Each element becomes its own bound parameter. Passing the JS array straight
  // into the template hands Postgres one string where it wants an array
  // literal — which typechecks perfectly and fails at run time.
  const list = (values: string[]) => raw.join(values.map((v) => raw`${v}`), raw`, `)

  return and(
    inArray(contacts.emailStatus, SENDABLE),
    isNull(contacts.erasedAt),
    segments.length > 0 ? raw`${contacts.segments} && ARRAY[${list(segments)}]::text[]` : undefined,
    stages.length > 0 ? raw`${contacts.stage}::text = ANY(ARRAY[${list(stages)}]::text[])` : undefined,
  )
}

/** How many a letter would reach, before anything is written. */
export async function audienceOf(segments: string[], stages: string[]) {
  const [row] = await db
    .select({ n: raw<number>`count(*)`.mapWith(Number) })
    .from(contacts)
    .where(audienceWhere(segments, stages))
  return row.n
}

export type ContactRow = Pick<Contact, 'id' | 'segments' | 'stage'>
