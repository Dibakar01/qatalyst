#!/usr/bin/env bash
set -euo pipefail

# The path back. Two modes:
#
#   bash scripts/restore.sh --dry-run [--from <dump-file-or-backup-dir>]
#     Finds the backup, checks it is readable, prints what it would restore.
#     Never opens a connection to any database — pg_restore --list reads a
#     dump's table of contents straight off disk.
#
#   bash scripts/restore.sh --target <DATABASE_URL> --from <path> [--yes]
#     Restores for real. --target is REQUIRED and is never defaulted from
#     $DATABASE_URL or anything else — a restore overwrites the target, and a
#     script that quietly restores over whatever env var happens to be set is
#     how the real `qatalyst` database gets clobbered by accident. Without
#     --yes, on a terminal, it asks you to type the target database name back.
#
# --from accepts either a .dump file directly, or a backup directory produced
# by backup.sh (in which case it looks for <dbname>.dump inside it). With no
# --from, it looks for $BACKUP_DIR/<dbname>/latest, where <dbname> comes from
# --target if given, else from $DATABASE_URL — so `npm run backup && bash
# scripts/restore.sh --dry-run` finds what was just taken with no flags at all.

cd "$(dirname "$0")/.."

DRY_RUN=0
TARGET=""
FROM=""
ASSUME_YES=0

usage() {
  cat >&2 <<'EOF'
Usage:
  scripts/restore.sh --dry-run [--from <path>]
  scripts/restore.sh --target <DATABASE_URL> --from <path> [--yes]
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --target) TARGET="${2:-}"; shift 2 ;;
    --target=*) TARGET="${1#*=}"; shift ;;
    --from) FROM="${2:-}"; shift 2 ;;
    --from=*) FROM="${1#*=}"; shift ;;
    --yes) ASSUME_YES=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "restore.sh: unrecognised argument: $1" >&2; usage; exit 1 ;;
  esac
done

if [ -z "${DATABASE_URL:-}" ] && [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

BACKUP_DIR="${BACKUP_DIR:-$HOME/.qatalyst-backups}"

db_name_of() {
  # $1: a postgres:// URL. Empty output on anything that isn't one.
  node -e "try { console.log(new URL(process.argv[1]).pathname.replace(/^\//, '')) } catch { console.log('') }" "$1"
}

# Resolve --from to an actual .dump file, and to the meta.txt beside it if
# present. Shared by both modes so dry-run proves exactly what a real restore
# would use.
resolve_dump() {
  local from="$1" hint_url="$2" dbname dir file

  if [ -n "$from" ]; then
    if [ -d "$from" ]; then
      dbname="$(basename "$(cd "$from/.." && pwd)")"
      file="$from/$dbname.dump"
    else
      file="$from"
    fi
  else
    dbname="$(db_name_of "$hint_url")"
    if [ -z "$dbname" ]; then
      echo "restore.sh: no --from given, and no database name to guess one from (set DATABASE_URL or --target, or pass --from explicitly)" >&2
      return 1
    fi
    dir="$BACKUP_DIR/$dbname/latest"
    file="$dir/$dbname.dump"
  fi

  if [ ! -f "$file" ]; then
    echo "restore.sh: no backup found at $file" >&2
    echo "restore.sh: run 'npm run backup' first, or pass --from explicitly" >&2
    return 1
  fi
  if [ ! -r "$file" ]; then
    echo "restore.sh: $file exists but is not readable" >&2
    return 1
  fi
  echo "$file"
}

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

if [ "$DRY_RUN" = 1 ]; then
  DUMP_FILE="$(resolve_dump "$FROM" "${TARGET:-${DATABASE_URL:-}}")" || exit 1

  echo "restore.sh: DRY RUN — no database will be touched"
  echo "restore.sh: backup file: $DUMP_FILE ($(wc -c <"$DUMP_FILE" | tr -d ' ') bytes)"

  META="$(dirname "$DUMP_FILE")/meta.txt"
  if [ -f "$META" ]; then
    echo
    echo "-- meta.txt -------------------------------------------------------"
    cat "$META"
    echo "---------------------------------------------------------------"
  fi

  # Reads the dump's own table of contents off disk. No connection, no
  # DATABASE_URL required — this is the whole point of --dry-run.
  echo
  echo "would restore these tables (pg_restore --list):"
  pg_restore --list "$DUMP_FILE" | grep 'TABLE DATA' | awk '{print "  " $6"."$7}' | sort

  if [ -n "$TARGET" ]; then
    echo
    echo "restore.sh: --target ($TARGET) was only used to pick which database's backup to look up — no connection was opened to it"
  fi

  echo
  echo "restore.sh: dry run ok — pass --target <DATABASE_URL> --yes to restore for real"
  exit 0
fi

# --- real restore -----------------------------------------------------------

if [ -z "$TARGET" ]; then
  echo "restore.sh: refusing to restore — no --target given." >&2
  echo "restore.sh: this never defaults to \$DATABASE_URL. Pass the exact" >&2
  echo "restore.sh: connection string you want overwritten:" >&2
  echo "restore.sh:   bash scripts/restore.sh --target <DATABASE_URL> --from <path> --yes" >&2
  exit 1
fi

DUMP_FILE="$(resolve_dump "$FROM" "$TARGET")" || exit 1
TARGET_DB="$(db_name_of "$TARGET")"
if [ -z "$TARGET_DB" ]; then
  echo "restore.sh: --target does not look like a postgres:// URL" >&2
  exit 1
fi

echo "restore.sh: about to restore $DUMP_FILE"
echo "restore.sh: onto database '$TARGET_DB' (this DROPS and recreates its objects)"

if [ "$ASSUME_YES" != 1 ]; then
  if [ ! -t 0 ]; then
    echo "restore.sh: refusing to proceed without --yes (not a terminal, can't ask)" >&2
    exit 1
  fi
  read -r -p "Type the database name ('$TARGET_DB') to confirm: " CONFIRM
  if [ "$CONFIRM" != "$TARGET_DB" ]; then
    echo "restore.sh: confirmation did not match — aborted, nothing touched" >&2
    exit 1
  fi
fi

pg_restore --clean --if-exists --no-owner --dbname="$TARGET" "$DUMP_FILE"

echo "restore.sh: restore complete. Row counts on '$TARGET_DB' now:"
psql "$TARGET" -tAc "$ROW_COUNT_SQL" | sed 's/|/ = /'
