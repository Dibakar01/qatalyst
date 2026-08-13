// node --test lib/*.test.ts  — pure functions only, no database.
import assert from 'node:assert/strict'
import { test } from 'node:test'

process.env.UNSUBSCRIBE_SECRET = 'test-secret'

const { makeToken, readToken } = await import('./token.ts')
const { mapRow } = await import('./csv.ts')
const { assembleBody, fill, missing, variables } = await import('./template.ts')
const { validate, claims, ungrounded } = await import('./validators.ts')
const { allowanceNow, batchSize, maySend, shouldHalt, WINDOW } = await import('./rules.ts')
const mat4 = await import('./mat4.ts')

const ada = {
  firstName: 'Ada',
  lastName: 'Lovelace',
  company: 'Analytical Engines',
  title: 'CTO',
  context: { 'Funding round': 'Series A', Notes: 'Spoke at PyCon about batch jobs' },
}

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

/* templates --------------------------------------------------------------- */

test('templates fill from contact fields and context columns', () => {
  const values = variables(ada)
  assert.equal(
    fill('Hi {{first_name}} at {{company}} ({{context.Funding round}})', values),
    'Hi Ada at Analytical Engines (Series A)',
  )
  assert.equal(fill('Hi {{first_name}}, {{nope}}', values), 'Hi Ada, ')
})

test('gaps in a template are reported rather than shipped silently', () => {
  const values = variables({ ...ada, company: null })
  assert.deepEqual(missing('Hi {{first_name}} at {{company}}. {{personalised}}', values), [
    'company',
  ])
})

test('every assembled body carries an opt-out sentence and the link', () => {
  const body = assembleBody('Hi Ada,\n\nSomething specific.', 'https://u.example/abc')
  assert.match(body, /would rather I did not write again/)
  assert.ok(body.includes('https://u.example/abc'))
  // Rule 4: no List-Unsubscribe headers anywhere near a person-to-person email.
  assert.doesNotMatch(body, /List-Unsubscribe/i)
})

/* validators -------------------------------------------------------------- */

test('grounding: claims are the numbers and mid-sentence proper nouns', () => {
  const found = claims('Congratulations on the Series A. I saw 40 new roles at Bletchley.')
  assert.ok(found.includes('Series'))
  assert.ok(found.includes('40'))
  assert.ok(found.includes('Bletchley'))
  assert.ok(!found.includes('Congratulations'), 'sentence-initial words are not claims')
  assert.ok(!found.includes('I'))
})

test('grounding: invented detail is flagged, real detail is not', () => {
  assert.deepEqual(ungrounded('Congratulations on the Series A round.', ada), [])
  assert.deepEqual(ungrounded('Loved your talk at PyCon.', ada), [])
  assert.deepEqual(ungrounded('Congratulations on the Series B round.', ada), ['B'])
  assert.ok(validate('I saw you raised 40 million from Sequoia.', ada).includes('ungrounded'))
})

test('substance: mail-merge dressed as personalisation is flagged', () => {
  assert.ok(validate('I saw you are CTO at Analytical Engines.', ada).includes('thin'))
  assert.ok(validate('Hi Ada!', ada).includes('thin'))
  assert.deepEqual(
    validate('Your PyCon talk on batch jobs matched a problem we keep hitting with scheduling.', ada),
    [],
  )
})

test('a message only passes when both validators pass', () => {
  // Grounded but thin, and substantial but invented — each fails on its own.
  assert.deepEqual(validate('Series A, congratulations.', ada), ['thin'])
  assert.deepEqual(
    validate('Your recent acquisition of Bletchley Park caught our attention here.', ada),
    ['ungrounded'],
  )
})

/* sending rules ----------------------------------------------------------- */

