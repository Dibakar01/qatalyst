# Runbook

Operations page for Qatalyst: how to deploy it, how to restart the worker, how
to back up and restore, and the kill switch. Written for someone who did not
build this, at whatever hour they're reading it.

## Read this before you run anything

**Two commands destroy data: `npm run test:acceptance` and `npm run verify`.**
They `TRUNCATE` — `contacts`, `suppressions`, `messages`, `events`, and also
`mailboxes` and `campaigns`. That is not a side effect; it is how they get a
clean database to assert against.

They now refuse to run unless `DATABASE_URL` names a database on an explicit
**disposable list**:

```
qatalyst_scratch   qatalyst_integration   qatalyst_verify   qatalyst_ci
qatalyst_core      qatalyst_qa            qatalyst_ops      qatalyst_test
```

Anything else — above all a bare `qatalyst` — aborts with exit 2 before touching
the database.

```sh
# safe
DATABASE_URL="postgresql://$(whoami)@localhost:5432/qatalyst_scratch" npm run verify

# refused, by design
DATABASE_URL="postgresql://$(whoami)@localhost:5432/qatalyst" npm run verify
```

**"Is it local?" is not the question, and asking it is what caused the
incident.** On 2026-08-17 the guard checked only that the host was local. The
production database is local. It passed, and `test:acceptance` truncated the
live contact list — 4 contacts, 1 suppression, 4 messages, every mailbox and
every campaign — with no backup or PITR predating it. The list was test data at
the time, which is the only reason this is a paragraph in a runbook rather than
a much worse day.

Two things follow, and neither is optional once real leads are loaded:

- **Never edit the allowlist to make a run succeed.** If a command refuses, the
  database is the problem, not the guard. Create a scratch one:
  `createdb qatalyst_scratch`.
