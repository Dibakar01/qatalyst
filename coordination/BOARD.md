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

The one unverifiable step is `docker build .` — there is no Docker binary on this machine, and
the harness reports it as `????`, never as a pass. It is settled by CI on ubuntu, which has
not yet run because CI triggers only on `push: [main]` and `pull_request`.

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

1. **PR `integration` → `main`.** GitHub's Issues/PR subsystem is returning 503 (partial
   outage); reads and `git push` are fine. Held, retrying. The PR is what finally exercises
   `docker build` on ubuntu, before `main` carries the code.
2. **An unattended process commits and pushes on a ~40-minute timer** — high confidence
   Antigravity IDE. It authored `6d14785`, `bb4d329`, `5f10e78` (no Claude trailer on any),
   and once captured `scripts/verify.sh` mid-edit. **Disable before the PR exists**: it can
   push onto a PR branch after review, so the reviewed diff and the merged diff stop being
   the same artifact.
3. Human calendar items, out of this team's scope: start warm-up, write the privacy notice,
   walk one other person through the kill switch.
