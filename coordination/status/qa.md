# qa — status

## 2026-08-17 — checkpoint: verify.sh, S8 fix, S1/S4/S6/S9 checks committed

**Landed** (commit `17f2221` on branch `qa`, worktree `qatalyst-qa`):

- `scripts/verify.sh` — new. Implements CONTRACTS §4's seven steps in order:
  DATABASE_URL host guard (hard gate, aborts the whole script — steps 3/4
  truncate tables) → `lint && test && build` → `db:migrate && test:acceptance`
  → `timeout 30 db:seed` (S2) → `node --test --test-name-pattern '^S[0-9]+:'`
  against the new regression checks (S1/S4/S6/S9) → `docker build .` (S3,
  ops) → `bash scripts/restore.sh --dry-run` (S7, ops). Runs every step to
  completion and prints a PASS/FAIL summary; does not abort on a failing step
  (only the DB-host gate aborts, deliberately). Failure lines for steps 6/7
  are labelled with the owning lane so a red run is diagnostic, not mysterious.
- `scripts/acceptance.ts` — S8 fixed. `isLocalDatabaseUrl()` parses the URL
  via `new URL()` and checks `hostname`, replacing the regex that required an
  `@` and so rejected `postgresql://localhost:5432/db` (Homebrew default, no
  username). Still fails closed on anything that does not parse. The same
  logic (kept in sync by hand, it's 3 lines) runs in `verify.sh` step 1.
- `lib/lib.test.ts` — added a new section (end of file) with DB-touching
  regression checks for S1 (×3) and S6, plus tz-aware checks for S4 (×2),
  all against the frozen signatures in CONTRACTS §2. Each test guards itself
  with `skipWithoutDb()` so the suite degrades to a clean skip rather than a
  crash when `DATABASE_URL` is unset — verified: with `DATABASE_URL` unset,
  all 112 pre-existing pure tests still pass and the 6 new DB tests skip
  cleanly (only S9, which is pure, ran and correctly failed). Inverted the
  existing List-Unsubscribe-absence test for S9 (PLAN.md D7) to assert
  presence with RFC 8058 semantics.

**Assumptions flagged for reconciliation at merge** (neither is a frozen
signature in CONTRACTS §2, so these are best-guesses, not guarantees):

- **S9** — my inverted test assumes `assembleBody()`'s return type changes
  from `string` to `{ text: string; headers: Record<string,string> }`, since
  RFC 8058 `List-Unsubscribe`/`List-Unsubscribe-Post` are real MIME headers
  and cannot live inside the plain-text body a person reads. If core's actual
  fix keeps `assembleBody()` returning a plain string and adds the headers
  elsewhere (e.g. directly in `lib/gmail.ts`'s `mime()`), this test will need
  its assertions moved to match — the *invariant* (presence, one HTTPS link,
  one-click form) is right either way, only the plumbing is guessed.
- **S6** — no frozen signature exists for this finding at all. I tested it
  against `runImport(mapping, rows, source)` in `lib/contacts.ts`, on the
  theory that the `source` string already ending in `:webhook`
  (`app/api/ingest/[preset]/route.ts` passes `` `${preset}:webhook` `` today)
  is the natural, already-existing signal to downgrade a caller-asserted
  `email_status` for untrusted posts, while leaving `mapRow()`/`PRESETS`
  themselves untouched — the existing test "a row in each exporter's own
  column names survives mapping" already relies on `PRESETS.evaboot` +
  `mapRow` trusting `email_status` for a person's own trusted CSV upload, so
  the fix cannot live there. If core instead fixes this only inside the route
  handler (e.g. stripping `email_status` from a cloned mapping before calling
  `runImport`), my test — which calls `runImport` directly — will never see
  that fix and will need retargeting. Route handlers under `app/` can't
  actually be imported into `lib/lib.test.ts` for a real test either: they
  use the `@/*` TS path alias, which only Next's bundler resolves, not
  Node's native loader that `node --test` uses — confirmed by trying it.

**Also confirmed** (CONTRACTS §3.1, the truncate-list cross-lane item):
migration `0017` per CONTRACTS §2 only adds the `sending` value to the
existing `message_status` enum — no new table. `messages` is already in both
of `scripts/acceptance.ts`'s truncate statements (lines 28 and 115 as of this
commit), so a `sending`-status row can never leak between acceptance runs.
No truncate-list change needed. Will re-confirm by reading the actual
migration file once `core` merges, but there's nothing CONTRACTS describes
that would change this answer.

**Deliberate CI changes beyond the literal "add verify" instruction** (about
to land, see below): reordering `db:migrate` before `test` in
`.github/workflows/ci.yml`. Reason: `lib/lib.test.ts` now imports
`../db/index.ts` (via `lib/send.ts`/`lib/contacts.ts`) for the new S1/S4/S6
checks, so `npm test` needs the schema to exist. CI currently runs `test`
before `db:migrate`, which would make these checks fail in CI *forever* (not
just today) with "relation does not exist" rather than a real assertion,
even after core lands the fix. This is squarely within `qa`'s ownership of
`ci.yml` and is necessary for the tests I was asked to write to ever go
green in CI. Flagging in case this reordering has a consequence for another
lane I'm not seeing.

## Blocker encountered mid-task, now resolved

`node --test lib/lib.test.ts` with `DATABASE_URL` set hung indefinitely
instead of exiting (background task, still running as of this checkpoint) —
almost certainly the same class of bug as S2: `db/index.ts`'s postgres pool
(`postgres(..., { max: 5 })`, cached on `globalThis`) is never closed, so
`node --test`'s event loop never drains once any test imports it. Next
action: add a top-level `after(async () => { if (hasDb) await
send!... /* close via the pool */ })` hook (node:test's own `after`, no new
dependency) to `lib/lib.test.ts` so the suite closes its own connection
regardless of how the ambient `npm test` invocation is run. Will verify with
a timed run before calling this done.

## Situational awareness from manager

`core` has landed S2/S1/S4 (`claimForSend`, `minuteOfDay(now,tz)`,
`localDay(now,tz)`, `assertDbTimezone()`) on its own branch — not yet visible
in this worktree, so `verify.sh` step 5 correctly still shows red here.
`ops` has landed S3/S7 (`Dockerfile`, `scripts/backup.sh`,
`scripts/restore.sh`) on its own branch, also not yet visible here, so steps
6/7 correctly still show red with `[owned by ops]`. Per the manager: ops
could not run `docker build .` in its own environment (no docker binary
there), so `verify.sh`'s step 6 will be the first real exercise of that
image once branches merge — kept the step as a real `docker build .`, not a
stub, so that first exercise is honest.

## 2026-08-17 — checkpoint: all four remaining items done, verify.sh run end to end

**Landed since the last entry** (commits `004102e`, `2b5b95a`, `48a19f7`):

1. Fixed the `node --test` hang: added a `test.after()` hook in
   `lib/lib.test.ts` that closes `db/index.ts`'s cached postgres pool via
   `sql.end()` when `DATABASE_URL` is set — same root cause as S2, same fix
   shape. Verified: `node --test lib/lib.test.ts` with `DATABASE_URL` set now
   exits cleanly (119 tests, 112 pass, 7 fail — the S1×3/S4×2/S6/S9 checks,
   all failing for the expected reason, see below), and the filtered
   `--test-name-pattern '^S[0-9]+:'` run used by `verify.sh` step 5 also
   exits cleanly (7/7 fail).
2. `.github/workflows/ci.yml`: added `npm run verify` after `test:acceptance`
   (CONTRACTS §3.3), reordered `db:migrate` before `test`, added `SEND_TZ:
   Asia/Kolkata` to the job env — all reasoned through in the previous entry.
3. Found and fixed a real bug in `verify.sh` itself while dogfooding it: GNU
   `timeout` is not installed on this machine (macOS, no coreutils), so step
   4 was reporting "timeout: command not found" instead of actually running
   `db:seed` and waiting — which would have kept reporting FAIL forever, for
   the wrong reason, even after core's S2 fix lands. Replaced with a small
   portable `run_with_timeout()` bash function (background + `kill -0` poll +
   `kill -9` on deadline), needing nothing beyond bash. Smoke-tested in
   isolation (fast success, fast failure, actual timeout all correct), then
   re-verified in the real script: the step now genuinely runs `db:seed`
   (it seeds data, "seeded, mailboxes attached to their domains") and then
   correctly times out at 30s on the real, still-open bug.
4. Ran `bash scripts/verify.sh` end to end in this worktree. Full output
   confirms it runs to completion with no crash in the harness itself, and
   every step's failure is diagnostic (labelled with the owning lane, or
   showing the real underlying error) rather than mysterious.

