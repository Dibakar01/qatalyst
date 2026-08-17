# Qatalyst — session handoffs

---

## Handoff: 2026-08-16 (session: qatalyst-initiation_session)

### Current Task State

**Awaiting a decision, not mid-implementation.** The session ended having delivered a shipping
report and explicitly stopped, as its governing prompt required: *"Fix nothing before the ranking is
agreed."* No repository source file was modified by this session.

The arc was four pieces of work, each completed:

1. **Decided the integration question** — should Qatalyst expose an HTTP API or an MCP server for
   "Meta Pixel for outbound email"? Answer: HTTP for the pixel (a `<script>` tag cannot speak MCP),
   MCP later as a control plane.
2. **Reverse-engineered Meta Pixel + Conversions API from first principles** into an executable
   brief. **That brief has since been implemented** by a parallel session.
3. **Audited the repository** — security, correctness/gaps, UI/UX — producing three independently
   executable prompts.
4. **Executed a user-authored shipping prompt** (`qatalyst-shipping-prompt.md`) end to end: ran
   everything, built an invariant ledger, produced eight ranked findings (S1–S8), an infrastructure
   plan and a ship gate.

### Key Decisions

- **Pixel over HTTP, not MCP** — MCP is JSON-RPC for LLM clients; there is no MCP client in a
  visitor's browser. MCP remains worthwhile later as a control plane over the pure functions already
  in `lib/`, but is worth nothing until attribution works.
- **Qatalyst needs 4 of Meta's 7 pixel subsystems** — the three dropped (anonymous device id, PII
  hashing/advanced matching/EMQ, view-through attribution) exist only because Meta *cannot* know who
  the user is. Qatalyst mailed them by name; it can. This inversion is the core of the pixel brief.
- **"The token names the campaign, the address names the person"** — the attribution precedence rule
  that makes the email-forward case correct. Implemented as a pure function in `lib/attribute.ts`.
- **Findings ranked by which product promise breaks, not by CVSS** — a generic severity score puts a
  missing cookie flag near a forgeable write endpoint. The three promises: the contact list is never
  on the internet; we never burn a domain or ignore an opt-out; the reports are true.
- **A defect that sends *more* mail than intended outranks one that sends less** — the asymmetry
  ordering the correctness work. Sending too little costs a day; too much costs a domain and the
  three weeks needed to replace it.
- **No animation library** for the UI work — a critically-damped spring is ~15 lines beside the
  existing `ease()`; this project draws a 3D envelope in 250 lines of raw WebGL2 precisely to avoid
  that dependency.
- **Prompt exports live outside the repo** at `~/Documents/Qalakaar/qatalyst-prompts/` — keeps
  `git status` clean on a tree other sessions are actively editing.

### Modified Files

**No source files were changed.** Everything produced lives outside the repository:

- `~/Documents/Qalakaar/qatalyst-prompts/qatalyst-pixel-prompt.md` — Meta-Pixel brief (now implemented)
- `~/Documents/Qalakaar/qatalyst-prompts/qatalyst-security-prompt.md` — 15 security findings
- `~/Documents/Qalakaar/qatalyst-prompts/qatalyst-correctness-prompt.md` — gaps + pixel completion
- `~/Documents/Qalakaar/qatalyst-prompts/qatalyst-uiux-prompt.md` — 11 findings vs `apple-design`
- `~/Documents/Qalakaar/qatalyst-prompts/qatalyst-shipping-report.md` — **the live deliverable; read first**
- `~/Documents/Qalakaar/qatalyst-prompts/qatalyst-shipping-prompt.md` — user-authored, drove item 4
- `docs/handoff/HANDOFF.md` — this file, the only in-repo write, on branch `worktree-handoff-doc`

Artifacts (private, on claude.ai):
- **The Qatalyst Pixel** — `https://claude.ai/code/artifact/57467b4a-4581-4ef0-988c-4150307414ce`
- **The Qatalyst Audit** — `https://claude.ai/code/artifact/74a8a88c-cff2-40eb-962a-1b3e936cb29f`

### Blockers / Open Questions

1. **The finding ranking has not been agreed.** The shipping report ends awaiting it. Nothing should
   be implemented until it is.
