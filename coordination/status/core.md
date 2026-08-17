# core — status

Lane: `core`. Worktree: `/Users/dibakar/Documents/Qalakaar/qatalyst-core`, branch `core`,
DB `qatalyst_core`. Appended at every task boundary; nobody else writes this file.

**On the `/tmp/*.ts` verification scripts referenced below:** they are a convenience and `/tmp`
is ephemeral. Every assertion in each one is written out in full in the entry that names it, so
nothing is lost if they are gone — they are transcription, not the source. Run one with
`cp /tmp/<name> ./chk.ts && node --env-file-if-exists=.env ./chk.ts` from the worktree (the
`.ts` extension inside the project is what makes Node resolve the relative imports).

---

- **t0 — setup note, not a blocker.** `EnterWorktree` refuses this worktree: it lives at
  `~/Documents/Qalakaar/qatalyst-core`, not under the repo's `.claude/worktrees/`, and the tool
  only switches sessions already inside a worktree. Working via absolute paths into the
  worktree instead; `git -C` for every commit. All edits land on branch `core`. No behaviour
  difference, just recording why the first action in the brief did not take.

- **S2 landed — `npm run db:seed` now exits.** `scripts/seed.ts` imported `db`/`sql` from
  `../db/index.ts` like every sibling script; the private `postgres(..., {max:1})` pool is
  gone. Verified: seed exits 0 in 0.4s (was: alive indefinitely).
  **Check to encode (qa):** `db:seed` must exit within 30s.
  ⚠️ **`timeout` is not on macOS** — `scripts/verify.sh` needs `gtimeout` (coreutils) or a
  node/perl watchdog, or the PROOF step silently fails to run on this box.
  Next: S1.

- **S1 landed — CRITICAL closed.** Migration `0017_nasty_talon.sql` (one line,
  `ALTER TYPE message_status ADD VALUE 'sending' BEFORE 'sent'`), applied and confirmed.
  Adds no tables, so **§3.1 holds: qa's truncate list is unchanged.**

  Four parts, all in `lib/send.ts` + `lib/gmail.ts`:
  1. `claimForSend(messageId, mailboxId?)` — frozen signature honoured; the second argument is
     **optional**, so `claimForSend(id)` is exactly as contracted. It exists because the
     report's own SQL stamps `mailbox_id` at the claim, and a row stranded in `sending` should
     say which mailbox was holding it. One statement, predicated on `status='approved'`,
     `RETURNING id`. `attempts` is incremented here, not in the catch — a crash has no catch
     block left to run. `afterFailure(message.attempts)` computes the same number from the row
     the tick already read, so the count is not doubled.
  2. `deliver()` is now the wire alone. The Message-ID read-back moved to
     `messageIdFor(from, gmailId, credentialKey)` — best effort, never throws. `Delivery` gained
     `gmailId: string | null` and `messageIdHeader` is now `string | null` (null until read
     back; a synthetic value on a dry run, unchanged). Both DB columns were already nullable.
  3. `sent` is persisted **before** the read-back (D2). A failed read-back writes
     `error: 'sent, Message-ID not read back'` and leaves the status `sent`.
  4. `pg_try_advisory_lock(8726411)` on a `sql.reserve()`d connection at the top of `sendTick`;
     a second sender returns `{sent: 0, detail: ['another sender holds the queue…']}`. Released
     in a `finally`, and by the connection dying. The tick body moved into `runTick()` — a
     rename plus a wrapper, no re-indentation.

  **One judgement call worth a manager's eye (not a blocker, no contract moved).** A throw out
  of `deliver()` returns the row to `approved` **only** when it is a `Refused` — a new exported
  error class meaning Gmail is *known* not to have taken it (suppression, token exchange
  failure, a non-2xx from the send call). A bare `fetch` rejection is deliberately *not*
  wrapped: the request may have been accepted and the response lost. Those leave the row in
  `sending` with the error recorded — visible, never re-selected, never delivered twice. The
  alternative, retrying an unknown outcome, is the same bug S1 is about.

  **Verified:** `npm run lint` clean · `npm test` 113/113 · `npm run test:acceptance` all pass
  (including `rule 6: every send captured its Message-ID`).

  **Check to encode (qa)** — script at `/tmp/s1-check.ts`, run it as
  `node --env-file-if-exists=.env <path>` from the worktree; every assertion fails on the
  pre-S1 code:
  - `claimForSend` on an `approved` row → `{claimed:true}`, row becomes `sending`, `attempts` 1
  - a second `claimForSend` on the same row → `{claimed:false}` (the two-process case)
  - a row left in `sending` survives a `sendTick` untouched — not re-selected, not retried
  - with the advisory lock held elsewhere, `sendTick` sends 0 and says `another sender…`
  - the lock is released, so the following tick runs normally

  Not covered by that script, and it needs module mocking, which is qa's ground:
  stub `deliver` to throw a **plain** `Error` → row must stay `sending` (never `approved`);
  stub it to throw `Refused` (exported from `lib/gmail.ts`) → row must return to `approved`
  with a backoff, and to `flagged` on the third try.

  Next: S4.

