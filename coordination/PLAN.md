# PLAN.md

Written by the manager. Nobody else edits this file. Approved by the human 2026-08-17.

---

## GOAL

Every finding S1–S8 is closed, each proven by a check that **fails today**, and the ship
gate's code-blocked items are green.

**PROOF** — `bash scripts/verify.sh` → exit 0.

**OUT** — booking/contract/e-sign (belongs to **Quest**, built separately at
quest.qalakaar.com); domain warm-up (three weeks of calendar, no code shortens it); the privacy
notice; wiring `lib/verify.ts` to a button; anything not written here at the Phase 1 gate.

---

## Why

Qatalyst is built through phase 3 and has **never sent a real message**. An audit at `130b236`
ran everything and produced eight findings plus a ship gate of 2 green / 2 amber / 4 red, and
ended: *"Awaiting agreement on the ranking before implementing."* The ranking was never agreed,
so nothing was fixed. That is the blocker this build clears.

Re-verified this session at `8e4da58`: every `file:line` in the report still holds. The four
commits since `f0da4c5` touched only `docs/handoff/HANDOFF.md` and a worktree gitlink — their
messages ("synchronize database schema", "remove unused indexer") are auto-generated and
wrong. **No source file has changed. All eight findings are open.**

---

## The work, in agreed order

`S2` → `S1` → `S4` → `S7`+`S3` → `S6`/`S5`/`S8`/`S9` alongside.

S2 first because it is one line and unblocks the documented setup for everyone. S1 second
because it is the one that must not ship broken.

| | Sev | Lane | One line |
|---|---|---|---|
| S1 | CRITICAL | core | Nothing claims a row before the wire call — a message can be delivered up to three times |
| S2 | HIGH | core | `npm run db:seed` never exits, and it is in the documented setup path |
| S4 | HIGH | core | The sending window follows the server's clock, not the operator's |
| S3 | HIGH | ops | No deployment artifact of any kind; the worker is a shell loop on a laptop |
| S6 | MEDIUM | core | A webhook holding `INGEST_SECRET` can assert `email_status='verified'` |
| S7 | MEDIUM | ops | No backup, no PITR, no restore drill |
| S5 | LOW | core | The public deployment serves the private workspace's bundles |
| S8 | LOW | qa | The acceptance guard rejects valid local databases — and it guards a `TRUNCATE` |
| S9 | — | core | `List-Unsubscribe` — resolved by fetching; recommendation reversed, see below |

Full detail, with `file:line` and the smallest fix for each, is in
`~/Documents/Qalakaar/qatalyst-prompts/qatalyst-shipping-report.md` §3. Read it before
touching anything, then **re-verify the line numbers** — this repo is edited concurrently.

---

## Decisions

- **D1 — No new runtime dependencies.** Every fix is stdlib or SQL. `Intl.DateTimeFormat` is
  built in; the advisory lock is one Postgres call. This codebase draws a 3D envelope in 250
  lines of raw WebGL2 to avoid a scene-graph library. That bar holds.
- **D2 — A post-wire failure is a success, not a failure.** Persist `sent` first, then attempt
  the Message-ID read. A missing Message-ID costs one unmatched reply; a duplicate costs the
  prospect and the domain.
- **D3 — Fail closed, but parse properly.** S8's guard stays fail-closed; it stops rejecting
  valid URLs. A rail that blocks legitimate use is one somebody eventually edits.
- **D4 — A backup is a belief until a restore has been performed and dated.** `ops` delivers
  the scripts *and* the dated evidence.
- **D5 — `verify.sh` must fail the day it is written.** If it passes at t0 it tests nothing.
- **D6 — The `ui` lane is dropped.** This work is backend, ops and test; there is no UI in it.
  The template's own rule is that inventing work for an idle agent is worse than idleness. The
  third lane is `ops`, which has real and fully independent work. *Strategist decision, mine.*
- **D7 — `S9` added to scope after fetching a current citation.** See below.

### D7 · `List-Unsubscribe` — the assumption was wrong

The handoff left this open pending "a current citation, fetched not recalled." Fetched:

- Threshold is **5,000 messages/day to Gmail addresses**, unchanged since Feb 2024. At
  1,000/day total, mostly to hotel corporate domains, Qatalyst is nowhere near it — **the
  omission is defensible today.**
- **But the classification is permanent.** Cross 5,000 once and Gmail treats the domain as a
  bulk sender from that point on; reducing volume does not revert it.
- **Subdomains roll up to the parent**, so every Qalakaar sender counts as one.
- **Enforcement ramped in November 2025** — non-compliant traffic now gets temporary *and
  permanent* rejections.

A few lines in `assembleBody()` now, versus an irreversible classification crossable by
accident. Added to `core`. The `/u/` route and token scheme already exist.

---

## Lanes

| lane | owns | model | why |
|---|---|---|---|
| `core` | `lib/**` (not the test), `db/**`, `proxy.ts`, `.env.example`, most of `scripts/` | Opus | claim/lock semantics and the timezone assertion are where wrong is expensive |
| `qa` | `lib/lib.test.ts`, `scripts/acceptance.ts`, `scripts/verify.sh`, CI | Sonnet | disciplined harness work against explicit criteria |
| `ops` | `Dockerfile`, `deploy/`, backup/restore scripts, runbook | Sonnet | fully independent; no dependency on either other lane |

Exact paths and the three cross-lane agreements are in `CONTRACTS.md`. No file appears twice.

**Why there is no deadlock here:** the acceptance criteria already exist as eight reproducible
defects. There is no interface to invent — `qa` writes tests against the frozen signatures in
`CONTRACTS.md` §2 while `core` implements them, and every one of those tests fails today.