**Result — `verify: 3 passed, 5 failed`, exit 1 (correct: today must be red):**

| Step | Result | Why |
|---|---|---|
| S8 guard accepts `postgresql://localhost:5432/db` | PASS | fixed, see above |
| S8 guard still refuses a non-local host | PASS | fail-closed preserved |
| `db:migrate, test:acceptance` | PASS | no regression from the S8 fix |
| `lint, test, build` | **FAIL** | `npm test` now also runs the new S1/S4/S6/S9 checks in `lib/lib.test.ts` (same glob, same file) — they fail today by design, so this combined step goes red too, not just step 5. `npm run build` never got a chance to run (short-circuited by `&&`) — not independently verified broken; grep the log for a `build` section header and there isn't one after `test` fails. This is an unavoidable consequence of "one test file" — flagged, not a surprise. |
| S2: `db:seed` exits within 30s | **FAIL — owned by core** | genuinely still hangs in this worktree (core's fix not merged here yet) |
| S1/S4/S6/S9 regression checks | **FAIL — owned by core** | `claimForSend`/`minuteOfDay(now,tz)`/`localDay(now,tz)` not exported yet in this worktree; `sending` not yet a valid `message_status` value; S6/S9 fixes not landed here either |
| S3: `docker build .` | **FAIL — owned by ops** | no `Dockerfile` in this worktree yet. Also: this sandbox has no `docker` binary at all ("docker: command not found") — that part is an environment fact, not a code defect; GitHub Actions' `ubuntu-latest` runners ship Docker preinstalled, so `npm run verify` in CI will do a real build once ops's Dockerfile merges. Kept as a real `docker build .`, not a stub, per the manager's note that this will be the first real exercise of that image. |
| S7: `scripts/restore.sh --dry-run` | **FAIL — owned by ops** | file doesn't exist in this worktree yet |

Nothing here is a surprise — this is exactly PLAN.md D5 ("verify.sh must fail
the day it is written") plus the manager's situational-awareness note that
core/ops have landed on their own branches, not this one.

Note on PLAN.md Phase 4's merge order (`core` → `qa` → `ops`): this harness's
own steps 6/7 depend on `ops`'s files, which under that order won't exist yet
when `qa` merges. That's fine — `verify.sh` will still correctly report those
two as red with `[owned by ops]` rather than crashing, so the stated order is
safe for this harness specifically. Flagging only so a red run right after
the `qa` merge, before `ops` merges, isn't mistaken for a new problem.

## Assumption risk, restated plainly for the merge step

The two biggest reconciliation risks remain S9 (assumed `assembleBody()`
returns `{ text, headers }`) and S6 (tested via `runImport`'s existing
`:webhook`-suffixed `source` string, since no frozen signature exists for
this finding and the actual route handler can't be imported into
`lib/lib.test.ts` — confirmed by trying: it uses the `@/*` alias, which only
Next's bundler resolves, not the native loader `node --test` uses). Both are
detailed above. Whoever runs the Phase 5 fresh-verifier pass should expect to
possibly adjust these two tests' plumbing (not their asserted invariants) if
core's actual implementation shape differs from my best guess.

## Next

Nothing further to do from this worktree until `core` and `ops` merge.
`scripts/verify.sh` exists, is executable, encodes every criterion in
CONTRACTS §4, and runs to completion with a clear pass/fail per criterion and
no crash in the harness — DONE, per the qa lane's own definition of done.
Will re-run `bash scripts/verify.sh` after Phase 4 merge lands in this
worktree (or `integration`) to confirm it goes green, and reconcile the S6/S9
assumption risk above against whatever core actually shipped.
