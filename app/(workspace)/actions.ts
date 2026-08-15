'use server'

import { revalidatePath } from 'next/cache'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { connectorKind, consentStatus, emailStatus, STAGES } from '@/db/schema'
import { COOKIE, requireAuth } from '@/lib/auth'
import {
  approveMessage,
  approveUnflagged,
  createCampaign,
  rejectMessage,
  saveCampaign,
  setCampaignStatus,
} from '@/lib/campaigns'
import {
  eraseContact,
  runImport,
  setContactStatus,
  suppressContacts,
  type ConsentStatus,
  type EmailStatus,
} from '@/lib/contacts'
import type { Mapping, Row } from '@/lib/csv'
import { generateForCampaign } from '@/lib/generate'
import { KINDS, shape, type Kind } from '@/lib/compose'
import { batchSize } from '@/lib/rules'
import { sendTick } from '@/lib/send'
import { setDomainActive, setWarming } from '@/lib/domains'
import { moveStage, tag, type Stage } from '@/lib/segments'
import { fromClock, saveTuning, tuning } from '@/lib/settings'
import {
  addSource as createSource,
  enrichUnverified,
  removeSource as dropSource,
  runSource,
} from '@/lib/sources'
import { suppress, suppressDomain } from '@/lib/suppression'

// Server actions are reachable by direct POST, so every one of them re-checks
// auth and re-validates its input rather than trusting the form it came from.
const refresh = () => revalidatePath('/', 'layout')

const field = (formData: FormData, name: string) => String(formData.get(name) ?? '').trim()

/* contacts ---------------------------------------------------------------- */

export async function importRows(mapping: Mapping, rows: Row[], source: string) {
  await requireAuth()
  const result = await runImport(mapping, rows, source)
  refresh()
  return result
}

export async function suppressSelected(formData: FormData) {
  await requireAuth()
  await suppressContacts(formData.getAll('ids').map(String).filter(Boolean))
  refresh()
}

export async function suppressEmail(formData: FormData) {
  await requireAuth()
  const email = field(formData, 'email')
  if (email) await suppress(email, 'manual')
  refresh()
}

export async function blockDomain(formData: FormData) {
  await requireAuth()
  const domain = field(formData, 'domain').toLowerCase().replace(/^@/, '')
  const reason = field(formData, 'reason')
  if (!domain.includes('.')) return
  await suppressDomain(domain, reason === 'competitor' || reason === 'customer' ? reason : 'manual')
  refresh()
}

export async function erase(formData: FormData) {
  await requireAuth()
  await eraseContact(field(formData, 'id'))
  refresh()
  redirect('/?view=book')
}

/* segments and stages ----------------------------------------------------- */

export async function tagSelected(formData: FormData) {
  await requireAuth()
  const ids = formData.getAll('ids').map(String).filter(Boolean)
  const name = field(formData, 'segment')
  if (name) await tag(ids, name, field(formData, 'off') !== '1')
  refresh()
}

export async function stageSelected(formData: FormData) {
  await requireAuth()
  const to = field(formData, 'stage')
  if (!STAGES.includes(to as never)) return
  await moveStage(formData.getAll('ids').map(String).filter(Boolean), to as Stage)
  refresh()
}

export async function saveStatus(formData: FormData) {
  await requireAuth()
  const email = field(formData, 'email_status')
  const consent = field(formData, 'consent_status')
  if (!emailStatus.enumValues.includes(email as never)) return
  if (!consentStatus.enumValues.includes(consent as never)) return
  await setContactStatus(field(formData, 'id'), email as EmailStatus, consent as ConsentStatus)
  refresh()
}

/* campaigns --------------------------------------------------------------- */

export async function newCampaign(formData: FormData) {
  await requireAuth()
  const name = field(formData, 'name') || 'Untitled campaign'
  const campaign = await createCampaign(name)
  refresh()
  redirect(`/?c=${campaign.id}`)
}

/**
 * Create a letter from the three answers rather than a blank template.
 *
 * The composer asks what kind of message, what we genuinely know about these
 * people, and the one thing being asked for. That is enough to assemble a
 * subject, a body and the model's instruction — so nobody has to learn a
 * mail-merge syntax to send their first letter.
 */
export async function composeCampaign(formData: FormData) {
  await requireAuth()

  const kind = field(formData, 'kind')
  const chosen: Kind = KINDS.includes(kind as Kind) ? (kind as Kind) : 'intro'
  const built = shape(chosen, field(formData, 'ask'), field(formData, 'signoff'))

  // The fields they ticked are what the model is allowed to lean on. Naming
  // them in the prompt is what keeps the generated line grounded in this list
  // rather than in whatever the model imagines about the company.
  const lean = formData.getAll('lean').map(String).filter(Boolean)
  const prompt = lean.length
    ? `${built.prompt}\n\nYou may use only these facts about them: ${lean.join(', ')}. If a fact is missing for this person, write a plainer sentence rather than inventing one.`
    : built.prompt

  const campaign = await createCampaign(field(formData, 'name') || 'Untitled letter')
  await saveCampaign(campaign.id, {
    name: field(formData, 'name') || 'Untitled letter',
    subjectTemplate: built.subject,
    bodyTemplate: built.body,
    prompt,
    // Who it is for. Empty means everyone sendable.
    audienceSegments: formData.getAll('seg').map(String).filter(Boolean),
    audienceStages: formData.getAll('stg').map(String).filter(Boolean),
  })

  refresh()
  redirect(`/?c=${campaign.id}&step=1`)
}

