import { createSign } from 'node:crypto'
import { isSuppressed } from './suppression.ts'

const SCOPE = 'https://www.googleapis.com/auth/gmail.send'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const API = 'https://gmail.googleapis.com/gmail/v1/users/me/messages'

type ServiceAccount = { client_email: string; private_key: string }

function credentials(): ServiceAccount | null {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON
  if (!raw) return null
  const parsed = JSON.parse(raw) as ServiceAccount
  // Env files usually carry the key with literal \n rather than real newlines.
  return { ...parsed, private_key: parsed.private_key.replace(/\\n/g, '\n') }
}

export const isConfigured = () => credentials() !== null

const b64url = (input: string | Buffer) =>
  Buffer.from(input).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')

/**
 * One service account impersonates every mailbox, so there is no per-mailbox
 * OAuth dance and no refresh tokens to store. `sub` is the mailbox we send as.
 */
async function accessToken(account: ServiceAccount, mailbox: string) {
  const now = Math.floor(Date.now() / 1000)
  const claims = {
    iss: account.client_email,
    sub: mailbox,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  }
  const unsigned = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify(claims))}`
  const signature = createSign('RSA-SHA256').update(unsigned).end().sign(account.private_key)
  const assertion = `${unsigned}.${b64url(signature)}`

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  })
  const body = (await response.json()) as { access_token?: string; error_description?: string }
  if (!response.ok || !body.access_token) {
    throw new Error(`google token exchange failed: ${body.error_description ?? response.status}`)
  }
  return body.access_token
}

const encodeHeader = (value: string) =>
  /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value).toString('base64')}?=`

/** Plain text, always. No HTML part, no tracking pixel, no link rewriting. */
function mime(from: string, to: string, subject: string, body: string) {
  return [
    `From: ${encodeHeader(from)}`,
    `To: ${to}`,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="utf-8"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(body).toString('base64').replace(/(.{76})/g, '$1\n'),
  ].join('\r\n')
}

export type Delivery = { messageIdHeader: string; dryRun: boolean }

/**
 * The wire. Rule 1's check runs again here, inside the transport, so no future
 * caller can reach Gmail without passing it — not even by mistake.
 */
export async function deliver(
  from: string,
  to: string,
  subject: string,
  body: string,
): Promise<Delivery> {
  if (await isSuppressed(to)) throw new Error(`refused: ${to} is suppressed`)

  const account = credentials()
  if (!account) {
    // No credentials configured: record what would have been sent and move on.
    return { messageIdHeader: `<dry-run.${crypto.randomUUID()}@qatalyst.local>`, dryRun: true }
  }

  const token = await accessToken(account, from)
  const sent = await fetch(`${API}/send`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ raw: b64url(mime(from, to, subject, body)) }),
  })
  if (!sent.ok) throw new Error(`gmail send failed: ${sent.status} ${await sent.text()}`)
  const { id } = (await sent.json()) as { id: string }

  // Rule 6. Gmail assigns the Message-ID, so read it back rather than guess —
  // without it, phase 4 cannot match a reply or a bounce to what we sent.
  const meta = await fetch(`${API}/${id}?format=metadata&metadataHeaders=Message-ID`, {
    headers: { authorization: `Bearer ${token}` },
  })
  if (!meta.ok) throw new Error(`gmail metadata failed: ${meta.status}`)
  const payload = (await meta.json()) as {
    payload?: { headers?: { name: string; value: string }[] }
  }
  const header = payload.payload?.headers?.find((h) => h.name.toLowerCase() === 'message-id')?.value
  if (!header) throw new Error('gmail did not return a Message-ID')

  return { messageIdHeader: header, dryRun: false }
}
