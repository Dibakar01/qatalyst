import Link from 'next/link'
import { notFound } from 'next/navigation'
import { db } from '@/db'
import { mailboxes } from '@/db/schema'
import { audienceSize, counts, getCampaign, reviewQueue, sentMessages } from '@/lib/campaigns'
import { SLOT } from '@/lib/template'
import {
  approve,
  approveAllClean,
  generateAction,
  pauseSending,
  reject,
  saveCampaignAction,
  startSending,
} from '../../actions'
import { button, field, ghost, Pill, Step } from '../../ui'

const WHY: Record<string, string> = {
  ungrounded: 'mentions something we have no record of for this contact',
  thin: 'says nothing beyond their name, title and company',
}

export default async function CampaignPage({ params }: PageProps<'/c/[id]'>) {
  const { id } = await params
  const campaign = await getCampaign(id)
  if (!campaign) notFound()

  const [tally, audience, queue, sent, boxes] = await Promise.all([
    counts(id),
    audienceSize(id),
    reviewQueue(id),
    sentMessages(id, 10),
    db.select().from(mailboxes),
  ])

  const active = boxes.filter((box) => box.active)
  const capacity = active.reduce((total, box) => total + box.dailyCap, 0)
  const hasSlot = campaign.bodyTemplate.includes(`{{${SLOT}}}`)

  return (
    <>
      <header className="flex items-center justify-between gap-3 border-b border-line px-5 py-3.5">
        <div className="flex items-baseline gap-3">
          <Link href="/" className="text-muted hover:text-ink">
            ←
          </Link>
          <h1 className="text-[15px] font-semibold tracking-tight">{campaign.name}</h1>
          <Pill>{campaign.status}</Pill>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-auto">
        <Step n={1} title="Message">
          <form action={saveCampaignAction} className="max-w-2xl space-y-3">
            <input type="hidden" name="id" value={campaign.id} />
            <label className="block">
              <span className="text-muted">Name</span>
              <input name="name" defaultValue={campaign.name} className={`${field} mt-1`} />
            </label>
            <label className="block">
              <span className="text-muted">Subject</span>
              <input
                name="subject_template"
                defaultValue={campaign.subjectTemplate}
                className={`${field} mt-1`}
              />
            </label>
            <label className="block">
              <span className="text-muted">
                Body — {`{{${SLOT}}}`} is the one line the model writes
              </span>
              <textarea
                name="body_template"
                rows={9}
                defaultValue={campaign.bodyTemplate}
                className={`${field} mt-1 font-mono text-[12.5px]`}
              />
            </label>
            {!hasSlot && (
              <p className="text-amber-700">
                The body has no {`{{${SLOT}}}`}, so there is nothing for the model to write.
              </p>
            )}
            <label className="block">
              <span className="text-muted">
                What should that line say? The model sees only this and the contact&rsquo;s own
                fields.
              </span>
              <textarea
                name="prompt"
                rows={3}
                defaultValue={campaign.prompt}
                className={`${field} mt-1`}
              />
            </label>
            <p className="text-muted">
              Other variables: {`{{first_name}} {{last_name}} {{company}} {{title}}`} and{' '}
              {`{{context.Any CSV column}}`}. The opt-out sentence and unsubscribe link are added
              automatically — you cannot remove them.
            </p>
            <button className={button}>Save</button>
          </form>
        </Step>

        <Step
          n={2}
          title="Audience"
          note={`${audience} sendable ${audience === 1 ? 'contact' : 'contacts'} not yet written to`}
        >
          {audience === 0 ? (
            <p className="text-muted">
              Nobody is eligible. Contacts need an email status of verified or catch-all — set it
              on the <Link href="/contacts" className="underline underline-offset-2">contacts</Link>{' '}
              page or map it on import.
            </p>
          ) : (
            <form action={generateAction} className="flex items-center gap-3">
              <input type="hidden" name="id" value={campaign.id} />
              <button className={button} disabled={!hasSlot}>
                Write the next {Math.min(audience, 25)} drafts
              </button>
              <span className="text-muted">
                One short generation each, then both validators run. Takes about half a minute.
              </span>
            </form>
          )}
        </Step>

        <Step
          n={3}
          title="Review"
          note={
            tally.drafts + tally.flagged === 0
              ? 'nothing waiting'
              : `${tally.drafts + tally.flagged} waiting · ${tally.flagged} flagged`
          }
        >
          {queue.length === 0 ? (
            <p className="text-muted">
              {tally.approved > 0
                ? `${tally.approved} approved and ready to send.`
                : 'Write some drafts first.'}
            </p>
          ) : (
            <div className="space-y-3">
              {tally.drafts > 0 && (
                <form action={approveAllClean}>
                  <input type="hidden" name="id" value={campaign.id} />
                  <button className={ghost}>
                    Approve the {tally.drafts} that passed both validators
                  </button>
                  <span className="ml-3 text-muted">
                    Flagged ones are never approved in bulk — open each and decide.
                  </span>
                </form>
              )}

              {queue.map(({ message, contact }) => (
                <article key={message.id} className="rounded-xl border border-line">
                  <div className="flex flex-wrap items-center gap-2 border-b border-line px-3.5 py-2">
                    <span className="font-medium">
                      {[contact.firstName, contact.lastName].filter(Boolean).join(' ') || 'Unnamed'}
                    </span>
                    <span className="text-muted">{contact.email}</span>
                    <span className="text-muted">·</span>
                    <span className="text-muted">{contact.company}</span>
                    <span className="ml-auto flex gap-1.5">
                      {message.validatorFlags.map((flag) => (
                        <Pill key={flag} tone="flagged">
                          {flag}
                        </Pill>
                      ))}
                    </span>
                  </div>
                  {message.validatorFlags.length > 0 && (
                    <ul className="border-b border-line bg-amber-50/40 px-3.5 py-2 text-amber-800">
                      {message.validatorFlags.map((flag) => (
                        <li key={flag}>
                          <strong className="font-medium">{flag}</strong> — {WHY[flag] ?? flag}
                        </li>
                      ))}
                    </ul>
                  )}
                  {message.error ? (
                    <p className="px-3.5 py-2 text-rose-700">{message.error}</p>
                  ) : (
                    <>
                      <p className="border-b border-line px-3.5 py-2">
                        <span className="text-muted">Subject: </span>
                        {message.subject}
                      </p>
                      <pre className="whitespace-pre-wrap px-3.5 py-3 font-sans">{message.body}</pre>
                    </>
                  )}
                  <div className="flex gap-2 border-t border-line px-3.5 py-2">
                    <form action={approve}>
                      <input type="hidden" name="id" value={message.id} />
                      <button className={button} disabled={Boolean(message.error)}>
                        Approve
                      </button>
                    </form>
                    <form action={reject}>
                      <input type="hidden" name="id" value={message.id} />
                      <button className={ghost}>Discard</button>
                    </form>
                  </div>
                </article>
              ))}
            </div>
          )}
        </Step>

        <Step
          n={4}
          title="Send"
          note={`${tally.approved} approved · ${tally.sent} sent`}
        >
          <div className="space-y-3">
            <p className="text-muted">
              {active.length} active {active.length === 1 ? 'mailbox' : 'mailboxes'}, up to{' '}
              {capacity} a day between them, spread across 09:00–17:00. Catch-all addresses go only
              from a mailbox flagged for them, capped at 10 a day. If a mailbox bounces above 3%
              this campaign stops on its own.
            </p>
            {campaign.status === 'sending' ? (
              <form action={pauseSending} className="flex items-center gap-3">
                <input type="hidden" name="id" value={campaign.id} />
                <button className={ghost}>Pause sending</button>
                <span className="text-muted">
                  Run <code className="font-mono">npm run send</code> to work the queue.
                </span>
              </form>
            ) : (
              <form action={startSending} className="flex items-center gap-3">
                <input type="hidden" name="id" value={campaign.id} />
                <button className={button} disabled={tally.approved === 0}>
                  Start sending
                </button>
                {tally.approved === 0 && <span className="text-muted">Nothing approved yet.</span>}
              </form>
            )}

            {sent.length > 0 && (
              <ul className="mt-2 space-y-1 text-muted">
                {sent.map(({ message, contact }) => (
                  <li key={message.id} className="font-mono text-[12px]">
                    {message.sentAt?.toISOString().slice(0, 16).replace('T', ' ')} → {contact.email}{' '}
                    {message.messageIdHeader}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Step>
      </div>
    </>
  )
}