export async function saveCampaignAction(formData: FormData) {
  await requireAuth()
  await saveCampaign(field(formData, 'id'), {
    name: field(formData, 'name'),
    subjectTemplate: field(formData, 'subject_template'),
    bodyTemplate: String(formData.get('body_template') ?? ''),
    prompt: String(formData.get('prompt') ?? ''),
  })
  refresh()
}

/** One click writes a bounded batch — a form post should not hang for minutes. */
export async function generateAction(formData: FormData) {
  await requireAuth()
  // `write 40` may ask for a bigger batch than the default, but not an
  // unbounded one — every draft is a model call.
  const { draftBatch } = await tuning()
  await generateForCampaign(field(formData, 'id'), batchSize(field(formData, 'n'), draftBatch))
  refresh()
}

export async function approve(formData: FormData) {
  await requireAuth()
  await approveMessage(field(formData, 'id'))
  refresh()
}

export async function reject(formData: FormData) {
  await requireAuth()
  await rejectMessage(field(formData, 'id'))
  refresh()
}

export async function approveAllClean(formData: FormData) {
  await requireAuth()
  await approveUnflagged(field(formData, 'id'))
  refresh()
}

export async function startSending(formData: FormData) {
  await requireAuth()
  await setCampaignStatus(field(formData, 'id'), 'sending')
  refresh()
}

export async function pauseSending(formData: FormData) {
  await requireAuth()
  await setCampaignStatus(field(formData, 'id'), 'ready')
  refresh()
}

/** Runs a single tick by hand. The worker (npm run send) does this on a timer. */
export async function sendNow() {
  await requireAuth()
  const tick = await sendTick()
  refresh()
  return tick
}

/* sources ----------------------------------------------------------------- */

export async function addSource(formData: FormData) {
  await requireAuth()
  const kind = field(formData, 'kind')
  if (!connectorKind.enumValues.includes(kind as never)) return

  const campaignId = field(formData, 'campaign')
  await createSource({
    campaignId: campaignId || null,
    kind: kind as (typeof connectorKind.enumValues)[number],
    name: field(formData, 'name'),
    config: {
      // Apollo's search, and the exporter a push source expects. Unused keys
      // for the other kind are simply absent.
      titles: field(formData, 'titles'),
      locations: field(formData, 'locations'),
      domains: field(formData, 'domains'),
      preset: field(formData, 'preset') || 'evaboot',
    },
  })
  refresh()
}

/**
 * Pull a source now.
 *
 * The error is swallowed on purpose: `runSource` has already written the reason
 * onto the connector row, and the panel shows it there. Rethrowing would
 * replace the page with an error screen and lose the very sentence explaining
 * what went wrong.
 */
export async function runSourceAction(formData: FormData) {
  await requireAuth()
  try {
    await runSource(field(formData, 'id'))
  } catch {
    // Recorded on the row by runSource().
  }
  refresh()
}

export async function removeSource(formData: FormData) {
  await requireAuth()
  await dropSource(field(formData, 'id'))
  refresh()
}

/** Enrichment reports back through the URL, so a missing key says why. */
export async function enrichContacts() {
  await requireAuth()
  let said: string
  try {
    said = await enrichUnverified()
  } catch (cause) {
    said = cause instanceof Error ? cause.message : String(cause)
  }
  refresh()
  redirect(`/?view=book&said=${encodeURIComponent(said)}`)
}

/* settings ---------------------------------------------------------------- */

export async function saveSettings(formData: FormData) {
  await requireAuth()
  const current = await tuning()
  await saveTuning({
    // The two clocks arrive as HH:MM from a native time input.
    windowStart: fromClock(field(formData, 'window_start'), current.windowStart),
    windowEnd: fromClock(field(formData, 'window_end'), current.windowEnd),
    // Shown as a percentage, stored as basis points.
    bounceThreshold: Math.round(Number(field(formData, 'bounce_threshold')) * 100),
    bounceMinimum: field(formData, 'bounce_minimum'),
    catchAllCap: field(formData, 'catch_all_cap'),
    draftBatch: field(formData, 'draft_batch'),
  })
  refresh()
  redirect('/?view=settings&saved=1')
}

/**
 * Apply one piece of advice.
 *
 * Only the six tunable settings, and `saveTuning` clamps every one of them —
 * so the worst a bad form post can do is set a legal value. Tuning the rules
 * is the point; being able to turn them off is not.
 */
export async function applyAdvice(formData: FormData) {
  await requireAuth()
  const setting = field(formData, 'setting')
  const to = Number(field(formData, 'to'))

  const ALLOWED = [
    'draftBatch',
    'bounceThreshold',
    'catchAllCap',
    'bounceMinimum',
    'windowStart',
    'windowEnd',
  ]
  if (!ALLOWED.includes(setting) || !Number.isFinite(to)) {
    redirect('/?view=reports&said=' + encodeURIComponent('That is not a setting I can change.'))
  }

  await saveTuning({ [setting]: to })
  refresh()
  redirect('/?view=reports&applied=' + encodeURIComponent(setting))
}

/* domains ----------------------------------------------------------------- */

/**
 * Mark a domain as warming from today, or as already established.
 *
 * The whole reason to spread across domains is that each is warmed separately.
 * Established means "already warmed" — its mailbox caps stand as configured.
 */
export async function warmDomain(formData: FormData) {
  await requireAuth()
  const warming = field(formData, 'warming') === '1'
  await setWarming(field(formData, 'id'), warming ? new Date() : null)
  refresh()
}

/** Pause every mailbox on a domain at once — the point of grouping them. */
export async function toggleDomain(formData: FormData) {
  await requireAuth()
  await setDomainActive(field(formData, 'id'), field(formData, 'active') === '1')
  refresh()
}

export async function signOut() {
  ;(await cookies()).delete(COOKIE)
  redirect('/login')
}