test('the daily cap is released across the window, never in a burst', () => {
  assert.equal(allowanceNow(35, 0, WINDOW.start - 1), 0, 'nothing before the window opens')
  assert.equal(allowanceNow(35, 0, WINDOW.end), 0, 'nothing after it closes')
  assert.equal(allowanceNow(35, 0, WINDOW.start), 0, 'the cap is not unlocked at 09:00')
  assert.equal(allowanceNow(35, 0, WINDOW.start + 240), 17, 'about half way by mid-afternoon')
  assert.equal(allowanceNow(35, 17, WINDOW.start + 240), 0, 'already sent its share')
  // The whole point: a worker down all morning cannot dump the backlog at 16:59.
  assert.ok(allowanceNow(35, 0, WINDOW.end - 1) < 35)
})

test('send eligibility follows email status, not hope', () => {
  const plain = { sendsCatchAll: false, active: true }
  const catchAll = { sendsCatchAll: true, active: true }
  assert.equal(maySend('verified', plain), true)
  assert.equal(maySend('catch_all', plain), false, 'catch-all needs a mailbox flagged for it')
  assert.equal(maySend('catch_all', catchAll), true)
  assert.equal(maySend('unverified', catchAll), false)
  assert.equal(maySend('invalid', catchAll), false)
  assert.equal(maySend('verified', { ...plain, active: false }), false)
})

test('a typed batch size can never run away with the model budget', () => {
  assert.equal(batchSize(''), 25, 'no argument means the default')
  assert.equal(batchSize('abc'), 25)
  assert.equal(batchSize('-3'), 25)
  assert.equal(batchSize('0'), 25)
  assert.equal(batchSize('40.5'), 25, 'half a draft is not a batch')
  assert.equal(batchSize('40'), 40)
  assert.equal(batchSize('500'), 100, 'the ceiling holds however big the ask')
})

/* the letter's matrices --------------------------------------------------- */

// Column-major, and multiply applies right to left. Both are easy to get
// backwards and the symptom is a model that is inside out rather than an error.
const close = (a: Float32Array, b: number[], why: string) =>
  a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < 1e-6, `${why} at ${i}: ${v} ≠ ${b[i]}`))

test('a matrix multiplied by the identity is unchanged', () => {
  const m = mat4.translation(3, -2, 7)
  close(mat4.multiply(mat4.identity(), m), [...m], 'identity on the left')
  close(mat4.multiply(m, mat4.identity()), [...m], 'identity on the right')
})

test('translation lands in the fourth column, where WebGL reads it', () => {
  const m = mat4.translation(3, -2, 7)
  assert.deepEqual([m[12], m[13], m[14], m[15]], [3, -2, 7, 1])
})

test('multiply applies the right-hand matrix first', () => {
  // Rotate, then move: the offset must survive untouched in the last column.
  // If the order were flipped the rotation would spin the offset too.
  const m = mat4.multiply(mat4.translation(0, 0, -5), mat4.rotationY(Math.PI / 2))
  close(m, [0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, -5, 1], 'move after turn')
})

test('a quarter turn about y sends +x to -z', () => {
  // First column is where the x axis ends up. Right-handed, so it goes to -z.
  const m = mat4.rotationY(Math.PI / 2)
  close(m.slice(0, 4) as Float32Array, [0, 0, -1, 0], 'x axis')
})

test('perspective puts -1 in the w row, so w becomes the depth', () => {
  const m = mat4.perspective(Math.PI / 4, 2, 0.1, 100)
  assert.ok(Math.abs(m[0] - 1 / Math.tan(Math.PI / 8) / 2) < 1e-6, 'x is divided by aspect')
  assert.equal(m[11], -1)
  assert.equal(m[15], 0)
})

test('a mailbox halts above 3% bounces, but not on a tiny sample', () => {
  assert.equal(shouldHalt(2, 1), false, 'one bounce in three proves nothing')
  assert.equal(shouldHalt(97, 3), false, 'exactly 3% is not above 3%')
  assert.equal(shouldHalt(96, 4), true)
  assert.equal(shouldHalt(1000, 0), false)
})
