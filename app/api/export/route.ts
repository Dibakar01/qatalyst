import { requireAuth } from '@/lib/auth'
import { listContacts } from '@/lib/contacts'

const HEADERS = [
  'first_name',
  'last_name',
  'email',
  'company',
  'title',
  'linkedin_url',
  'source',
  'email_status',
  'consent_status',
  'created_at',
  'context',
] as const

const cell = (value: unknown) => {
  const text = value == null ? '' : String(value)
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

export async function GET(request: Request) {
  await requireAuth()
  const params = new URL(request.url).searchParams

  // Exports exactly what the screen is showing, filters and all.
  const { rows } = await listContacts({
    q: params.get('q') ?? undefined,
    status: params.get('status') ?? undefined,
    consent: params.get('consent') ?? undefined,
    size: 5000,
  })

  const body = [
    HEADERS.join(','),
    ...rows.map((row) =>
      [
        row.firstName,
        row.lastName,
        row.email,
        row.company,
        row.title,
        row.linkedinUrl,
        row.source,
        row.emailStatus,
        row.consentStatus,
        row.createdAt.toISOString(),
        JSON.stringify(row.context),
      ]
        .map(cell)
        .join(','),
    ),
  ].join('\n')

  return new Response(body, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="contacts-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  })
}
