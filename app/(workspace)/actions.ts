'use server'

import { revalidatePath } from 'next/cache'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { consentStatus, emailStatus } from '@/db/schema'
import { COOKIE, requireAuth } from '@/lib/auth'
import {
  eraseContact,
  runImport,
  setContactStatus,
  suppressContacts,
  type ConsentStatus,
  type EmailStatus,
} from '@/lib/contacts'
import type { Mapping, Row } from '@/lib/csv'
import { suppress, suppressDomain } from '@/lib/suppression'

// Server actions are reachable by direct POST, so every one of them re-checks
// auth and re-validates its input rather than trusting the form it came from.
const refresh = () => revalidatePath('/', 'layout')

export async function importRows(mapping: Mapping, rows: Row[], source: string) {
  await requireAuth()
  const counts = await runImport(mapping, rows, source)
  refresh()
  return counts
}

export async function suppressSelected(formData: FormData) {
  await requireAuth()
  const ids = formData.getAll('ids').map(String).filter(Boolean)
  await suppressContacts(ids)
  refresh()
}

export async function suppressEmail(formData: FormData) {
  await requireAuth()
  const email = String(formData.get('email') ?? '').trim()
  if (email) await suppress(email, 'manual')
  refresh()
}

export async function blockDomain(formData: FormData) {
  await requireAuth()
  const domain = String(formData.get('domain') ?? '')
    .trim()
    .toLowerCase()
    .replace(/^@/, '')
  const reason = String(formData.get('reason') ?? 'manual')
  if (!domain.includes('.')) return
  await suppressDomain(domain, reason === 'competitor' || reason === 'customer' ? reason : 'manual')
  refresh()
}

export async function erase(formData: FormData) {
  await requireAuth()
  await eraseContact(String(formData.get('id') ?? ''))
  refresh()
  redirect('/')
}

export async function saveStatus(formData: FormData) {
  await requireAuth()
  const id = String(formData.get('id') ?? '')
  const email = String(formData.get('email_status') ?? '')
  const consent = String(formData.get('consent_status') ?? '')
  if (!emailStatus.enumValues.includes(email as never)) return
  if (!consentStatus.enumValues.includes(consent as never)) return
  await setContactStatus(id, email as EmailStatus, consent as ConsentStatus)
  refresh()
}

export async function signOut() {
  ;(await cookies()).delete(COOKIE)
  redirect('/login')
}