- **WAL archiving is on** (`archive_mode=on`, archiving to
  `~/.qatalyst-backups/wal/`), so point-in-time recovery now exists. It did not
  on the day it was needed. Take a base backup with `npm run backup` before any
  bulk import, and see [Restore](#restore).

> Sending is a **dry run** while `GOOGLE_SERVICE_ACCOUNT_JSON` is unset: the
> app records exactly what it would have sent, including a placeholder
> Message-ID, and never contacts Google. That is a safety property, not an
> oversight. Do not set it to "see if it works".

## What actually runs

One Docker image (`Dockerfile`), three ways:

| | command | where |
|---|---|---|
| App, private | `npm start` | behind `APP_PASSWORD` — the workspace itself |
| App, public | `npm start` with `PUBLIC_ONLY=1` | `/u/:token` only, everything else 404s |
| Worker | `npm run send` | `docker-compose.yml`'s `worker` service |

Same image for all three — same `node_modules`, same build. Only the command
and the environment differ. The public and private apps run on separate
boxes in the real deployment (README's "Hosting split"); the worker runs
alongside `reacher` and the database, on the private/sending box.

## Deploy

```sh
git clone <repo> /opt/qatalyst && cd /opt/qatalyst
cp .env.example .env        # fill in DATABASE_URL, APP_PASSWORD, UNSUBSCRIBE_SECRET,
                             # SEND_TZ, and the Google credential(s) — see .env.example
docker build .               # sanity check: the image builds clean
docker compose up -d         # starts reacher + the worker
```

### Upgrading an existing install — the step that is easy to miss

The block above is a *fresh* install. On an upgrade `.env` already exists, is
gitignored, and nothing migrates it: `git pull` brings new code that requires new
variables, and leaves the file that would satisfy them untouched.

**`SEND_TZ` is the one that bites**, because it is the only variable in the whole
config that is required, has no default, and has no fail-closed fallback. Every
other addition degrades quietly by design — `INGEST_SECRET` unset shuts the door,
`SITE_ORIGINS` unset allows nobody. `SEND_TZ` unset returns a server error and
the workspace does not render at all.

```sh
# run on every box, every upgrade, before restarting anything
grep -q '^SEND_TZ=' .env || echo 'SEND_TZ=Asia/Kolkata' >> .env
psql "$DATABASE_URL" -tAc 'SHOW timezone'   # must equal SEND_TZ
```

This happened locally on 2026-08-18: the S4 fix made `SEND_TZ` mandatory,
`.env.example` gained it, the real `.env` did not, and the app went down while
**CI stayed green** — because `ci.yml` sets `SEND_TZ` explicitly in its own `env:`
block. A passing pipeline says the code is correct on a machine configured for
it. It says nothing about whether any other machine is configured for it.

More generally, after any upgrade:

```sh
# names present in the example but missing from this box's .env
comm -23 <(sed -n 's/^\([A-Z_][A-Z0-9_]*\)=.*/\1/p' .env.example | sort -u) \
         <(sed -n 's/^\([A-Z_][A-Z0-9_]*\)=.*/\1/p' .env | sort -u)
```

Read the result rather than glancing at it. Most entries are optional and safe to
leave unset; check each against `.env.example`'s comment, which says what unset
means for that variable.

`docker compose up -d` starts `reacher` (the email verifier, needs outbound
port 25 — see `docker-compose.yml`'s own comment) and `worker` (`npm run
send`, `restart: always`). It does **not** start the app itself — `next
start` is a normal web process; run it however this box already runs web
processes (`docker run <image>`, a PaaS, systemd — whatever fits the host).
Two app deployments, same image, differing only in `PUBLIC_ONLY`.

**Survive a reboot.** `restart: always` only re-supervises a container Docker
already knows about — if the host reboots, the Docker daemon comes up with
nothing running until something runs `docker compose up -d` again.
`deploy/qatalyst.service` is that missing step: a systemd unit that does
exactly that at boot, then gets out of the way. Install:

```sh
sudo cp deploy/qatalyst.service /etc/systemd/system/qatalyst.service
sudo systemctl daemon-reload
sudo systemctl enable --now qatalyst
```

Adjust `WorkingDirectory` in the unit file to wherever the repo actually
lives on the box first.

**Secrets are environment-only.** Nothing is baked into the image — not
`DATABASE_URL`, not `GOOGLE_SERVICE_ACCOUNT_JSON`, nothing. They come from
`.env` (compose's `env_file:`) or however the app deployment injects
environment variables. `.env` is gitignored; keep it that way, and never
commit a filled-in copy.

## Restart the worker

```sh
docker compose restart worker      # or just: it restarts itself on any exit
docker compose logs -f worker      # what it's doing right now
docker compose stop worker         # deliberately stop it (see kill switch below
                                    # for stopping SENDING, which is a different thing)
```

**Why compose's `restart: always` and not a systemd unit per-process:** the
worker is already one process that's already inside the same Docker
lifecycle as `reacher` and (on this box) the database client tooling. A
second supervision layer on top of Docker's own would just be two things
disagreeing about whether the process should be running. `deploy/qatalyst.service`
supervises the *stack* at boot; Docker supervises the *process* every other
time.

**Why this can never become two senders competing:** `core`'s `sendTick()`
takes a `pg_try_advisory_lock` at the top of every tick. A second worker (a
manual `docker compose up` while one's already running, a restart racing a
slow shutdown) finds the lock held and declines that tick rather than
double-sending. Supervision does not need to worry about this — it's already
handled a layer down.

### Two things about the worker that are `core`'s files, not fixed here

Reported, not touched — `scripts/send.ts` is outside `ops`'s ownership:

- **`scripts/send.ts:89`** sleeps 60 seconds *before* re-checking the
  `stopping` flag set by `SIGINT` (`:50-53`). A clean `docker compose stop
  worker` (or a plain ctrl-c) can therefore take up to a minute to actually
  exit. Not a bug that loses anything — the in-flight tick still finishes —
  but worth knowing if a deploy script assumes an instant stop.
- **`scripts/send.ts:86-89`**: any persistent error (a bad `DATABASE_URL`
  after a rotation, Postgres unreachable, a Gmail credential rejected)
  lands in the catch, gets logged, and the loop tries again in 60 seconds —
  forever. No backoff, and nothing pages anyone. If the worker's logs show
  the same error every minute, that is the whole alert; there is no other
  one. Watching `docker compose logs -f worker` (or shipping those logs
  somewhere that pages on a repeated line) is the only thing standing in for
  real alerting today. The infrastructure plan calls for exactly two signals
  — sends stopped during the window, bounce rate crossing the halt threshold
  — and neither exists yet.

## Backup

```sh
npm run backup                       # backs up whatever DATABASE_URL points to
BACKUP_DIR=/mnt/backups npm run backup   # write somewhere other than ~/.qatalyst-backups
```

Writes to `$BACKUP_DIR/<dbname>/<UTC timestamp>/` (default
`~/.qatalyst-backups`, kept out of the repo on purpose — this never touches
`.gitignore` and a backup full of contact data has no business anywhere near
git):

- **`<dbname>.dump`** — `pg_dump --format=custom`. The artifact `restore.sh`
  actually restores from. Portable, restorable table-by-table, and its own
  table of contents can be read (`pg_restore --list`) without opening a
  database connection — that's what powers `--dry-run` below.
- **`basebackup/`** — `pg_basebackup`, best-effort. A physical backup for
  point-in-time recovery, self-consistent on its own
  (`--wal-method=stream` folds in the WAL the backup itself generates). Some
  managed Postgres hosts (this app explicitly supports Neon — see README's
  Setup) don't grant replication access; if `pg_basebackup` fails, backup.sh
  logs it and keeps going rather than failing the whole run, because the
  `.dump` above is already a complete backup by itself.
- **`meta.txt`** — timestamp, sizes, tool versions, and a row count per
  table at backup time. Human-readable at a glance; also what `--dry-run`
  below prints.

Run it on a schedule (cron, or a scheduled task on whatever's managing this
box) — daily is what the infrastructure plan sizes for. There's no daily
timer wired up in this repo; add one line to the host's crontab
(`0 3 * * * cd /opt/qatalyst && npm run backup`) when a real production box
exists to point it at.

**Point-in-time recovery, honestly stated.** What's here restores to the
moment a backup finished, not to an arbitrary instant between two backups.
Getting the second kind needs continuous WAL capture running the whole time
— `archive_mode=on` with an `archive_command`, or `pg_receivewal` run as its
own always-on process — and that's a real upgrade path, not a hard one, when
a production box holds enough send history that losing up to a day of it
would actually hurt. Not built here: it's a second continuously-running
process for a database presently measured in megabytes, which is exactly
what the infrastructure plan rules out at this scale. `ponytail` comment is
in `scripts/backup.sh` next to the `pg_basebackup` call.

## Restore

```sh
bash scripts/restore.sh --dry-run                     # validate, print, touch nothing
bash scripts/restore.sh --dry-run --from <path>        # check a specific backup

bash scripts/restore.sh --target <DATABASE_URL> --from <path> --yes
```

`--dry-run` finds the latest backup for whatever database `DATABASE_URL`
names (or one given explicitly with `--from`), confirms the dump file is
present and readable, and prints exactly what it would restore — the
`meta.txt` from backup time and the table list straight out of the dump's
own table of contents. **It never opens a database connection.** This is the
step the `qa` harness runs as proof the restore path exists at all.

The real restore **always requires `--target` explicitly.** It never falls
back to `$DATABASE_URL` — a script that quietly restores over whatever
happens to be in the environment is exactly how the real `qatalyst` database
(the one with the live contact list) gets overwritten by accident instead of
on purpose. Without `--yes`, on a terminal, it asks for the target database
name typed back before touching anything; without a terminal and without
`--yes`, it refuses outright rather than guessing.

Restoring runs `pg_restore --clean --if-exists` — it drops and recreates
each table before repopulating it, so "drop or clear it, then restore" is
one command rather than a separate `dropdb`/`createdb` dance.

## Restore drill — performed 2026-08-17

A backup is a belief until a restore has actually been done. This is that
drill, against the scratch database `qatalyst_ops` (never against the real
`qatalyst` database — see "Only ever `qatalyst_ops`" below).

1. Seeded `qatalyst_ops` with `npm run db:demo` so the drill had real rows to
   lose, not an empty database restoring into itself.
2. `npm run backup` → `~/.qatalyst-backups/qatalyst_ops/20260817T160722Z/`
   (`qatalyst_ops.dump`, 34,818 bytes; `pg_basebackup` also succeeded).
   Row counts recorded in that backup's `meta.txt`:

   | table | rows |
   |---|---|
   | campaigns | 1 |
   | contacts | 4 |
   | messages | 2 |
   | everything else (connectors, conversions, domains, enquiries, events, mailboxes, settings, suppressions, warmups) | 0 |

3. `bash scripts/restore.sh --dry-run` — found the backup, printed
   `meta.txt` and the 13-table restore list (12 app tables plus
   `drizzle.__drizzle_migrations`), touched nothing. Exit 0.
4. **Dropped `qatalyst_ops` entirely** (`dropdb` + `createdb` — the harder of
   the two forms the task allows, "drop or clear it"), so the restore had to
   rebuild schema and data both, from zero tables.
5. `bash scripts/restore.sh --target postgresql://…/qatalyst_ops --yes` —
   restored clean.
6. **Verified**: row counts after restore matched step 2 exactly —
   `campaigns=1, contacts=4, messages=2`, all others `0` — and all 12 tables
   plus `drizzle.__drizzle_migrations` (17 rows, its full migration history)
   were present again.

**Result: pass.** The path from `npm run backup` to a fully rebuilt database
with matching row counts works end to end. Re-run this drill after any
schema change that adds a table `backup.sh`'s row-count query doesn't yet
know about, and whenever this runbook's dated result gets old enough to
doubt.

### Only ever `qatalyst_ops`

The real `qatalyst` database on this machine holds the live contact list.
Every command in this runbook and in `scripts/backup.sh` /
`scripts/restore.sh` was run against `qatalyst_ops` — never `qatalyst` —
during this build. `restore.sh`'s explicit-`--target` requirement exists
specifically so that habit isn't the only thing standing between a routine
drill and overwriting the real list; do not develop against a shortcut that
removes it.

## Kill switch

Two independent controls. Both already work; this is the first time either
has been written down or shown to anyone but the person who built them.

### Stop all sending, immediately: Practice mode

Flip **Practice** in the workspace header (top right, next to the
"Gmail live" / "Practice" / "No key" indicator — it's the small switch,
visible whenever a Google credential is configured). One click: every send
still runs the full pipeline — validators, rate limits, everything — but
`deliver()` holds the post instead of calling Gmail. Nothing leaves.
It can only ever make sending safer than it already is, never less.

If the app itself is unreachable (the box is down, the workspace won't
load), the same switch from a database client, connected directly:

```sql
UPDATE settings SET practice = true WHERE id = 1;
```

There is exactly one settings row (`id = 1`); `lib/settings.ts` creates it on
first use if it's somehow missing, so this always has something to update.

### Stop one domain without stopping everything

Each domain has a **Pause** button next to it in the workspace (Domains
section — a domain shows `Pause` when active, `Resume` when paused). One
click stops every mailbox on that domain at once, which is the point of
grouping mailboxes by domain in the first place: a domain that's started
bouncing or drawing complaints can be pulled without touching the others
still sending cleanly.

Same database fallback if the workspace is unreachable:

```sql
UPDATE domains SET active = false WHERE name = 'example.com';
-- flip it back: UPDATE domains SET active = true WHERE name = 'example.com';
```

### Which one to reach for

**Practice** is the whole-system brake — reach for it when something is
wrong and it isn't yet clear what ("did we just send someone three copies of
the same email") or when it's wrong enough that nothing should go out
anywhere while it's being sorted out. **Pause** is scoped to one domain —
reach for it when the problem is clearly local to that domain (bounce rate
climbing, a spam-folder report) and the other domains are fine to keep
sending. Both take effect on the worker's next tick (at most a minute) —
they change what a tick is allowed to do, not what's already in flight.