2. **`List-Unsubscribe` is deliberately unanswered.** The README omits it on purpose. Bulk-sender
   requirements turn on volume to Gmail (commonly cited at 5,000/day, which 1,000/day does not
   reach), so the omission is *probably* still fine — but that threshold has been tightened before,
   so this needs a **current citation, fetched not recalled**. Ship-gate blocker.
3. **`gh` CLI is not installed/authenticated.** Read-only git against
   `github.com/Dibakar01/qatalyst` works via cached HTTPS credentials; issues and PRs need
   `gh auth login` first.
4. **Two questions deferred to the executing session** in the correctness prompt: should
   `nudge`/`revive` templates carry `{{link}}` (today no template has it, so every click metric is
   structurally zero), and wire-or-delete `lib/verify.ts`.

### Next Steps

1. **Agree the ranking in `qatalyst-shipping-report.md`**, then implement:
   **S2** (one line) → **S1** (must not ship broken) → **S4** → **S7+S3**.
2. **S2 · `npm run db:seed` never exits.** `scripts/seed.ts:8` opens a private pool and closes it at
   `:37`, but `:34` imports `lib/domains.ts`, which opens the shared `db/index.ts` pool that is
   never closed. Fix: import `db`/`sql` from `../db/index.ts` like every sibling script. One line
   net. It sits in the documented setup path.
3. **S1 · No row is claimed before the wire call.** `lib/send.ts:340` calls `deliver()`, `:348`
   writes `status:'sent'`, nothing sits between. Three live failure paths: a crash between the two
   lines; two processes (there is **no lock of any kind in the repo**); and a Gmail metadata throw
   *after* delivery (`lib/gmail.ts:148,153`) landing in the catch at `lib/send.ts:373`, which leaves
   the row `approved` for up to three retries. Fix: claim in one statement
   (`UPDATE … SET status='sending' WHERE id=? AND status='approved' RETURNING`), treat post-wire
   failures as sent-with-unknown-header, and add `pg_try_advisory_lock` per tick.
4. **S4 · The window follows the server's clock.** `lib/send.ts:32` `minuteOfDay` uses
   `Date.getHours()`; `:36` `localDay` states "assumes app and database share a timezone" without
   enforcing it. A UTC container + IST operator fires 09:00–17:00 as 14:30–22:30 IST. Fix: one
   `SEND_TZ`, compute both via `Intl.DateTimeFormat`, assert DB agreement at boot.
5. **Start domain warm-up immediately**, independent of all code work — three weeks of lead time
   cannot be compressed, and it is the ship gate's long pole.
6. **Backup + restore drill, and a supervised worker** (S7, S3). There is no `Dockerfile`,
   `Procfile` or systemd unit anywhere in the repo today.

### Critical Context

**Gotchas that cost real time — do not rediscover them:**

- **`npm run test:acceptance` TRUNCATES TABLES.** Always point it at a scratch database. A scratch
  DB `qatalyst_scratch` already exists and is safe to reuse or `dropdb`. The real `qatalyst` DB was
  verified untouched (4 contacts, 1 suppression).
- **An environment override DOES beat `--env-file-if-exists`** in Node — verified empirically, so
  `DATABASE_URL=… npm run test:acceptance` is safe. Re-verify before trusting it again.
- **The acceptance guard rejects valid local URLs** (S8). `scripts/acceptance.ts:17` is
  `/@(localhost|127\.0\.0\.1)[:/]/` — it requires an `@`, so `postgresql://localhost:5432/db` is
  refused. Use `postgresql://$(whoami)@localhost:5432/qatalyst_scratch`.
- **`npm run send` is an infinite 60s loop.** Background it; SIGINT takes up to 60s because
  `scripts/send.ts:89` sleeps before re-checking `stopping`.
- **`no credentials` in sender output comes from the inbox reader** (`lib/inbox.ts:115`), not the
  sender. With no Google key that is correct behaviour, not a window violation.

**The repository is edited concurrently by other sessions.** During this session the working tree
went clean → dirty → committed underneath the audit, and HEAD moved `f8abb92` → `130b236` →
`f0da4c5` while work was in progress.

