import Link from 'next/link'
import { listCampaigns } from '@/lib/campaigns'
import { newCampaign } from './actions'
import { button, field, Pill } from './ui'

export default async function CampaignsPage() {
  const rows = await listCampaigns()

  return (
    <>
      <header className="flex items-center justify-between gap-3 border-b border-line px-5 py-3.5">
        <div>
          <h1 className="text-[15px] font-semibold tracking-tight">Campaigns</h1>
          <p className="text-muted">Write, review, then send from our own mailboxes.</p>
        </div>
        <form action={newCampaign} className="flex gap-2">
          <input name="name" placeholder="New campaign name" className={`${field} w-56`} />
          <button className={button}>Create</button>
        </form>
      </header>

      {rows.length === 0 ? (
        <div className="grid flex-1 place-items-center px-6 py-16 text-center">
          <div>
            <p className="font-medium">No campaigns yet</p>
            <p className="mt-1 text-muted">
              A campaign is one message written once and personalised per contact.
            </p>
          </div>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          {rows.map(({ campaign, drafts, flagged, approved, sent }) => (
            <Link
              key={campaign.id}
              href={`/c/${campaign.id}`}
              className="flex items-center gap-4 border-b border-line px-5 py-3 hover:bg-faint"
            >
              <span className="w-64 shrink-0 truncate font-medium">{campaign.name}</span>
              <Pill>{campaign.status}</Pill>
              <span className="text-muted">
                {drafts + flagged > 0 && `${drafts + flagged} to review`}
                {flagged > 0 && ` · ${flagged} flagged`}
                {approved > 0 && ` · ${approved} approved`}
                {sent > 0 && ` · ${sent} sent`}
                {drafts + flagged + approved + sent === 0 && 'nothing written yet'}
              </span>
            </Link>
          ))}
        </div>
      )}
    </>
  )
}
