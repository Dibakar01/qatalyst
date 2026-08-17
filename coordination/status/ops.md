# ops — status

## 2026-08-17 — S3 and S7 both landed, DONE criteria met

Worktree: `../qatalyst-ops`, branch `ops`, commit `ccc015b`. Clean tree, committed.

**Note on setup:** `EnterWorktree` refused to switch me into `qatalyst-ops` from the
main repo root ("switching is only available to sessions whose working directory is
inside a worktree of this repository") even though `git worktree list` confirms it's
a legitimate worktree on branch `ops`. Worked around it entirely with absolute paths
via Bash/Read/Write/Edit — never touched the main checkout's tracked files. Flagging
in case this blocks a differently-configured agent later; not a blocker for me.

**S3 — deployment artifact:**
- `Dockerfile` — multi-stage (deps → builder → runner), `npm ci` then `npm run
  build`, production deps only in the runtime image. One image runs either
  `npm start` (app) or `npm run send` (worker, via compose). Could not run
  `docker build .` myself — no `docker` binary in this sandbox — so I validated
  the build logic by hand instead: confirmed `npm run build` fails in *this*
  worktree only because of a Turbopack/symlinked-node_modules issue specific to
  the worktree setup (reproduced, then confirmed clean in the main checkout with
  real node_modules — same Node 24, same deps), and confirmed the build needs a
  syntactically-present `DATABASE_URL` at build time only (never connects), which
  the Dockerfile supplies as a placeholder scoped to the builder stage only —
  never copied into the runner stage. Worth a real `docker build .` once docker
  is available anywhere in this pipeline; I'm as confident as static review gets
  me without one.
- `docker-compose.yml` extended with a `worker` service, `restart: always`,
  `npm run send`. No `depends_on: reacher` — verified the worker doesn't
  actually call it (verifyUnverified() has no caller, confirmed in lib/sources.ts).
- `deploy/qatalyst.service` — systemd unit, boots `docker compose up -d` so the
  stack survives a host reboot (compose's restart policy alone doesn't cover that).
- Reported (not touched, core's file): `scripts/send.ts:89` sleeps 60s before
  checking `stopping`; `:86-89` retries any persistent error every 60s forever,
  no backoff, no alert. In `docs/runbook.md`.

**S7 — backup/restore:**
- `scripts/backup.sh` — pg_dump (custom format, primary restore artifact) +
  best-effort pg_basebackup (`--wal-method=stream`) for PITR. Writes to
  `~/.qatalyst-backups/<dbname>/<ts>/`, outside the repo (avoided touching
  .gitignore, which isn't in my OWNS list).
- `scripts/restore.sh` — `--dry-run` validates + reports via `pg_restore --list`,
  zero DB connections. Real restore requires `--target` explicitly, never
  defaults from `$DATABASE_URL`, confirms interactively or via `--yes`.
- **Restore drill performed and dated 2026-08-17**, against `qatalyst_ops` only:
  seeded via `npm run db:demo`, backed up, `dropdb`+`createdb` (full drop, not
  just truncate), restored, verified row counts match exactly (campaigns=1,
  contacts=4, messages=2, rest 0 — all 12 tables + drizzle.__drizzle_migrations
  present). Full record in `docs/runbook.md`.
- Never pointed anything at the real `qatalyst` database — verified by name at
  every step, only ever `qatalyst_ops`.

**`docs/runbook.md`** — deploy, restart the worker (and why compose over a
per-process systemd unit), backup, restore, the dated drill, and the kill
switch (Practice mode + per-domain pause — UI location for each plus a direct
SQL fallback for when the app itself is unreachable).

**DONE criteria status:**
- `docker build .` succeeds from a clean checkout — **unverified, no docker in
  this sandbox.** Everything short of actually invoking docker checked by hand.
- Supervised worker unit with restart policy — **done** (compose `restart: always`).
- `bash scripts/restore.sh --dry-run` runs and reports — **done, tested repeatedly.**
- Dated restore drill with verified row counts — **done**, 2026-08-17, in the runbook.

## Next
Nothing queued — S3 and S7 are the only two findings assigned to this lane per
PLAN.md, and both are landed. Available if the manager wants the Dockerfile
build-verified in an environment that actually has docker, or wants anything
else picked up.

## Blocker
None currently open. Only caveat: `docker build .` itself was never run (no
docker binary available to me) — flagging so whoever runs the qa harness's
PROOF step knows this is the first real test of it.
