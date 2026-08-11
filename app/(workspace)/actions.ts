'use server'

import { revalidatePath } from 'next/cache'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { consentStatus, emailStatus } from '@/db/schema'
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
import { sendTick } from '@/lib/send'
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
  redirect('/contacts')
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
  redirect(`/c/${campaign.id}`)
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
  await generateForCampaign(field(formData, 'id'), 25)
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

export async function signOut() {
  ;(await cookies()).delete(COOKIE)
  redirect('/login')
}
