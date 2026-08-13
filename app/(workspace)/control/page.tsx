import Link from 'next/link'
import { db } from '@/db'
import { mailboxes } from '@/db/schema'
import { listCampaigns } from '@/lib/campaigns'
import { contactStats } from '@/lib/contacts'
import { isConfigured } from '@/lib/gmail'
import { shouldHalt } from '@/lib/rules'
import { mailboxStats } from '@/lib/send'
import { pauseSending, startSending } from '../actions'
import { accent, ghost, Pill, Screen } from '../ui'
import { RunTick, Valve, type Box } from './console'

/**
 * Every other screen answers "what is in the list". This one answers the four
 * questions you actually have each morning: is the machine running, is it
 * healthy, does anything need my judgement, and how much goes out today.
 *
 * Nothing here is a new source of truth — the pipeline is the message states,
 * the allowance is lib/rules.ts, the mailbox numbers are the sender's own. It
 * is the same machine, pointed at you instead of at the queue.
 */
export default async function ControlPage() {
  const [rows, contacts, boxRows] = await Promise.all([
    listCampaigns(),
    contactStats(),
    db.select().from(mailboxes).orderBy(mailboxes.email),
  ])

  const boxes: Box[] = await Promise.all(
    boxRows.map(async (box) => {
      const stats = await mailboxStats(box.id)
      const attempts = stats.sentEver + stats.bouncedEver
      return {
        id: box.id,
        email: box.email,
        cap: box.dailyCap,
        sentToday: stats.sentToday,
        sendsCatchAll: box.sendsCatchAll,
        active: box.active,
        halted: shouldHalt(stats.sentEver, stats.bouncedEver),
        bounceRate: attempts > 0 ? stats.bouncedEver / attempts : 0,
      }
    }),
  )

  const sum = (pick: (r: (typeof rows)[number]) => number) => rows.reduce((t, r) => t + pick(r), 0)
  const drafts = sum((r) => r.drafts)
  const flagged = sum((r) => r.flagged)
  const approved = sum((r) => r.approved)
  const sent = sum((r) => r.sent)
  const written = drafts + flagged + approved + sent

  const sending = rows.filter((r) => r.campaign.status === 'sending')
  const halted = boxes.filter((box) => box.halted)
  const armed = approved > 0 && sending.length > 0

  return (
    <Screen
      title="Control"
      note={
        isConfigured()
          ? 'Gmail credentials are set — sends are real.'
          : 'No Gmail credentials, so sends are recorded as a dry run.'
      }
    >
      <div className="min-h-0 flex-1 space-y-8 overflow-auto px-6 py-6">
        {/* ── What needs a person ────────────────────────────────────────────
            First, because it is the only part of the system that cannot move
            without you. Absent when there is nothing to say. */}
        {(flagged > 0 || halted.length > 0) && (
          <section className="space-y-2">
            {halted.map((box) => (
              <p
                key={box.id}
                className="rounded-xl border border-[#FF6B6B]/30 bg-[#FF6B6B]/[0.07] px-4 py-3 text-[#FF8F8F]"
              >
                <strong className="font-medium">{box.email} has halted itself</strong> —{' '}
                {(box.bounceRate * 100).toFixed(1)}% of its sends bounced, above the 3% threshold.
                Its campaigns were paused automatically. Nothing will send from it until the list
                behind it is fixed.
              </p>
            ))}
            {flagged > 0 && (
              <Link
                href="/"
                className="flex items-center gap-3 rounded-xl border border-[#FFB62B]/30 bg-[#FFB62B]/[0.07] px-4 py-3 text-[#FFC65C] transition-colors hover:bg-[#FFB62B]/[0.12]"
              >
                <strong className="font-medium">
                  {flagged} {flagged === 1 ? 'message needs' : 'messages need'} your judgement
                </strong>
                <span className="opacity-80">
                  A validator flagged them. They can never be approved in bulk.
                </span>
                <span className="ml-auto">→</span>
              </Link>
            )}
          </section>
        )}

        {/* ── The pipe ─────────────────────────────────────────────────────── */}
        <section>
          <h2 className="mb-1 font-medium">The pipe</h2>
          <p className="mb-3.5 text-muted">
            {contacts.sendable.toLocaleString()} of {contacts.total.toLocaleString()} contacts can
            be sent to at all. {written.toLocaleString()} have been written to so far.
          </p>

          {written === 0 ? (
            <p className="rounded-xl border border-line px-4 py-3 text-muted">
              Nothing written yet. A campaign is where that starts.
            </p>
          ) : (
            <>
              <div className="flex h-2.5 overflow-hidden rounded-full bg-raised">
                {(
                  [
                    ['drafts', drafts, 'bg-ink/35'],
                    ['flagged', flagged, 'bg-[#FFB62B]'],
                    ['approved', approved, 'bg-accent/45'],
                    ['sent', sent, 'bg-accent'],
                  ] as const
                ).map(([label, value, tone]) =>
                  value > 0 ? (
                    <div key={label} className={tone} style={{ flexGrow: value }} title={`${value} ${label}`} />
                  ) : null,
                )}
              </div>
              <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
                {(
                  [
                    ['To review', drafts + flagged],
                    ['Flagged', flagged],
                    ['Approved', approved],
                    ['Sent', sent],
                  ] as const
                ).map(([label, value]) => (
                  <div key={label}>
                    <dd className="text-[22px] font-semibold leading-tight tracking-[-0.02em]">
                      {value.toLocaleString()}
                    </dd>
                    <dt className="text-muted">{label}</dt>
                  </div>
                ))}
              </dl>
            </>
          )}
        </section>

        {/* ── The valve ────────────────────────────────────────────────────── */}
        <section>
          <h2 className="mb-1 font-medium">The valve</h2>
          <p className="mb-3.5 text-muted">
            The daily cap is released evenly across the window rather than all at once, so a
            sender that was down all morning cannot catch up in one burst at five.
          </p>
          {boxes.length === 0 ? (
            <p className="rounded-xl border border-line px-4 py-3 text-muted">
              No mailboxes — <code className="font-mono">npm run db:seed</code> adds the first two.
            </p>
          ) : (
            <Valve boxes={boxes} />
          )}
        </section>

        {/* ── Levers ───────────────────────────────────────────────────────── */}
        <section>
          <h2 className="mb-1 font-medium">Levers</h2>
          <p className="mb-3.5 text-muted">
            {sending.length > 0
              ? `${sending.length} ${sending.length === 1 ? 'campaign is' : 'campaigns are'} sending.`
              : 'No campaign is sending. Approved messages sit still until one is started.'}
          </p>

          <div className="space-y-3">
            <RunTick armed={armed} />

            {rows.length > 0 && (
              <div className="overflow-hidden rounded-xl border border-line">
                {rows.map(({ campaign, approved: ready }) => (
                  <div
                    key={campaign.id}
                    className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-2.5 last:border-b-0"
                  >
                    <Link
                      href={`/c/${campaign.id}`}
                      className="min-w-0 flex-1 truncate font-medium hover:underline"
                    >
                      {campaign.name}
                    </Link>
                    <Pill>{campaign.status}</Pill>
                    <span className="text-muted">
                      {ready > 0 ? `${ready} ready` : 'nothing ready'}
                    </span>
                    {campaign.status === 'sending' ? (
                      <form action={pauseSending}>
                        <input type="hidden" name="id" value={campaign.id} />
                        <button className={ghost}>Pause</button>
                      </form>
                    ) : (
                      <form action={startSending}>
                        <input type="hidden" name="id" value={campaign.id} />
                        <button className={accent} disabled={ready === 0}>
                          Start
                        </button>
                      </form>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      </div>
    </Screen>
  )
}
