// node --test lib/*.test.ts  — pure functions only, no database.
import assert from 'node:assert/strict'
import { test } from 'node:test'

process.env.UNSUBSCRIBE_SECRET = 'test-secret'

const { makeToken, readToken } = await import('./token.ts')
const { mapRow } = await import('./csv.ts')

test('unsubscribe token round-trips and normalises', () => {
  assert.equal(readToken(makeToken('  Ada@Example.COM ')), 'ada@example.com')
})

test('tampered or forged tokens are rejected', () => {
  const token = makeToken('ada@example.com')
  const [payload, mac] = token.split('.')
  const other = Buffer.from('mallory@example.com').toString('base64url')
  assert.equal(readToken(`${other}.${mac}`), null)
  assert.equal(readToken(`${payload}.${'a'.repeat(mac.length)}`), null)
  assert.equal(readToken('garbage'), null)
  assert.equal(readToken(''), null)
})

test('a different secret cannot verify our tokens', () => {
  const token = makeToken('ada@example.com')
  process.env.UNSUBSCRIBE_SECRET = 'other-secret'
  assert.equal(readToken(token), null)
  process.env.UNSUBSCRIBE_SECRET = 'test-secret'
})

const mapping = { first_name: 'First', email: 'Work Email', company: 'Org' }

test('unmapped columns are kept as context, not dropped', () => {
  const result = mapRow(
    { First: 'Ada', 'Work Email': 'Ada@Example.com', Org: 'Analytical', Funding: '2M', Empty: '' },
    mapping,
  )
  assert.ok('contact' in result)
  assert.equal(result.contact.email, 'ada@example.com')
  assert.equal(result.contact.firstName, 'Ada')
  assert.deepEqual(result.contact.context, { Funding: '2M' })
  assert.equal(result.contact.lastName, null)
})

test('rows with no email and no linkedin are rejected', () => {
  assert.ok('error' in mapRow({ First: 'Ada', Org: 'Analytical' }, mapping))
})

test('malformed emails are rejected, not stored', () => {
  assert.ok('error' in mapRow({ 'Work Email': 'ada[at]example.com' }, mapping))
  assert.ok('error' in mapRow({ 'Work Email': 'ada@example' }, mapping))
  assert.ok('error' in mapRow({ 'Work Email': 'a@b.com, c@d.com' }, mapping))
})

test('verification statuses are normalised, and only when recognised', () => {
  const at = (value: string) => {
    const r = mapRow({ E: 'a@b.com', S: value }, { email: 'E', email_status: 'S' })
    assert.ok('contact' in r)
    return r.contact.emailStatus
  }
  assert.equal(at('Valid'), 'verified')
  assert.equal(at('DELIVERABLE'), 'verified')
  assert.equal(at('catch-all'), 'catch_all')
  assert.equal(at('Accept All'), 'catch_all')
  assert.equal(at('undeliverable'), 'invalid')
  // Anything we do not recognise must land on the never-send default, so a
  // stray vendor value can never promote an address to sendable.
  assert.equal(at('unknown'), 'unverified')
  assert.equal(at('probably fine'), 'unverified')
  assert.equal(at(''), 'unverified')

  const unmapped = mapRow({ E: 'a@b.com' }, { email: 'E' })
  assert.ok('contact' in unmapped)
  assert.equal(unmapped.contact.emailStatus, 'unverified')
  assert.equal(unmapped.contact.consentStatus, 'none')
})

test('consent is opt-in only when the CSV says so plainly', () => {
  const at = (value: string) => {
    const r = mapRow({ E: 'a@b.com', C: value }, { email: 'E', consent_status: 'C' })
    assert.ok('contact' in r)
    return r.contact.consentStatus
  }
  assert.equal(at('Yes'), 'opted_in')
  assert.equal(at('opted_in'), 'opted_in')
  assert.equal(at('no'), 'none')
  assert.equal(at('maybe'), 'none')
})

test('linkedin-only rows are accepted', () => {
  const result = mapRow(
    { Profile: 'https://linkedin.com/in/ada' },
    { linkedin_url: 'Profile' },
  )
  assert.ok('contact' in result)
  assert.equal(result.contact.email, null)
})
