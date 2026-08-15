// node --test lib/*.test.ts  — pure functions only, no database.
import assert from 'node:assert/strict'
import { test } from 'node:test'

process.env.UNSUBSCRIBE_SECRET = 'test-secret'

const { makeToken, readToken, makeLink, readLink } = await import('./token.ts')
const { mapRow } = await import('./csv.ts')
const { assembleBody, fill, missing, variables } = await import('./template.ts')
const { validate, claims, ungrounded } = await import('./validators.ts')
const { allowanceNow, batchSize, frankingCode, maySend, nextAction, shouldHalt, WINDOW } =
  await import('./rules.ts')
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

/* the rules, once they are tunable ---------------------------------------- */

const { clampTuning, LIMITS } = await import('./rules.ts')

const SAFE = {
  windowStart: 9 * 60,
  windowEnd: 17 * 60,
  bounceThreshold: 300,
  bounceMinimum: 20,
  catchAllCap: 10,
  draftBatch: 25,
}

test('a tuned window moves the whole ramp with it', () => {
  const evening = { windowStart: 12 * 60, windowEnd: 20 * 60 }
  // 09:00 is inside the default window but outside this one.
  assert.equal(allowanceNow(35, 0, 9 * 60, evening), 0, 'before the tuned window')
  assert.equal(allowanceNow(35, 0, 16 * 60, evening), 17, 'half way through the tuned window')
  // The same minute means something different under each window, which is the
  // entire point of making it a setting.
  assert.notEqual(allowanceNow(35, 0, 10 * 60), allowanceNow(35, 0, 10 * 60, evening))
})

test('a tuned bounce threshold moves the halt line', () => {
  // 4 in 100 is 4%: over the default 3%, under a tuned 5%.
  assert.equal(shouldHalt(96, 4), true, 'the default line')
  assert.equal(shouldHalt(96, 4, { bounceThreshold: 500 }), false, 'a looser line')
  assert.equal(shouldHalt(96, 4, { bounceThreshold: 100 }), true, 'a tighter line')
  // And the sample minimum still guards a tiny run at any threshold.
  assert.equal(shouldHalt(2, 1, { bounceThreshold: 100 }), false, 'still too few to judge')
  assert.equal(shouldHalt(2, 1, { bounceThreshold: 100, bounceMinimum: 3 }), true)
})

test('tuning is clamped, so no setting can burn the domain', () => {
  // The dangerous direction: a threshold so loose nothing ever halts.
  assert.equal(clampTuning({ bounceThreshold: 5000 }, SAFE).bounceThreshold, LIMITS.bounceThreshold[1])
  assert.equal(clampTuning({ bounceThreshold: 0 }, SAFE).bounceThreshold, LIMITS.bounceThreshold[0])
  // 3am sending reads as a machine.
  assert.equal(clampTuning({ windowStart: 0 }, SAFE).windowStart, LIMITS.windowStart[0])
  assert.equal(clampTuning({ windowEnd: 23 * 60 }, SAFE).windowEnd, LIMITS.windowEnd[1])

  // A window that ends before it begins would silently send nothing all day —
  // the worst failure here, because it looks like the app is simply broken.
  const inverted = clampTuning({ windowStart: 15 * 60, windowEnd: 9 * 60 }, SAFE)
  assert.ok(inverted.windowEnd > inverted.windowStart, 'never inverted')

  // Junk leaves the safe value in place rather than becoming NaN.
  assert.deepEqual(clampTuning({ bounceThreshold: 'abc', catchAllCap: null }, SAFE), SAFE)
  assert.deepEqual(clampTuning({}, SAFE), SAFE)
})

/* the column presets ------------------------------------------------------- */

const { PRESETS } = await import('./connectors.ts')

test('every exporter preset can actually produce an importable row', () => {
  // A preset with a typo'd header makes every row malformed: the import reports
  // "0 new" and nothing on screen says why. Nothing else catches that — the
  // types are all `string`, and a mapping to a column that does not exist is
  // indistinguishable from one that does until rows arrive.
  for (const [name, preset] of Object.entries(PRESETS)) {
    assert.ok(
      preset.mapping.email || preset.mapping.linkedin_url,
      `${name} maps neither email nor linkedin_url, so runImport would reject every row`,
    )
  }
})

test('a row in each exporter\'s own column names survives mapping', () => {
  // One realistic row per tool, spelled the way that tool actually spells it.
  const samples: Record<string, Record<string, string>> = {
    evaboot: { 'First Name': 'Ada', 'Last Name': 'Lovelace', Email: 'ada@a.example', Company: 'Engines', Title: 'CTO', 'Email Status': 'verified' },
    phantombuster: { firstName: 'Ada', lastName: 'Lovelace', email: 'ada@b.example', companyName: 'Engines', title: 'CTO' },
    clay: { 'First Name': 'Ada', 'Last Name': 'Lovelace', 'Work Email': 'ada@c.example', 'Company Name': 'Engines', 'Job Title': 'CTO' },
    apollo_csv: { 'First Name': 'Ada', 'Last Name': 'Lovelace', Email: 'ada@d.example', Company: 'Engines', Title: 'CTO', 'Email Status': 'verified' },
  }

  for (const [name, row] of Object.entries(samples)) {
    const result = mapRow(row, PRESETS[name].mapping)
    assert.ok(!('error' in result), `${name}: ${'error' in result ? result.error : ''}`)
    assert.equal(result.contact.firstName, 'Ada', `${name} lost the first name`)
    assert.equal(result.contact.company, 'Engines', `${name} lost the company`)
    assert.ok(result.contact.email?.endsWith('.example'), `${name} lost the address`)
  }

  // And the status column really is read, not just carried along.
  const verified = mapRow(samples.evaboot, PRESETS.evaboot.mapping)
  assert.equal('error' in verified ? null : verified.contact.emailStatus, 'verified')
})

