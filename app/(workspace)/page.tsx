import Link from 'next/link'
import { listCampaigns } from '@/lib/campaigns'
import { newCampaign } from './actions'
import { accent, field, Pill, Screen } from './ui'

export default async function CampaignsPage() {
  const rows = await listCampaigns()

  return (
    <Screen
      title="Campaigns"
      note="Write, review, then send from our own mailboxes."
      actions={
        <form action={newCampaign} className="flex shrink-0 gap-2">
          <input name="name" placeholder="New campaign name" className={`${field} w-56`} />
          <button className={accent}>Create</button>
        </form>
      }
    >
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
              className="flex items-center gap-4 border-b border-line px-6 py-3.5 transition-colors hover:bg-raised/50"
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
    </Screen>
  )
}