- **S4 landed.** All three frozen signatures exported from `lib/send.ts` exactly as contracted:
  `minuteOfDay(now, tz)`, `localDay(now, tz)` — both pure, both via `Intl.DateTimeFormat` with
  `hourCycle: 'h23'` — and `assertDbTimezone()`. Plus `sendTz()`, which reads `SEND_TZ` **at
  the call, not at import** (so a module needing only the pure helpers still loads without it)
  and throws when unset. No default anywhere. `SEND_TZ` documented in `.env.example`.

  `assertDbTimezone()` compares `SHOW timezone` against `SEND_TZ` exactly and throws naming
  both values. Exact, not fuzzy: the counters filter on `sent_at::date`, and that cast uses the
  **session's** timezone, so anything other than equality lets the day roll over at a different
  instant from the window. Called at the top of `scripts/send.ts`, before the first tick.

  **One extra fix, same root cause, no contract touched.** `isSendingDay(now)` in
  `lib/rules.ts` read `Date.getDay()` — the same ambient clock. Friday 23:00 UTC is Saturday
  morning in IST, so a UTC container sent weekend outreach. It now takes an **optional** `tz`
  (existing one-argument callers, including qa's tests and `calendarDays`, are untouched) and
  `runTick` passes it. Fixing the window's zone while leaving the weekday on the server's clock
  would have been half a fix.

  **Verified:** lint clean · `npm test` 113/113 · `npm run test:acceptance` all pass.

  **Check to encode (qa)** — script at `/tmp/s4.mjs.ts`, same invocation as the S1 one. Every
  assertion fails on the pre-S4 code, because the helpers took no zone at all:
  - UTC/IST split: `2026-06-01T20:00Z` → `minuteOfDay` 1200 in UTC, 90 in `Asia/Kolkata`;
    `localDay` `2026-06-01` vs `2026-06-02`
  - DST: `Europe/London` at `2026-07-01T12:00Z` → 780, at `2026-01-01T12:00Z` → 720; and either
    side of the spring-forward instant, `2026-03-29T00:59Z` → 59, `01:01Z` → 121
  - midnight: `2026-06-01T18:30Z` in `Asia/Kolkata` → 0 (a zero hour, not a missing one)
  - `isSendingDay(2026-06-05T23:00Z, 'UTC')` true, `…, 'Asia/Kolkata')` false
  - `sendTz()` throws when `SEND_TZ` is unset; an unknown zone throws `RangeError`
  - `assertDbTimezone()` rejects when `SEND_TZ` disagrees with `SHOW timezone`, resolves when
    it agrees

  Next: S6, S5, S9.

- **S6, S5, S9 landed. All six findings closed.** Detail and the two things the manager needs
  to decide are below.

  **S6 — closed inside `lib/`, no route edit.** Traced it: `PRESETS[*].mapping` is consumed by
  exactly one caller, `app/api/ingest/[preset]/route.ts`. The UI only reads `PUSH_PRESETS` to
  populate a dropdown of webhook *names* — the hand-uploaded CSV path builds its mapping by
  hand and the Apollo pull uses `APOLLO_MAPPING`. So the trust boundary is the push door and
  nothing else. `PUSH_SOURCE_SUFFIX` (`':webhook'`) is now a documented constant in
  `lib/connectors.ts`, and `runImport` downgrades a **sendable** status (`verified`,
  `catch_all`) to `unverified` when the source ends with it. `invalid` is deliberately kept —
  a caller can only ever remove sendability with it, so there is nothing to gain by lying.
  Reuses the existing `SENDABLE` list rather than restating it.
  *Known ceiling, documented at the constant:* the marker is the `source` string, because the
  route that sets it is outside `core`'s paths in CONTRACTS §1. A future push endpoint that
  forgets the suffix inherits trust it has not earned. **The one-line better fix is an explicit
  argument from the route — say the word and I will take it, or hand it to whoever owns
  `app/**`.** Not a blocker; the finding is closed either way.
  **Check to encode (qa)** — `/tmp/s6.mjs.ts`: a webhook import of `verified`, `catch_all` and
  the alias `valid` all land `unverified`; `bounced` still lands `invalid`; the same rows
  imported as `'sample.csv'` still land `verified`.

  **S5 — structural fix landed; the residual is a deployment decision, not a proxy one.**
  Measured it rather than assuming. `matcher` is evaluated at **build time** and both
  deployments run one build, so an exclusion there can never tell them apart — the decision has
  to be at request time, where `PUBLIC_ONLY` is readable. `_next/static` is now in the matcher
  and handled in `proxy()`.
  What I found when I looked at the build output: Turbopack emits **12 flat, opaque, hashed
  chunks with no route grouping** — there is no prefix separating workspace chunks from public
  ones. The public pages genuinely need 8 of them (confirmed by serving the build with
  `PUBLIC_ONLY=1` and reading the HTML of `/enquire` and `/u/`), so blocking `_next/static`
  outright **breaks unsubscribe**, which is invariant 1. The 4 unreferenced chunks are the
  workspace's client components and they contain `createServerReference(...)` **server-action
  ids** — that is the actual reconnaissance value, and it is worse than "some JavaScript".
  Still not exploitable: `requireAuth()` holds, and the names are unguessable with no index
  (`_buildManifest.js` is empty of app routes).
  **Closing it properly needs two builds instead of one shared one — a deployment change, and
  `ops` territory.** I have marked the exact branch with a `ponytail:` comment; it is one line
  when the split exists. I did not invent a heuristic (referer / `Sec-Fetch-Dest`) because
  anything a `curl` flag defeats reads as a control while being none.

  **S9 — landed, and the §3.2 collision is louder than predicted. Read this one, qa.**
  `unsubscribeHeaders(url)` is in `lib/template.ts`; `assembleBody` now returns
  `{ body, headers }`. The header is attached in `mime()` in `lib/gmail.ts`, built there from
  the recipient — same reasoning as the suppression re-check in that file, so a message
  assembled by hand elsewhere cannot go out without a working opt-out. RFC 8058: exactly one
  HTTPS URI in angle brackets, no mailto beside it, and `List-Unsubscribe-Post` emitted **only**
  for an `https://` link. Verified the `/u/[token]` route already exports `POST` and suppresses,
  so one-click is honoured end to end. `lib/generate.ts` and `scripts/demo.ts` take `.body`.
  ⚠️ **The predicted failure is a type error, not just a failed assertion**, because the return
  shape changed. `npm run build` type-checks test files, so **`npm run build` is red on this
  branch** until qa updates `lib/lib.test.ts:163-167`. `npm run lint` is clean, compilation
  succeeds, and every other check passes — this is exactly the pre-agreed §3.2 collision, and
  PLAN Phase 4/5 verifies on `integration`, not on a lane branch. The three lines qa needs:
  ```ts
  const { body, headers } = assembleBody('Hi Ada,\n\nSomething specific.', 'https://u.example/abc')
  assert.match(body, /would rather I did not write again/)
  assert.ok(body.includes('https://u.example/abc'))
  // The header is a header — it must still never appear in the text a person reads.
  assert.doesNotMatch(body, /List-Unsubscribe/i)
  assert.equal(headers['List-Unsubscribe'], '<https://u.example/abc>')
  assert.equal(headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click')
  ```
  Note the absence assertion **stays**, inverted onto the right object: the finding is that the
  header was missing from the wire, not that it belonged in the body.
  **Check to encode (qa)** — `/tmp/s9.mjs.ts`, which is the above plus: `http://` gets no
  `List-Unsubscribe-Post`, and `unsubscribeHeaders` returns exactly two keys.

- **⚠️ Environment finding that affects all three lanes — `npm run build` cannot work in these
  worktrees as handed over.** `node_modules` was a symlink to the main repo's, and Turbopack
  panics: *"Symlink [project]/node_modules is invalid, it points out of the filesystem root"*.
  Nothing to do with anyone's code. Fixed locally with `rm node_modules && npm ci` (8s, and it
  left `package-lock.json` untouched — `node_modules` is gitignored, so nothing was committed).
  **`qatalyst-ops` and `qatalyst-qa` will hit the same wall**, and so will any CI step that
  builds from a worktree laid out this way.
  Also: **`timeout` is not on macOS**, so `timeout 30 npm run db:seed` in `scripts/verify.sh`
  silently fails to run. Use `gtimeout` or a node watchdog.

- **DONE against the bar.** `timeout 30 npm run db:seed` → exits 0 in 0.4s (via a node
  watchdog; see above) · `npm run lint` → clean · `npm test` → 112 pass, **1 fail, and it is
  the expected `List-Unsubscribe` inversion in qa's file, nothing else** · `npm run build` →
  compiles successfully; type check red **only** on `lib/lib.test.ts:163-167`, same expected
  collision · `npm run test:acceptance` → all 14 checks pass · migration `0017` applied and the
  enum confirmed in order · all frozen signatures exported exactly as contracted.
  Four commits on `core`: `a1c3d9f` S2 · `75098b1` S1 · `c30adcf` S4 · `5eb426e` S6/S5/S9.
  Nothing left in my lane. Two open questions for the manager, both marked above (S6's trust
  marker, S5's residual), neither blocking.