---

## Phases

| | | Gate |
|---|---|---|
| 1 | Plan and freeze | **passed** — human approved 2026-08-17 |
| 2 | Launch three worktrees, all at once | — |
| 3 | Supervise via `status/*.md`, update `BOARD.md` | human checkpoint |
| 4 | Merge to `integration`: `core` (migration) → `qa` → `ops` | — |
| 5 | Fresh verifier — wrote none of this code — runs PROOF | human checkpoint |
| 6 | Ship | — |

Nothing is verified on a lane branch. Verification happens on `integration`, and the exit code
decides — not the verifier's prose, and not the authors' claims.

---

## Human actions — not code, and the first one has a three-week lead time

1. **Start domain warm-up today.** Three weeks, independent of every line of this build, and
   the ship gate's long pole. Starting it late is the only way this build is still blocked
   when the code is done.
2. **Privacy notice** covering the first-party identifier and click tracking. Legitimate
   interest is an argument to write down, not an exemption. It gates the pixel.
3. **Kill-switch runbook**, and show one other person. The `practice` flag and per-domain pause
   both work; nobody else has been shown. Minutes.
4. **SPF/DKIM/DMARC verified by a real message** — after warm-up. `lib/authdns.ts` reads the
   records; no real message has ever been sent.

---

## Log

Appended as the build runs. A1 applies to the manager too — if this window dies, a fresh
manager reads this file and continues.

- **2026-08-17** — Phase 0: fresh start confirmed (no `coordination/`, no lane worktrees, no
  lane branches). Phase 1 planned and approved. Target changed twice during planning: the
  original GOAL block described booking→contract→e-sign, which belongs to Quest; the human
  redirected to Qatalyst's own open work. An `ecc:architect` pass on the booking domain is
  **banked as a spec for Quest**, not built here — it includes three defects found in the
  signed Vivanta agreement template (two clauses both numbered 3.1.11 with contradictory
  restricted periods; 3.2.1 contradicting 5.2 on who provides the sound system; 1.3
  contradicting 7.1.1 on the term).

- **2026-08-17, Phase 4** — All three lanes merged into `integration` with **zero
  conflicts**. That is the return on Phase 1: 20+ files changed across three agents that
  never spoke, and not one file had two owners.

  One thing the contract did not freeze, and it cost a red build: `CONTRACTS.md` §3.2 said
  *core adds the `List-Unsubscribe` headers, qa inverts the test* — the behaviour — but
  never the **return shape**. Core landed `assembleBody → { body, headers }`; qa's test
  destructured `{ text, headers }`. Both lanes were individually correct. Reconciled to
  `body` at integration. **Next round: freeze return shapes, not just behaviour.** A
  contract that names an effect but not a type is only half frozen.

- **2026-08-17, 22:06 — INCIDENT: `verify.sh` truncated the production database.**

  `scripts/verify.sh` opened with an unconditional `set -a; source .env`, which overwrote
  any `DATABASE_URL` the caller passed. So `DATABASE_URL=…/qatalyst_scratch bash
  scripts/verify.sh` silently ran against `.env`'s database — the real one. The S8 guard
  then validated the value that line had just replaced: **a safety rail checking the thing
  it was meant to protect you from.** `test:acceptance` truncates `contacts, suppressions,
  messages, events` and, at `acceptance.ts:134`, also `mailboxes, campaigns`.

  Lost: 4 contacts, 1 suppression, 4 messages, plus all mailboxes and campaigns. No backup
  or PITR predated the loss — S7 landed forty minutes too late to protect the data it was
  written for.

  Two mistakes of mine worth naming, because both are patterns:
  1. **I verified the wrong mechanism.** I empirically confirmed an env override beats
     `--env-file-if-exists` — true, for `node`. `verify.sh` is bash and re-sources `.env`
     itself. I tested the risk I expected instead of the path I was running.
  2. **I reported a false positive as reassurance.** I claimed the suppression list
     survived because its hashes matched `qatalyst_scratch`. They matched because both are
     the *same fixtures from the same script*: `sha256("blocked@example.com")` and
     `sha256("s@example.test")`, written by `acceptance.ts:48,160`. Comparing two outputs
     of one generator is not corroboration. The real suppression is gone.

  **The lesson, and it is the highest-value line in this file.** This defect surfaced in
  the one window where the database held nothing but test rows — the real lead list is
  still in Sales Navigator, Apollo and Notion, not yet imported. The same bug three weeks
  from now, after those imports land, destroys the actual asset. The allowlist fix
  (`433444d`) is what makes that safe, and it is the most valuable commit of the day.

  Fixes, all in `433444d`: an explicit `DATABASE_URL` now wins over `.env`;
  `is_disposable_db()` refuses anything not named as throwaway, so **"is it local" is no
  longer the question** — the production database is local too; `db:migrate` moved before
  `lint/test/build` (a second ordering bug the first was masking); the phantom `FAIL` line
  on a green run. WAL archiving enabled and proven (forced a WAL switch, files land,
  0 archiver failures).

- **Definition of done, narrowed:** code green + merged. Warm-up, the privacy notice and
  the kill-switch walkthrough are human calendar items, tracked but out of this team's
  scope. Remaining path: independent PROOF on `integration`, then merge to `main`.

- **Phase 5 in progress** — A4 says an author cannot grade their own work, and PROOF is
  currently green as run by the session that wrote the fixes. A peer session that wrote
  none of this code is running `verify.sh` independently against a fresh empty
  `qatalyst_verify`, and adversarially testing the allowlist by pointing it at the
  production name to confirm it refuses.
