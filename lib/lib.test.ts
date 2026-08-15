// node --test lib/*.test.ts  — pure functions only, no database.
import assert from 'node:assert/strict'
import { test } from 'node:test'

process.env.UNSUBSCRIBE_SECRET = 'test-secret'

const { makeToken, readToken, makeLink, readLink } = await import('./token.ts')
const { mapRow } = await import('./csv.ts')
const { assembleBody, fill, missing, variables } = await import('./template.ts')
const { validate, claims, ungrounded, spammy } = await import('./validators.ts')
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

test('copy that reads as advertising is flagged before it is sent', () => {
  assert.deepEqual(spammy('A note about your scheduling problem.'), [])
  assert.ok(spammy('Book a FREE demo, no obligation!').includes('salesy'))
  assert.ok(spammy('Act now — limited time.').includes('salesy'))
  // One link is a person sharing something; several is a campaign.
  assert.deepEqual(spammy('Here is the piece: https://a.com/x'), [])
  assert.ok(spammy('See https://a.com and https://b.com').includes('links'))
  assert.ok(spammy('THIS IS URGENT PLEASE READ RIGHT NOW OKAY').includes('shouting'))
  assert.ok(spammy('Are you interested??').includes('shouting'))
  // Acronyms are not shouting, and this is most of what B2B copy is made of.
  assert.deepEqual(spammy('Your CTO mentioned the API and the SDK at PyCon this year.'), [])
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

/* reading the post that comes back ----------------------------------------- */

const { answers, classify, isAutoReply, isBounce, isHardBounce } = await import('./replies.ts')
const { afterFailure, MAX_ATTEMPTS } = await import('./rules.ts')

test('a reply is matched even when it is deep in a thread', () => {
  const ours = '<CADm@mail.gmail.com>'
  // One exchange: our id is the direct parent.
  assert.deepEqual(answers({ 'In-Reply-To': ours }), [ours])
  // Three deep: our id survives only in References. Matching on In-Reply-To
  // alone would silently miss every conversation longer than one exchange.
  const deep = answers({
    'In-Reply-To': '<later@example.com>',
    References: `${ours} <mid@example.com> <later@example.com>`,
  })
  assert.ok(deep.includes(ours), 'the original must still be found')
  assert.equal(deep.length, 4)
  // Headers are case-insensitive in the wild.
  assert.deepEqual(answers({ 'in-reply-to': ours }), [ours])
  assert.deepEqual(answers({}), [])
})

test('a bounce is recognised however it is dressed', () => {
  assert.ok(isBounce({ From: 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>' }))
  assert.ok(isBounce({ 'Content-Type': 'multipart/report; report-type=delivery-status' }))
  assert.ok(isBounce({ Subject: 'Undeliverable: A quick question' }))
  assert.ok(isBounce({ Subject: 'Delivery Status Notification (Failure)' }))
  assert.ok(!isBounce({ From: 'ada@example.com', Subject: 'Re: A quick question' }))
})

test('permanent and temporary bounces are told apart', () => {
  // They deserve opposite treatment: suppress forever, or try again later.
  assert.equal(isHardBounce('550 5.1.1 The email account does not exist'), true)
  assert.equal(isHardBounce('user unknown'), true)
  assert.equal(isHardBounce('452 4.2.2 The recipient mailbox is full'), false)
  assert.equal(isHardBounce('4.7.0 Try again later'), false)
})

test('an out-of-office is not a reply', () => {
  // Counting these as engagement would corrupt the one number the system is
  // judged on, and inflate it in exactly the cases that mean least.
  assert.ok(isAutoReply({ 'Auto-Submitted': 'auto-replied' }))
  assert.ok(isAutoReply({ Precedence: 'bulk' }))
  assert.ok(isAutoReply({ Subject: 'Out of office until Monday' }))
  assert.ok(isAutoReply({ Subject: 'Automatic reply: A quick question' }))
  assert.ok(!isAutoReply({ Subject: 'Re: A quick question' }))
  assert.ok(!isAutoReply({ 'Auto-Submitted': 'no' }))
})

test('a bounce is never read as engagement', () => {
  const ours = '<abc@mail.gmail.com>'
  // A Mailer-Daemon notification IS a reply to our message by threading, so
  // order matters here: read it as a reply and the meaning inverts.
  const bounce = classify(
    { From: 'mailer-daemon@googlemail.com', Subject: 'Undeliverable', 'In-Reply-To': ours },
    '550 5.1.1 no such user',
  )
  assert.equal(bounce.kind, 'bounce')
  assert.equal(bounce.kind === 'bounce' && bounce.hard, true)

  assert.equal(classify({ 'In-Reply-To': ours, Subject: 'Re: hello' }).kind, 'reply')
  assert.equal(classify({ 'In-Reply-To': ours, Precedence: 'bulk' }).kind, 'auto')
  // Mail that answers nothing of ours is none of our business.
  assert.equal(classify({ Subject: 'Newsletter' }).kind, 'ignore')
})

test('a failing message backs off and is eventually given up on', () => {
  const now = new Date('2026-08-15T12:00:00Z')
  const first = afterFailure(0, now)
  assert.equal(first.attempts, 1)
  assert.equal(first.giveUp, false)
  assert.ok(first.nextAttemptAt! > now, 'must wait before trying again')

  const second = afterFailure(1, now)
  assert.ok(
    second.nextAttemptAt!.getTime() - now.getTime() >
      first.nextAttemptAt!.getTime() - now.getTime(),
    'each wait is longer than the last',
  )

  // The whole point: it stops. Before this, a bad message was retried every
  // sixty seconds forever and blocked everything behind it.
  const last = afterFailure(MAX_ATTEMPTS - 1, now)
  assert.equal(last.giveUp, true)
  assert.equal(last.nextAttemptAt, null)
})

/* is the domain allowed to send as itself? --------------------------------- */

const { readDkim, readDmarc, readSpf } = await import('./authdns.ts')

test('SPF is only accepted when it can actually fail someone', () => {
  assert.equal(readSpf(['v=spf1 include:_spf.google.com ~all']).ok, true)
  assert.equal(readSpf([]).ok, false)
  // Softer than nothing: this authorises the entire internet to forge us.
  assert.equal(readSpf(['v=spf1 include:_spf.google.com +all']).ok, false)
  // A record with no all-qualifier never rejects anything, so it protects nothing.
  assert.equal(readSpf(['v=spf1 include:_spf.google.com']).ok, false)
  // Other TXT records at the apex must not be mistaken for SPF.
  assert.equal(readSpf(['google-site-verification=abc']).ok, false)
})

test('an empty DKIM key is a revoked one, not a present one', () => {
  assert.equal(readDkim(['v=DKIM1; k=rsa; p=MIIBIjANBg']).ok, true)
  assert.equal(readDkim(['v=DKIM1; k=rsa; p=']).ok, false, 'p= alone revokes the key')
  assert.equal(readDkim([]).ok, false)
})

test('DMARC passes when published, and says whether it is enforcing', () => {
  assert.equal(readDmarc([]).ok, false)
  // p=none satisfies the bulk-sender requirement while only monitoring, so it
  // passes but must say so rather than look like full protection.
  const monitoring = readDmarc(['v=DMARC1; p=none; rua=mailto:a@b.com'])
  assert.equal(monitoring.ok, true)
  assert.match(monitoring.note, /monitoring/i)
  assert.match(readDmarc(['v=DMARC1; p=reject']).note, /enforcing/i)
  assert.equal(readDmarc(['v=DMARC1; rua=mailto:a@b.com']).ok, false, 'no policy is no protection')
})

/* how sure are we, actually ------------------------------------------------ */

const { interval, separates, winner, sendsNeeded, readable } = await import('./stats.ts')

test('the Wilson interval matches values worked out by hand', () => {
  // 1 of 10 is the standard textbook example: 0.0179 to 0.4042.
  const small = interval(1, 10)
  assert.ok(Math.abs(small.low - 0.0179) < 0.001, `low was ${small.low}`)
  assert.ok(Math.abs(small.high - 0.4042) < 0.001, `high was ${small.high}`)

  // 15 of 20, worked through by hand:
  //   p̂ 0.75 · denom 1.19207 · centre 0.70973 · spread 0.17842
  const bigger = interval(15, 20)
  assert.ok(Math.abs(bigger.low - 0.5313) < 0.001, `low was ${bigger.low}`)
  assert.ok(Math.abs(bigger.high - 0.8882) < 0.001, `high was ${bigger.high}`)
})

test('an interval is always a probability, even at the extremes', () => {
  // This is why Wilson and not the normal approximation: at these rates the
  // textbook formula returns a negative lower bound, which is not a thing.
  for (const [k, n] of [[0, 0], [0, 1], [1, 1], [0, 40], [40, 40], [1, 750]] as const) {
    const i = interval(k, n)
    assert.ok(i.low >= 0 && i.low <= 1, `low out of range at ${k}/${n}: ${i.low}`)
    assert.ok(i.high >= 0 && i.high <= 1, `high out of range at ${k}/${n}: ${i.high}`)
    assert.ok(i.low <= i.high, `inverted at ${k}/${n}`)
  }
  // Nothing observed is not the same as nothing happening.
  assert.ok(interval(0, 40).high > 0.05, '0 of 40 is not "0%"')
  assert.equal(interval(0, 0).high, 1, 'no data means anything is possible')
})

test('the interval narrows as evidence arrives', () => {
  const early = interval(1, 40)
  const later = interval(19, 750)
  assert.ok(early.high - early.low > later.high - later.low)
  // And the honest reading of one click in forty is a range, not "2.5%".
  assert.ok(readable(early).includes('–'), `should be a range, was ${readable(early)}`)
  assert.ok(!readable(interval(300, 10_000)).includes('–'), 'tight enough to state plainly')
})

test('no winner is declared on the sample the old code accepted', () => {
  // The exact case that used to fire: 40 sends, one better than the other.
  // At a 3% base rate this is indistinguishable from luck.
  const a = interval(2, 40)
  const b = interval(0, 40)
  assert.equal(separates(a, b), false)
  assert.equal(winner(a, b), null, 'this is what the old ENOUGH = 40 was calling a winner')
})

test('a winner is declared once the evidence is really there', () => {
  // 8% against 4% at 750 each — the volume the benchmarks say it takes.
  const good = interval(60, 750)
  const poor = interval(30, 750)
  assert.equal(separates(good, poor), true)
  assert.equal(winner(good, poor)?.rate, good.rate)
})

test('how many more sends would settle it', () => {
  const a = interval(2, 40)
  const b = interval(1, 40)
  const need = sendsNeeded(a, b)
  assert.ok(need !== null && need > 100, `a small gap needs many more, got ${need}`)

  // A wider gap needs fewer.
  const wide = sendsNeeded(interval(12, 40), interval(1, 40))
  assert.ok(wide !== null && wide < need!, 'a bigger difference is cheaper to prove')

  // Already conclusive: nothing more required.
  assert.equal(sendsNeeded(interval(60, 750), interval(30, 750)), 0)

  // Identical rates can never be separated, however long you wait.
  assert.equal(sendsNeeded(interval(10, 100), interval(20, 200)), null)
})

test('the published benchmark is reachable, and says so', () => {
  // 3% vs 6% — the doubling the research says needs ~750 each. Confirm our own
  // maths lands in that region rather than the 40 the code used to assume.
  const need = sendsNeeded(interval(3, 100), interval(6, 100))
  assert.ok(need !== null && need > 400 && need < 1400, `expected several hundred, got ${need}`)
})

/* what the numbers say to do ----------------------------------------------- */

const { advise, ENOUGH } = await import('./advice.ts')

const TUNING = {
  windowStart: 540, windowEnd: 1020, bounceThreshold: 300,
  bounceMinimum: 20, catchAllCap: 10, draftBatch: 25,
}
const box = (p = {}) => ({
  email: 'a@x.test', cap: 35, sentToday: 0, sentEver: 100, bounced: 0,
  bounceRate: 0, catchAllShare: 0, halted: false, towardHalt: 0, ...p,
})
const letter = (p = {}) => ({
  id: 'l1', name: 'A letter', status: 'sending', written: 0, flagged: 0, flagRate: 0,
  approved: 0, sent: 0, clicked: 0, replied: 0, clickRate: 0, replyRate: 0, ...p,
})
const source = (p = {}) => ({
  source: 's', contacts: 0, sendable: 0, written: 0, sent: 0, clicked: 0,
  enquired: 0, yieldPerThousand: 0, daysToFirst: null, ...p,
})
const run = (i = {}) =>
  advise({ mailboxes: [], sources: [], letters: [], tuning: TUNING, ...i })

test('advice never fires on a sample too small to mean anything', () => {
  // This is the whole difficulty. One enquiry from four sends looks like a
  // spectacular rate and is nothing at all — advice that fires on noise gets
  // ignored, and then the real advice gets ignored with it.
  const tiny = run({
    letters: [letter({ id: 'a', sent: 4, clicked: 1, clickRate: 0.25 }), letter({ id: 'b', sent: 3 })],
    sources: [source({ source: 'apollo', contacts: 4, sendable: 1, sent: 4, enquired: 1, yieldPerThousand: 250 })],
  })
  assert.ok(!tiny.some((a) => a.title.includes('better than')), 'no winner declared on 4 sends')
  assert.ok(!tiny.some((a) => a.title.includes('best source')), 'no best source on 4 sends')
  assert.ok(!tiny.some((a) => a.title.includes('can be written to')), 'no source judged on 4 contacts')
  assert.equal(tiny[0].title, 'Nothing conclusive yet')
})

test('a halted mailbox is reported as already handled, not as a task', () => {
  const [first] = run({ mailboxes: [box({ halted: true, bounced: 8, sentEver: 92, bounceRate: 0.08 })] })
  assert.equal(first.level, 'acted', 'the sender already did this')
  assert.ok(first.why.includes('automatically'))
  // Acted sorts first: not knowing the machine already stopped sending is how
  // an afternoon gets spent wondering why nothing is going out.
  const mixed = run({
    mailboxes: [box({ halted: true, bounceRate: 0.08 }), box({ email: 'b@x.test', towardHalt: 0.9, bounceRate: 0.027, bounced: 3 })],
  })
  assert.equal(mixed[0].level, 'acted')
  assert.equal(mixed[1].level, 'urgent')
})

test('approaching the line is urgent, because after it the damage is done', () => {
  assert.equal(run({ mailboxes: [box({ towardHalt: 0.9, bounceRate: 0.027 })] })[0].level, 'urgent')
  assert.notEqual(run({ mailboxes: [box({ towardHalt: 0.3 })] })[0].level, 'urgent')
})

test('a prompt that invents things is caught, once there are enough drafts', () => {
  const bad = { written: ENOUGH.drafts, flagged: 6, flagRate: 0.5 }
  assert.ok(run({ letters: [letter(bad)] }).some((a) => a.title.includes('inventing')))
  // Same rate, too few drafts to judge.
  assert.ok(!run({ letters: [letter({ ...bad, written: 4 })] }).some((a) => a.title.includes('inventing')))
})

test('a winner needs the volume the benchmarks say it needs', () => {
  // 4 clicks in 40 against 0 in 40 looks like a landslide and is not: the
  // intervals still overlap. This exact shape used to declare a winner.
  const early = run({
    letters: [
      letter({ id: 'a', name: 'Good', sent: 40, clicked: 4 }),
      letter({ id: 'b', name: 'Bad', sent: 40, clicked: 0 }),
    ],
  })
  assert.ok(!early.some((a) => a.title.includes('really is beating')), '40 sends cannot decide')
  assert.ok(
    early.some((a) => a.title.includes('not provably') && a.why.includes('more sends')),
    'and it says how many more would settle it',
  )

  // 8% against 4% at 750 each — the volume the research says it takes.
  const proven = run({
    letters: [
      letter({ id: 'a', name: 'Good', sent: 750, clicked: 60 }),
      letter({ id: 'b', name: 'Bad', sent: 750, clicked: 30 }),
    ],
  })
  assert.ok(proven.some((a) => a.title.includes('Good') && a.title.includes('really is beating')))

  // Two letters that both produced nothing have no winner and no near-miss.
  const dead = run({
    letters: [letter({ id: 'a', name: 'A', sent: 750 }), letter({ id: 'b', name: 'B', sent: 750 })],
  })
  assert.ok(!dead.some((a) => a.title.includes('beating') || a.title.includes('not provably')))
})

test('an expensive source is named, and so is a good one', () => {
  const junk = run({ sources: [source({ source: 'apollo', contacts: 400, sendable: 40 })] })
  assert.ok(junk.some((a) => a.title.includes('10.0%') && a.title.includes('apollo')))

  const n = ENOUGH.outcome
  const good = run({
    sources: [
      source({ source: 'evaboot', contacts: 200, sendable: 200, sent: n, enquired: 6, yieldPerThousand: 150 }),
      source({ source: 'apollo', contacts: 200, sendable: 200, sent: n, enquired: 1, yieldPerThousand: 25 }),
    ],
  })
  assert.ok(good.some((a) => a.title.includes('evaboot') && a.title.includes('best source')))
})

test('an empty report says so rather than looking broken', () => {
  const [only] = run()
  assert.equal(only.title, 'Nothing has gone out yet')
  assert.ok(only.why.includes('put a letter in the post'))
})

/* warming a domain --------------------------------------------------------- */

const { warmupCap, daysSince, WARMUP_START } = await import('./rules.ts')

test('a fresh domain starts small and never jumps to full cap', () => {
  // Day one is the dangerous one: a brand new domain sending 35 is how it gets
  // burned before it has any reputation to spend.
  assert.equal(warmupCap(35, 0), WARMUP_START)
  assert.equal(warmupCap(35, 1), 5)

  // Monotonic — a ramp that ever goes backwards would look like a bug.
  let previous = 0
  for (let day = 0; day <= 40; day++) {
    const today = warmupCap(35, day)
    assert.ok(today >= previous, `day ${day} went backwards`)
    assert.ok(today <= 35, `day ${day} exceeded the configured cap`)
    previous = today
  }
})

test('the ramp reaches the cap in about three weeks, as the docs promise', () => {
  assert.ok(warmupCap(35, 14) < 35, 'still warming at two weeks')
  assert.equal(warmupCap(35, 21), 35, 'full cap at three weeks')
  assert.equal(warmupCap(35, 90), 35, 'and stays there')
})

test('warm-up can only ever lower a cap, never raise one', () => {
  // A small mailbox cap must win over the ramp, or warming would quietly
  // increase what someone deliberately set low.
  assert.equal(warmupCap(3, 90), 3)
  assert.equal(warmupCap(3, 0), 3, 'never above its own cap even on day one')
  // An established domain is not warming at all.
  assert.equal(warmupCap(35, null), 35)
})

test('a domain age is whole days, and absent when it was never started', () => {
  const now = new Date('2026-08-15T09:00:00Z')
  assert.equal(daysSince(null, now), null)
  assert.equal(daysSince(new Date('2026-08-15T08:00:00Z'), now), 0, 'started today')
  assert.equal(daysSince(new Date('2026-08-14T08:00:00Z'), now), 1)
  assert.equal(daysSince(new Date('2026-07-25T09:00:00Z'), now), 21)
})

/* writing the letter ------------------------------------------------------- */

const { review, shape, fieldsUsed, KINDS } = await import('./compose.ts')

test('every shape produces a letter the generator can actually fill', () => {
  // A shape that forgot the slot would produce a campaign that can never draft
  // anything, and nothing downstream would say why.
  for (const kind of KINDS) {
    const s = shape(kind, 'Worth a word?', 'Dibakar')
    assert.ok(s.body.includes('{{personalised}}'), `${kind} has no slot`)
    assert.ok(s.subject.trim().length > 0, `${kind} has no subject`)
    assert.ok(s.prompt.length > 40, `${kind} has no real instruction`)
    assert.deepEqual(review(s.subject, s.body, 'personalised').filter((n) => n.level === 'stop'), [])
  }
})

test('the ask and the sign-off actually land in the body', () => {
  const s = shape('intro', 'Fifteen minutes on Thursday?', 'Ada')
  assert.ok(s.body.includes('Fifteen minutes on Thursday?'))
  assert.ok(s.body.trimEnd().endsWith('Ada'))
  // An empty ask must not leave the letter without one.
  assert.ok(shape('intro', '', '').body.includes('?'))
})

test('structural faults stop, style faults only warn', () => {
  const stops = (n: { level: string }[]) => n.filter((x) => x.level === 'stop').length

  assert.equal(stops(review('Hi', 'No slot here. Worth a word?', 'personalised')), 1)
  assert.equal(stops(review('', '{{personalised}} Worth a word?', 'personalised')), 1)
  // Tired phrasing is worth saying and never worth blocking — it is advice, and
  // a checker that blocks on advice gets ignored.
  const tired = review('Quick question', 'I hope this finds you well. {{personalised}} Worth a word?', 'personalised')
  assert.equal(stops(tired), 0)
  assert.ok(tired.length >= 2, 'both tired phrases noticed')
})

test('the checks catch what actually loses replies', () => {
  const has = (notes: { text: string }[], bit: string) => notes.some((n) => n.text.includes(bit))

  // Two asks give the reader a decision to make before replying.
  assert.ok(has(review('x', '{{personalised}} Free? Thursday?', 'personalised'), '2 questions'))
  // No ask at all leaves nothing to reply to.
  assert.ok(has(review('x', '{{personalised}} Regards.', 'personalised'), 'nothing easy to reply to'))
  // A raw link costs deliverability; the tracked one is offered instead.
  assert.ok(has(review('x', '{{personalised}} see https://a.example ok?', 'personalised'), 'deliverability'))
  assert.ok(has(review('A very long subject line about our platform today', '{{personalised}} ok?', 'personalised'), 'Subject is long'))
})

test('the fields a letter leans on are named, so the audience step can warn', () => {
  const used = fieldsUsed('About {{company}}', 'Hi {{first_name}}, {{personalised}} {{link}}', 'mention {{title}}')
  assert.deepEqual(used.sort(), ['company', 'first_name', 'title'])
  // The two the generator supplies are never reported as missing data.
  assert.ok(!used.includes('personalised') && !used.includes('link'))
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
