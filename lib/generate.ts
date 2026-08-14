import Anthropic from '@anthropic-ai/sdk'
import { and, eq, isNotNull, isNull, inArray, notInArray } from 'drizzle-orm'
import { db } from '../db/index.ts'
import { campaigns, contacts, messages, type Campaign, type Contact } from '../db/schema.ts'
import { SENDABLE } from './contacts.ts'
import { suppressionIndex } from './suppression.ts'
import { unsubscribeUrl } from './token.ts'
import { assembleBody, fill, SLOT, variables } from './template.ts'
import { validate } from './validators.ts'

const MODEL = 'claude-opus-5'
const CONCURRENCY = 5

// The instructions mirror the two validators, so the model is asked for what
// the validators will check rather than being caught out by them afterwards.
const SYSTEM = `You write one short paragraph for a person-to-person B2B email.

- Use only the facts you are given about the recipient. Never invent a detail, number, date, event, company fact or person. If you have nothing specific to work with, write a plain honest sentence about why you are writing instead of inventing a hook.
- Do not restate their name, job title or company back at them — they already know those. Say something that could only have been written to this person.
- Two or three sentences. Plain text: no greeting, no sign-off, no subject line, no markdown, no bullet points.

Respond with the paragraph only, no preamble.`

function facts(contact: Contact) {
  const lines = Object.entries({
    Name: [contact.firstName, contact.lastName].filter(Boolean).join(' '),
    Title: contact.title,
    Company: contact.company,
    ...contact.context,
  })
    .filter(([, value]) => value)
    .map(([key, value]) => `${key}: ${value}`)
  return lines.join('\n')
}

/** One short generation. Returns the paragraph, or a reason it could not be written. */
async function personalise(campaign: Campaign, contact: Contact) {
  const client = new Anthropic()

  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 2000,
    // A two-sentence paragraph does not need deep reasoning, and low effort is
    // the main cost lever on this model.
    output_config: { effort: 'low' },
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: SYSTEM,
    messages: [
      {
        role: 'user',
        content: `What this campaign is about:\n${campaign.prompt}\n\nWhat we know about the recipient:\n${facts(contact)}`,
      },
    ],
  })

  if (response.stop_reason === 'refusal') return { error: 'the model declined to write this one' }

  const text = response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim()

  return text ? { text } : { error: 'the model returned nothing' }
}

export type GenerateResult = { drafted: number; flagged: number; failed: number; skipped: number }

/**
 * Writes one message per eligible contact. Suppression is checked here as well
 * as at send time — no point spending tokens on someone we can never email.
 */
export async function generateForCampaign(campaignId: string, limit = 100): Promise<GenerateResult> {
  const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, campaignId))
  if (!campaign) throw new Error('no such campaign')
  if (!campaign.bodyTemplate.includes(`{{${SLOT}}}`)) {
    throw new Error(`the body template must contain {{${SLOT}}}`)
  }

  const already = db
    .select({ id: messages.contactId })
    .from(messages)
    .where(eq(messages.campaignId, campaignId))

  const audience = await db
    .select()
    .from(contacts)
    .where(
      and(
        inArray(contacts.emailStatus, SENDABLE),
        isNull(contacts.erasedAt),
        isNotNull(contacts.email),
        notInArray(contacts.id, already),
      ),
    )
    .limit(limit)

  const suppressed = await suppressionIndex()
  const result: GenerateResult = { drafted: 0, flagged: 0, failed: 0, skipped: 0 }

  const eligible = audience.filter((contact) => {
    if (contact.email && suppressed(contact.email)) {
      result.skipped++
      return false
    }
    return true
  })

  for (let i = 0; i < eligible.length; i += CONCURRENCY) {
    const batch = eligible.slice(i, i + CONCURRENCY)
    const written = await Promise.all(
      batch.map(async (contact) => {
        const values = variables(contact)
        try {
          const outcome = await personalise(campaign, contact)
          if ('error' in outcome) {
            return {
              campaignId,
              contactId: contact.id,
              subject: fill(campaign.subjectTemplate, values),
              body: '',
              status: 'flagged' as const,
              validatorFlags: [],
              error: outcome.error,
            }
          }

          const flags = validate(outcome.text, contact)
          const rendered = fill(campaign.bodyTemplate, { ...values, [SLOT]: outcome.text })
          return {
            campaignId,
            contactId: contact.id,
            subject: fill(campaign.subjectTemplate, values),
            body: assembleBody(rendered, unsubscribeUrl(contact.email!)),
            status: (flags.length ? 'flagged' : 'draft') as 'flagged' | 'draft',
            validatorFlags: flags,
          }
        } catch (cause) {
          return {
            campaignId,
            contactId: contact.id,
            subject: fill(campaign.subjectTemplate, values),
            body: '',
            status: 'flagged' as const,
            validatorFlags: [],
            error: cause instanceof Error ? cause.message : String(cause),
          }
        }
      }),
    )

    await db.insert(messages).values(written).onConflictDoNothing()
    for (const row of written) {
      if (row.error) result.failed++
      else if (row.status === 'flagged') result.flagged++
      else result.drafted++
    }
  }

  await db
    .update(campaigns)
    .set({ status: 'ready' })
    .where(and(eq(campaigns.id, campaignId), eq(campaigns.status, 'draft')))

  return result
}
