# BOARD.md

Written by the manager, from the lanes' status files. Nobody else edits this.

**Phase 5 complete — independently verified. Awaiting the merge to `main`.**
Build ran 2026-08-17 from `2208f3f`; `integration` is at `42e9338`.

| lane | agent | branch | findings | commits | status |
| --- | --- | --- | --- | --- | --- |
| core | Opus | `core` | S1, S2, S4, S5, S6, S9 | 4 | **done, terminated** |
| qa | Sonnet | `qa` | S8 + the whole harness | 4 | **done, terminated** |
| ops | Sonnet | `ops` | S3, S7 | 1 | **done, terminated** |

All three merged into `integration` with **zero conflicts** — 20+ files across three agents
that never spoke, and no file had two owners. That is the return on freezing boundaries in
Phase 1.

Each lane ran against its own scratch database (`qatalyst_core` / `_qa` / `_ops`). No Google
sending credential is configured anywhere, so all sending is still a dry run.

> **Do not reuse the worktrees as-is.** `node_modules` was symlinked into them from the main
> checkout to avoid three `npm ci` runs; Turbopack panics on that symlink, and it cost `ops`
> its `docker build` verification. Run a real `npm ci` per worktree (~8s).

## Findings — 9 of 9 closed

| | sev | lane | status |
|---|---|---|---|
| S1 | CRITICAL | core | **closed** — claim before the wire, advisory lock, post-wire failure counts as sent |
| S2 | HIGH | core | **closed** — `db:seed` uses the shared pool and exits |
| S4 | HIGH | core | **closed** — `SEND_TZ`, pure helpers, boot-time DB timezone assert |
| S3 | HIGH | ops | **closed** — Dockerfile, compose worker, systemd unit |
| S6 | MEDIUM | core | **closed** — the webhook path cannot assert `email_status` |
| S7 | MEDIUM | ops | **closed** — backup/restore, **drill performed and dated 2026-08-17** |
| S5 | LOW | core | **closed** — static-bundle scoping moved into `proxy()` |
| S8 | LOW | qa | **closed** — the guard parses the URL instead of requiring `@` |
| S9 | — | core | **closed** — `List-Unsubscribe` + `-Post`, RFC 8058 |

## PROOF

`bash scripts/verify.sh` — **10 passed, 0 failed, 1 unverifiable, exit 0.**

Run twice: once by the manager, then independently by a session that wrote none of this code,
against a brand-new never-migrated `qatalyst_ci`. **A4 satisfied.** That reviewer also found
two real holes in the disposable-database allowlist, both since closed (`1262543`).

**And green on CI — `11 passed, 0 failed, 0 unverifiable`** (run `32057108337`, commit
`ca57236`, PR #1). `docker build .` finally has a real result: it **passes**. Nothing is
"unverifiable" any more; every criterion has been executed somewhere.

Getting there took three defects that **no local run could have found**, which is the whole
argument for the PR route over a direct merge:

| | Defect | Why it was invisible locally |
|---|---|---|
| 1 | The window fixtures built timestamps with `setHours()` — the **server's** clock, the exact assumption S4 removed | Both dev machines are IST, so server clock and `SEND_TZ` coincided. Three fixtures had it; `noon` and `late` were passing by luck, and `late` broke the moment `early` was fixed |
| 2 | `pg_dump` 16 on the runner against a Postgres 17 container | Locally the client matches the server |
| 3 | Installing `postgresql-client-17` left `pg_dump` 16 on PATH — `/usr/bin/pg_dump` is `pg_wrapper`, which picks the **default cluster's** version, not the newest | Only exists on Debian-packaged Postgres |

Defect 3 is worth keeping for its shape rather than its content: **the install step reported
`success`, and it had — the package installed. It just did not do the thing it was for.** Same
family as the S8 guard validating a `DATABASE_URL` the line above had already replaced, and as
`verify.sh` printing a phantom `FAIL` on a green run. Three in one night: assert the *effect*,
never the exit code.

## Ship gate

| item | status | blocked on |
|---|---|---|
| Suppression proven at the wire | **GREEN** | — |
| CI runs lint, test, build, migrate, acceptance, verify | **GREEN** | — |
| Restore drill performed against a real backup, with a date | **GREEN** | done 2026-08-17, row counts verified |
| `List-Unsubscribe` answered rather than assumed | **GREEN** | S9 shipped |
| Kill switch documented, one other person shown | **AMBER** | runbook written; nobody else shown yet |
| Warm-up 2–3 weeks per domain | **AMBER** | **calendar — nothing in the code shortens it** |
| SPF/DKIM/DMARC verified by a real message | **RED** | after warm-up |
| Privacy notice written | **RED** | human; gates the pixel |

Was 2 green / 2 amber / 4 red at the start of the day.

## Open

1. **Merge PR #1 `integration` → `main` — REQUIRES THE HUMAN.** Green and ready. A peer
   session attempted the merge and its permission system blocked it; it did not route around
   that, and neither did this session when told. **A peer being denied an action is not
   authorisation for another agent to perform it.** Green is not shipped, and a status board
   that records one as the other is the specific error this row exists to avoid.

   ```sh
   gh pr merge 1 --squash --delete-branch    # the human presses this
   ```

   Note the PR was originally opened by the auto-committer with an empty body, and rewritten
   afterwards.
2. **An unattended process commits and pushes on a ~40-minute timer** — high confidence
   Antigravity IDE. It authored `6d14785`, `bb4d329`, `5f10e78` (no Claude trailer on any),
   and once captured `scripts/verify.sh` mid-edit. **Disable before the PR exists**: it can
   push onto a PR branch after review, so the reviewed diff and the merged diff stop being
   the same artifact.
3. Human calendar items, out of this team's scope: start warm-up, write the privacy notice,
   walk one other person through the kill switch.
