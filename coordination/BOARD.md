# BOARD.md

Written by the manager, from the lanes' status files. Nobody else edits this.

**Phase 2 — launching.** Approved 2026-08-17.

| lane | agent | worktree | branch | status | last update |
| --- | --- | --- | --- | --- | --- |
| core | — | `../qatalyst-core` | `core` | not started | — |
| qa | — | `../qatalyst-qa` | `qa` | not started | — |
| ops | — | `../qatalyst-ops` | `ops` | not started | — |

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