/* tracked links ----------------------------------------------------------- */

test('a tracked link carries who it was for, and survives a round trip', () => {
  const trace = { contactId: 'c1e7f8a2-0000-4000-8000-000000000001', campaignId: 'aa11bb22-0000-4000-8000-000000000002' }
  assert.deepEqual(readLink(makeLink(trace)), trace)
})

test('a forged or swapped tracked link is refused, not misread', () => {
  const trace = { contactId: 'c1', campaignId: 'k1' }
  const token = makeLink(trace)
  const [body, sig] = token.split('.')

  assert.equal(readLink(`${body}.${'a'.repeat(sig.length)}`), null, 'bad signature')
  assert.equal(readLink(body), null, 'no signature at all')
  assert.equal(readLink(''), null, 'empty')

  // An unsubscribe token must never be usable as a tracked link, or a click
  // would attribute to whatever the address happened to parse into.
  assert.equal(readLink(makeToken('ada@example.com')), null, 'wrong payload kind')
  // And the reverse: a link token is not an address.
  assert.equal(readToken(token), null, 'a link is not an unsubscribe token')
})

/* telling one letter from another ----------------------------------------- */

test('the franking bars are stable per letter and different between letters', () => {
  const id = '7bfb60b1-d287-4602-b0dd-633b6db8737a'
  assert.equal(frankingCode(id), frankingCode(id), 'the same letter is always struck the same')

  // A code that collapses would make every envelope look alike, and nothing on
  // screen would say so — the stack would just stop being readable.
  const ids = Array.from({ length: 500 }, (_, i) => `campaign-${i}`)
  const codes = new Set(ids.map(frankingCode))
  assert.equal(codes.size, ids.length, 'no collisions across 500 letters')

  // Neighbouring ids must not produce neighbouring bars, or a run of campaigns
  // created together would all look the same.
  assert.ok(Math.abs(frankingCode('campaign-1') - frankingCode('campaign-2')) > 1000)

  for (const code of codes) {
    assert.ok(Number.isInteger(code) && code >= 0 && code < 2 ** 24, 'survives the trip as a float')
  }
})

/* what the mark on the letter says ---------------------------------------- */

const tally = (patch: Partial<Record<'drafts' | 'flagged' | 'approved' | 'sent', number>> = {}) => ({
  drafts: 0,
  flagged: 0,
  approved: 0,
  sent: 0,
  ...patch,
})

test('the mark asks for the earliest thing that is actually stuck', () => {
  // A marked draft outranks everything: it is the only state that cannot move
  // without a person, so a letter is never allowed to advertise anything else.
  assert.equal(nextAction(tally({ flagged: 3, drafts: 9, approved: 40 }), 200, 'sending').action, 'read')
  assert.equal(nextAction(tally({ flagged: 3 }), 0, 'draft').count, 3)

  // Already posting needs nothing except a way to stop it.
  assert.equal(nextAction(tally({ approved: 12 }), 50, 'sending').action, 'hold')

  assert.equal(nextAction(tally({ drafts: 9, approved: 4 }), 50, 'ready').action, 'read')
  assert.equal(nextAction(tally({ approved: 4 }), 50, 'ready').action, 'post')
  assert.equal(nextAction(tally(), 50, 'draft').action, 'draft')
})

test('the mark never offers to draft more than one batch, or to draft nobody', () => {
  assert.equal(nextAction(tally(), 400, 'draft').count, 25, 'a batch, not the whole audience')
  assert.equal(nextAction(tally(), 7, 'draft').count, 7, 'or the whole audience when it is smaller')
  assert.equal(nextAction(tally(), 0, 'draft').action, 'none', 'nobody left to write to')
  assert.equal(nextAction(tally({ sent: 80 }), 0, 'done').label, 'all posted')
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

test('a point through a matrix lands where the mark has to be pinned', () => {
  close(
    new Float32Array(mat4.transformPoint(mat4.identity(), 1, 2, 3)),
    [1, 2, 3, 1],
    'identity moves nothing',
  )
  close(
    new Float32Array(mat4.transformPoint(mat4.translation(5, -1, 0), 1, 0, 0)),
    [6, -1, 0, 1],
    'translation is applied',
  )
})

test('a point behind the camera reports w <= 0 rather than mirroring', () => {
  // Dividing by a negative w would put the mark on the opposite side of the
  // screen, which reads as the stamp jumping to the wrong corner. The sign of
  // w is what lets the caller hide it instead.
  const p = mat4.perspective(Math.PI / 4, 1, 0.1, 100)
  assert.ok(mat4.transformPoint(p, 0, 0, -2)[3] > 0, 'in front of the camera')
  assert.ok(mat4.transformPoint(p, 0, 0, 2)[3] <= 0, 'behind it')
  const [x, y] = mat4.transformPoint(p, 0, 0, -2)
  assert.equal(x, 0, 'a point on the axis projects to the centre')
  assert.equal(y, 0)
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
