#!/usr/bin/env bash
set -euo pipefail

# Backs up whatever DATABASE_URL points to: a logical dump (pg_dump, the
# artifact restore.sh actually restores from) plus a best-effort physical
# base backup (pg_basebackup) for point-in-time recovery. Plain client tools,
# no new dependency — this database is measured in megabytes. See
# docs/runbook.md for the restore drill and how these two pieces relate.
#
#   npm run backup                    # backs up $DATABASE_URL
#   BACKUP_DIR=/mnt/backups npm run backup
#
# Never point this at the real `qatalyst` database from a dev machine while
# testing — it is non-destructive (read-only against the source), but there
# is no reason to pull a copy of the live contact list onto a laptop either.

cd "$(dirname "$0")/.."

if [ -z "${DATABASE_URL:-}" ] && [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

if [ -z "${DATABASE_URL:-}" ]; then
  echo "backup.sh: DATABASE_URL is not set (checked the environment and .env)" >&2
  exit 1
fi

DBNAME="$(node -e "console.log(new URL(process.argv[1]).pathname.replace(/^\//, ''))" "$DATABASE_URL")"
if [ -z "$DBNAME" ]; then
  echo "backup.sh: could not read a database name out of DATABASE_URL" >&2
  exit 1
fi

BACKUP_DIR="${BACKUP_DIR:-$HOME/.qatalyst-backups}"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$BACKUP_DIR/$DBNAME/$TS"
mkdir -p "$OUT"

echo "backup.sh: backing up '$DBNAME' -> $OUT"

# The primary artifact. Compact, portable, restorable table-by-table, and
# `pg_restore --list` reads its table of contents without opening a database
# connection at all — that is what restore.sh --dry-run relies on.
pg_dump --format=custom --file="$OUT/$DBNAME.dump" "$DATABASE_URL"
DUMP_BYTES=$(wc -c <"$OUT/$DBNAME.dump" | tr -d ' ')
echo "backup.sh: pg_dump ok ($DUMP_BYTES bytes)"

# Best-effort. Some managed Postgres hosts (this app explicitly supports
# Neon — see README's Setup) don't grant replication access, and a host
# declining a physical backup should not fail the whole run: the pg_dump
# above is already a complete, restorable backup on its own.
#
# --wal-method=stream folds in the WAL generated during the backup itself, so
# this tar is self-consistent with no separate archiver process running
# continuously.
#
# ponytail: this covers "restorable to the moment the backup finished," not
# "restorable to any instant between two backups." Continuous WAL archiving
# (`archive_mode=on` + `archive_command`, or `pg_receivewal` run as its own
# supervised process — both standard Postgres, no new dependency) is the
# upgrade path once a production box holds enough real send history that
# losing a day of it would actually hurt. Documented, not built: see
# docs/runbook.md.
if pg_basebackup --pgdata="$OUT/basebackup" --format=tar --gzip --checkpoint=fast \
  --wal-method=stream -d "$DATABASE_URL" >"$OUT/basebackup.log" 2>&1; then
  echo "backup.sh: pg_basebackup ok"
  BASEBACKUP_STATUS="ok"
else
  echo "backup.sh: pg_basebackup skipped or failed (see $OUT/basebackup.log) — the pg_dump above is still a complete backup" >&2
  BASEBACKUP_STATUS="failed-or-unavailable"
fi

ROW_COUNT_SQL="
  select 'contacts', count(*) from contacts
  union all select 'suppressions', count(*) from suppressions
  union all select 'campaigns', count(*) from campaigns
  union all select 'messages', count(*) from messages
  union all select 'domains', count(*) from domains
  union all select 'mailboxes', count(*) from mailboxes
  union all select 'events', count(*) from events
  union all select 'connectors', count(*) from connectors
  union all select 'enquiries', count(*) from enquiries
  union all select 'conversions', count(*) from conversions
  union all select 'warmups', count(*) from warmups
  union all select 'settings', count(*) from settings
  order by 1
"

{
  echo "database:         $DBNAME"
  echo "taken (UTC):       $TS"
  echo "pg_dump file:      $DBNAME.dump ($DUMP_BYTES bytes)"
  echo "pg_basebackup:     $BASEBACKUP_STATUS"
  echo "pg_dump version:   $(pg_dump --version)"
  echo
  echo "row counts at backup time:"
  psql "$DATABASE_URL" -tAc "$ROW_COUNT_SQL" | sed 's/|/ = /'
} >"$OUT/meta.txt"

ln -sfn "$TS" "$BACKUP_DIR/$DBNAME/latest"

echo "backup.sh: done"
cat "$OUT/meta.txt"
