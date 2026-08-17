# BOARD.md

Written by the manager, from the lanes' status files. Nobody else edits this.

**Phase 3 — supervising.** All three lanes launched 2026-08-17, from `2208f3f`.

| lane | agent | worktree | branch | status | last update |
| --- | --- | --- | --- | --- | --- |
| core | `core` (Opus) | `../qatalyst-core` | `core` | running | launched |
| qa | `qa` (Sonnet) | `../qatalyst-qa` | `qa` | running | launched |
| ops | `ops` (Sonnet) | `../qatalyst-ops` | `ops` | running | launched |

Each worktree has its own scratch database — `qatalyst_core` / `qatalyst_qa` /
`qatalyst_ops`, all migrated, all green at 113 tests — and `node_modules` symlinked from the
main checkout. **No worktree references the real `qatalyst` database**, which is the one
holding the live contact list and which `test:acceptance` would truncate. No Google sending
credential is configured anywhere, so all sending is a dry run.

## Findings

| | sev | lane | status |
|---|---|---|---|
| S1 | CRITICAL | core | open |
| S2 | HIGH | core | open |
| S4 | HIGH | core | open |
| S3 | HIGH | ops | open |
| S6 | MEDIUM | core | open |
| S7 | MEDIUM | ops | open |
| S5 | LOW | core | open |
| S8 | LOW | qa | open |
| S9 | — | core | open |

## Ship gate

| item | status | blocked on |
|---|---|---|
| Suppression proven at the wire | **GREEN** | — |
| CI runs all five steps | **GREEN** | — |
| Warm-up 2–3 weeks per domain | **AMBER** | **calendar — start today, no code shortens it** |
| Kill switch documented, one other person shown | **AMBER** | human, minutes |
| SPF/DKIM/DMARC verified by a real message | **RED** | after warm-up |
| Restore drill performed and dated | **RED** | ops (S7) |
| Privacy notice written | **RED** | human |
| `List-Unsubscribe` answered | **RESOLVED** | → S9, core |