**Findings anchoring — important:**
- The three prompts (security/correctness/UI-UX) are anchored to **`f8abb92`**.
- The shipping report is anchored to **`130b236`**.
- HEAD is now **`f0da4c5`**. The five commits since `130b236` touched only UI files,
  `lib/compose.ts` and tests — **not** `send.ts`, `gmail.ts`, `seed.ts`, `acceptance.ts` or
  `proxy.ts`. **Every shipping-report finding S1–S8 therefore remains open.** Several UI/UX findings
  appear already addressed (`6e5c1f3` "stop the letter's overlays jumping", `29628bd` "let the
  ledger's safety net show itself"). **Re-verify every `file:line` before acting on it.**

**Already fixed and verified — do not re-report:** warm-up now counts against mailbox and domain
caps (`1e68266`, with a regression test); `/api/collect` gained a `SITE_KEYS` write key, a 4 KB body
cap, and a `trusted` flag so only authenticated callers can `advance()` a contact (`06610f9`);
unsubscribe-by-machine and the `/enquire` contact leak (`130b236`).

**Verified clean — do not churn here:** SQL injection, XSS, secrets (`.env` never committed),
suppression bypass (`isSuppressed` sits inside `deliver()`, the only function that talks to Gmail),
HMAC comparison, outbound SSRF, and `UNSUBSCRIBE_SECRET` failing closed.

**Two stale claims corrected:** the README says "46 pure-function checks" (actual **109** at
`130b236`, **113** at `f0da4c5`). The shipping prompt's §2 claims `build` and `test:acceptance` are
absent from CI — **false**; `.github/workflows/ci.yml:38-44` runs all five steps.

### Model Summary

- Session produced strategy, briefs and an audit for Qatalyst; **zero source files changed**.
- Decided pixel = HTTP, MCP = later control plane; the pixel brief was written, then implemented by
  a parallel session.
- Meta Pixel decomposed to 7 subsystems; Qatalyst needs 4 — the 3 dropped exist only because Meta
  cannot know the user's identity, and Qatalyst can.
- Full repo audit produced three executable prompts (security 15, correctness ~12, UI/UX 11).
- Executed a user-authored shipping prompt: ran everything, built a 14-row invariant ledger, ranked
  8 findings S1–S8.
- **S1 is critical**: nothing claims a message row before the Gmail wire call, so a crash, a second
  process, or a post-send metadata error each cause duplicate delivery.
- **S2**: `npm run db:seed` hangs forever on a second, unclosed connection pool.
- **S4**: the sending window follows the server's timezone, not the operator's.
- No backups, no restore drill, and no deployment artifact of any kind exist (S7, S3).
- Ship gate: 2 green, 2 amber, 4 red; warm-up is the long pole at three weeks.
- Blocked on the user agreeing the ranking; `List-Unsubscribe` deliberately left unanswered pending
  a current citation.
- The repo is edited concurrently — re-verify every `file:line` before acting.

### Handoff Context (paste into next session)

```
Read ~/Documents/Qalakaar/qatalyst-prompts/qatalyst-shipping-report.md first — it is the live
deliverable and it ends awaiting a ranking decision. Do not implement before that is agreed.

Repo: ~/Documents/Qalakaar/Qalakaar Qatalyst  (github.com/Dibakar01/qatalyst, branch main)
The report is anchored to 130b236; HEAD has moved to f0da4c5. Re-verify every file:line first —
other sessions edit this repo concurrently.

Ground truth (re-run to confirm):
  npm run lint && npm test && npm run build          # expect clean, 113 pass
  createdb qatalyst_scratch
  DATABASE_URL="postgresql://$(whoami)@localhost:5432/qatalyst_scratch" npm run db:migrate
  DATABASE_URL="postgresql://$(whoami)@localhost:5432/qatalyst_scratch" npm run test:acceptance

HARD CONSTRAINTS:
- test:acceptance TRUNCATES TABLES. Never point it at the real `qatalyst` database.
- The acceptance guard needs an `@` in the URL, hence $(whoami) above.
- Do not send test mail to any address you do not control.
- No new runtime dependencies; prefer the best open-source option over any rented service.

Recommended order once ranked: S2 (seed hangs, one line) -> S1 (claim the row before the wire —
the one that must not ship broken) -> S4 (SEND_TZ) -> S7/S3 (backup drill + supervised worker).

Still open and needing the user, not a guess: whether List-Unsubscribe is required at 1,000/day
(needs a fetched current citation), and whether nudge/revive templates should carry {{link}}.
```

---

## Handoff: 2026-08-17 ~23:00 (session: qatalyst-multiagent-setup)

### Current Task State

**Engineering complete and independently verified. Blocked only on two human actions.**

A three-lane parallel agent build closed all nine shipping findings (S1–S9). Everything is
merged to `integration` (`1262543`, tree clean, pushed to GitHub). PROOF —
`bash scripts/verify.sh` — is **green twice**: once by me, once independently by a peer
session that wrote none of the code, on a database created empty. A4 is satisfied.

`origin/main` is still `8e4da58`. Nothing has been merged to `main`.

### Key Decisions

- **Target changed twice during planning.** The GOAL block in `TEAM-LAUNCH.md` described
  booking → contract → e-sign, which does not exist in this repo (grep for
  `booking|e-sign|escrow` returns only the word "de**sign**"). That product is **Quest**,
  built separately at quest.qalakaar.com. The human redirected this team to Qatalyst's own
  open work: the nine findings from the 2026-08-15 audit, which had sat unfixed because the
  report ended "awaiting agreement on the ranking".
- **Dropped the template's `ui` lane; used `core` / `qa` / `ops`.** S1–S9 is backend, ops and
  test work with no UI in it, and inventing work for an idle agent is worse than idleness.
- **The ui↔core seam here is server actions, not HTTP.** `app/api/**` serves external callers
  only (pixel, ingest, export). The internal seam is `app/(workspace)/actions.ts`
  (`'use server'`, 30 exports, imported by `page.tsx:66`). Boundary rule that worked:
  **`app/**/*.tsx` → ui, `app/**/*.ts` → core.**
- **One scratch database per lane** (`qatalyst_core|qa|ops`), because `.env` points at the
  real database and `test:acceptance` truncates.
- **D2 — a post-wire failure counts as sent.** A missing Message-ID costs one unmatched
  reply; a duplicate costs the prospect and the domain.
- **S9 added mid-build after fetching a current citation.** `List-Unsubscribe` was
  deliberately omitted; defensible at 1,000/day (threshold is 5,000/day to Gmail) **but
  bulk-sender classification is permanent once crossed**, subdomains roll up to the parent,
  and enforcement ramped Nov 2025. Added rather than carried.
- **PR route over direct merge.** CI triggers on `push: [main]` and `pull_request` only, so
  pushing `integration` runs nothing. A PR is the first and only thing that will exercise a
  real `docker build` before `main` carries the code.

### Modified Files

Seventeen commits, `8e4da58..1262543`. The ones that matter:

- `lib/send.ts` — S1: `claimForSend()` claims in one statement predicated on
  `status='approved'`; `deliver()` is the wire alone; Message-ID read-back moved *after*
  `sent` persists; `pg_try_advisory_lock` per tick. S4: `minuteOfDay(now, tz)` /
  `localDay(now, tz)` now pure, `assertDbTimezone()` boot guard.
- `db/schema.ts` + `db/migrations/0017_nasty_talon.sql` — `messages.status` gains `sending`.
- `lib/template.ts` — S9: `assembleBody()` returns **`{ body, headers }`** (was a string);
  `unsubscribeHeaders()` builds RFC 8058 one-click headers.
- `lib/csv.ts`, `lib/connectors.ts` — S6: the webhook path cannot assert `email_status`.
- `proxy.ts` — S5: static-bundle exclusion moved into `proxy()`; the matcher cannot scope by
  deployment (build-time, one shared build).
- `scripts/seed.ts` — S2: uses the shared `db/index.ts` pool, so `db:seed` exits.
- `scripts/verify.sh` — **new**, then heavily repaired; see Critical Context.
- `scripts/acceptance.ts` — S8: `isLocalDatabaseUrl()` parses the URL instead of a regex
  requiring `@`.
- `lib/lib.test.ts` — S1×3, S4×2, S6 regression checks; S9 absence-test inverted.
- `Dockerfile`, `docker-compose.yml`, `deploy/qatalyst.service`, `scripts/backup.sh`,
  `scripts/restore.sh`, `docs/runbook.md` — **new**, S3/S7.
- `.github/workflows/ci.yml` — adds `npm run verify`; DB moved to `qatalyst_ci`.
- `coordination/{PLAN,CONTRACTS,BOARD}.md` + `status/*.md` — the coordination record.

### Blockers / Open Questions

1. **`gh auth login` — only the human can run it.** `gh auth status`: not logged in. Blocks
   the PR.
2. **`docker build .` is unverified everywhere.** No docker binary on this machine; CI has
   never run on any of this. `verify.sh` reports it as `????` (unverifiable), *not* a pass —
   a green exit deliberately does not cover it.
3. **An unattended process commits AND pushes on a ~40-minute timer.** High confidence:
   **Antigravity IDE** (25 processes running). Evidence: no git hooks (`.git/hooks` is
   samples only, `core.hooksPath` unset); the remote reflog shows exactly two pushes
   (22:12:19 creating the branch at `6d14785`, 22:54:12 at `1262543`); neither this session
   nor the peer ever ran `git push`. It authored `6d14785` and `bb4d329`, and once captured
   `scripts/verify.sh` **mid-edit** then committed a "fix syntax error" on top of its own bad
   snapshot. **Disable before the PR exists** — it can push onto a PR branch after review, so
   the reviewed diff and the merged diff stop being the same thing. Test: quit Antigravity,
   commit locally, wait past the interval, check for a third `update by push` in
   `.git/logs/refs/remotes/origin/integration`.

### Next Steps

1. Human runs `gh auth login`; quit Antigravity IDE first.
2. Open a PR `integration` → `main`. Confirm CI runs `npm run verify` on ubuntu and that
   `docker build .` passes there — the last unverified claim.
3. Merge on green. Final `PLAN.md` entry: what shipped, what was cut, what to freeze earlier.
4. **Start domain warm-up** — three weeks of calendar, the ship gate's long pole, and nothing
   in the code shortens it.
5. Privacy notice (gates the pixel) and the kill-switch walkthrough — human items, tracked in
   `PLAN.md`, out of this team's scope.
6. Optional: hand the banked `ecc:architect` booking spec to Quest. It found **three defects
   in the signed Vivanta agreement** — two clauses both numbered 3.1.11 with contradictory
   restricted periods (24 months vs 3 years, penalty in only one), 3.2.1 contradicting 5.2 on
   who provides the sound system, and 1.3 contradicting 7.1.1 on the term.

### Critical Context

**THE INCIDENT — read before running anything.** At ~22:06 `scripts/verify.sh` truncated the
real `qatalyst` database. Cause: an unconditional `set -a; source .env` at the top, which
**overwrote a `DATABASE_URL` passed on the command line**. The S8 guard then validated the
value that line had just replaced — a rail checking the thing it was meant to protect you
from. `test:acceptance` truncates `contacts, suppressions, messages, events` and, at
`acceptance.ts:134`, **also `mailboxes, campaigns`**. Lost: 4 contacts, 1 suppression,
4 messages, all mailboxes and campaigns. No backup or PITR predated it. **Closed as
immaterial** — the human confirmed the real lead list was never imported (it lives in Sales
Navigator, Apollo, Notion) and he has never manually suppressed a real address.

Two of my own errors worth not repeating:
- **I verified the wrong mechanism.** I proved an env override beats `--env-file-if-exists` —
  true for `node`. `verify.sh` is bash and re-sources `.env` itself. I tested the risk I
  expected, not the path I was running.
- **I reported a false positive as reassurance.** I claimed the suppression list survived
  because its hashes matched `qatalyst_scratch`. They matched because both are the *same
  fixtures from the same script* — `sha256("blocked@example.com")` and
  `sha256("s@example.test")`, written by `acceptance.ts:48,160`. Comparing two outputs of one
  generator is not corroboration.

**Now fixed (`433444d`, `1262543`):** an explicit `DATABASE_URL` wins over `.env`;
`is_disposable_db()` refuses anything not named throwaway — **"is it local" was never the
question, production is local too**; `db:migrate` runs before `lint/test/build` (a second
ordering bug the first was masking); `postgres` removed from the allowlist (it was there only
because CI used it — CI now makes `qatalyst_ci`). WAL archiving enabled and *proven* (forced a
switch, files land, 0 archiver failures).

**Gotchas that cost real time:**
- `is_disposable_db()` carries **no locality guarantee** — `…/evil.example/qatalyst_ci` passes
  it and is caught by the `is_local_db` block after. **The order of those two blocks is
  load-bearing.**
- **GNU `timeout` does not exist on macOS.** `verify.sh` has a bash-native
  `run_with_timeout()`. Do not reintroduce `timeout`.
- **`SEND_TZ` is required with no default** (S4). Runs abort without it.
- **Symlinking `node_modules` into worktrees breaks Turbopack** (`Symlink … is invalid`). I
  did this to avoid three `npm ci`; it cost `ops` its docker verification. Use real `npm ci`
  per worktree (~8s).
- **`GOOGLE_SERVICE_ACCOUNT_JSON` has never been set.** Sending is a dry run that records what
  it would have sent and never contacts Google. That is what makes the send path safe to test.
  Do not configure it casually.
- The contract froze `assembleBody`'s **behaviour but not its return shape**, so core landed
  `{ body, headers }` and qa's test destructured `{ text, headers }`. Both correct alone.
  **Next round: freeze types, not just effects.**

### Model Summary

- Nine findings (S1–S9) closed by three parallel agents in separate worktrees; merged to
  `integration` with **zero conflicts** — the return on freezing file boundaries in Phase 1.
- **S1 was the critical one**: nothing claimed a message row before the Gmail call, so a
  crash, a second process, or a post-send metadata error each re-sent the same cold email.
- PROOF green twice, second time by an independent session on an empty database. A4 met.
- That reviewer found **two real holes in my allowlist** (`postgres` allowed; the database I
  told it to use not allowed) — both fixed in `1262543`.
- **I truncated the production database** with the harness meant to protect it; cause, fixes
  and the two reasoning errors are recorded in `PLAN.md` and above. Closed as immaterial.
- The highest-value change of the day is the **disposable-database allowlist**: this defect
  surfaced in the one week the database held only test rows; the same bug after the Sales
  Navigator/Apollo imports land destroys the real asset.
- `docker build .` remains unverified everywhere; a PR is the only thing that will exercise it
  before `main`.
- An **IDE auto-commit/auto-push on a ~40-minute timer** is committing to `integration`;
  disable before opening the PR.
- Booking/contract/e-sign belongs to **Quest**, not here. Architect spec banked, including
  three defects in a signed client agreement.
- Definition of done narrowed to **code green + merged**; warm-up, privacy notice and
  kill-switch walkthrough are human calendar items.

### Handoff Context (paste into next session)

```
Repo: ~/Documents/Qalakaar/Qalakaar Qatalyst, branch `integration` at 1262543, clean,
pushed. origin/main is still 8e4da58 — nothing merged to main yet.

Read first:
  coordination/PLAN.md        strategy, 7 decisions, the incident record
  coordination/CONTRACTS.md   file ownership + frozen signatures
  docs/runbook.md             deploy, backup, restore, kill switch

State: all nine findings closed, PROOF green twice (once independently). Only
`docker build .` is unverified — no docker here and CI has never run.

TO FINISH (needs the human):
  1. quit Antigravity IDE  (it auto-commits AND auto-pushes on a ~40min timer)
  2. gh auth login
  3. push + open PR integration -> main; CI's `pull_request` trigger runs
     `npm run verify` on ubuntu with a real docker binary. Merge on green.

HARD CONSTRAINTS:
- NEVER point verify.sh or test:acceptance at `qatalyst`. They TRUNCATE. The
  allowlist now refuses it, but do not test that theory on the real database.
  Use: DATABASE_URL="postgresql://$(whoami)@localhost:5432/qatalyst_scratch"
- SEND_TZ is required, no default. Runs abort without it.
- No GNU `timeout` on macOS — verify.sh has its own run_with_timeout().
- Do not set GOOGLE_SERVICE_ACCOUNT_JSON. Sending is a dry run; that is the
  safety property. Never send to an address you do not control.
- No new runtime dependencies (D1).
- Do not symlink node_modules into worktrees — it breaks Turbopack.

Still open and needing the human, not a guess: start domain warm-up (3 weeks,
nothing shortens it), write the privacy notice, show one person the kill switch.
```

---
