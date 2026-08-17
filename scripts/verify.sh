#!/usr/bin/env bash
# scripts/verify.sh — the single command that decides ship / no-ship.
# See coordination/CONTRACTS.md §4 for what each line below proves.
#
# Every criterion below runs to completion, in order, even if an earlier one
# failed — the point of this script on the day it is written is a full
# red/green picture, not the first stack trace. `exit 0` only if every
# criterion passed.
#
# The one exception is the DATABASE_URL host check (S8): nothing after it may
# run if this process cannot prove DATABASE_URL is local, because the steps
# that follow TRUNCATE TABLES. That check aborts the script outright.

set -uo pipefail
cd "$(dirname "$0")/.."

# Load .env the same way every "node --env-file-if-exists=.env ..." script in
# package.json does, so a bare `bash scripts/verify.sh` behaves like the npm
# scripts it drives rather than needing its own separately-remembered setup.
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

PASS=()
FAIL=()
# A step this machine cannot run is not a step that failed. Collapsing the two
# is how a harness starts lying: "docker: command not found" and "the image is
# broken" are different facts, and only one of them is the code's problem.
SKIP=()

# Runs one criterion and records pass/fail without aborting the script.
# $1 = human label, $2 = owning lane if the piece being checked does not
# exist yet in this worktree ("" if it is qa's own responsibility), rest = command.
run_step() {
  local label="$1" owner="$2"
  shift 2
  echo
  echo "── ${label} ──────────────────────────────────────────────"
  if "$@"; then
    PASS+=("${label}")
  else
    local suffix=""
    [ -n "${owner}" ] && suffix="  [${owner} lane]"
    FAIL+=("${label}${suffix}")
  fi
}

# ── S8: DATABASE_URL guard ──────────────────────────────────────────────────
# The same fixed check as scripts/acceptance.ts's isLocalDatabaseUrl(): parse
# the URL and look at the hostname, rather than a regex that requires an `@`
# and so rejects `postgresql://localhost:5432/db` — the Homebrew default with
# no username. Fail closed on anything that does not parse.
is_local_db() {
  node -e '
    const isLocal = (url) => {
      try {
        const { hostname } = new URL(url)
        return hostname === "localhost" || hostname === "127.0.0.1"
      } catch {
        return false
      }
    }
    process.exit(isLocal(process.argv[1] ?? "") ? 0 : 1)
  ' "$1"
}

echo "── S8: DATABASE_URL guard ──────────────────────────────────────────"

# Prove the fix, not just apply it: the exact form the old regex rejected.
if is_local_db "postgresql://localhost:5432/db"; then
  PASS+=("S8: guard accepts postgresql://localhost:5432/db (no username)")
else
  FAIL+=("S8: guard accepts postgresql://localhost:5432/db (no username)")
fi

# And still fail closed on a host that only looks local in the string.
if is_local_db "postgresql://localhost.evil.example:5432/db"; then
  FAIL+=("S8: guard still refuses a host that is not actually local")
else
  PASS+=("S8: guard still refuses a host that is not actually local")
fi

# The real gate: this process's own DATABASE_URL, checked before anything
# below is allowed to touch a database at all.
if ! is_local_db "${DATABASE_URL:-}"; then
  echo
  echo "refusing to continue: DATABASE_URL does not parse to a local host." >&2
  echo "the steps below run db:migrate and test:acceptance, and the second" >&2
  echo "one TRUNCATES TABLES. that is not optional." >&2
  echo "current value: ${DATABASE_URL:-<unset>}" >&2
  exit 1
fi

# ── baseline regression: must not go red because of this build's own changes ──
run_step "lint, test, build" "" bash -c "npm run lint && npm test && npm run build"

# ── migrate + phase 1-3 acceptance ──────────────────────────────────────────
run_step "db:migrate, test:acceptance" "" bash -c "npm run db:migrate && npm run test:acceptance"

# ── S2: db:seed must exit ───────────────────────────────────────────────────
# GNU `timeout` is not on every machine this runs on (notably: not on macOS
# without coreutils, which is where this was developed) — a portable
# background-and-kill instead of depending on a binary that may not exist.
run_with_timeout() {
  local secs="$1"
  shift
  "$@" &
  local pid=$!
  local waited=0
  while kill -0 "$pid" 2>/dev/null; do
    sleep 1
    waited=$((waited + 1))
    if [ "$waited" -ge "$secs" ]; then
      kill -9 "$pid" 2>/dev/null
      wait "$pid" 2>/dev/null
      return 124
    fi
  done
  wait "$pid"
}
run_step "S2: db:seed exits within 30s" "core" run_with_timeout 30 npm run db:seed

# ── S1 / S4 / S6 / S9 regression checks ─────────────────────────────────────
# Filtered to just the tests tagged S<n>: in lib/lib.test.ts, so a red run
# here points at exactly which criterion is still open rather than scrolling
# through the whole suite. These require DATABASE_URL and the schema migrated
# above; they are written against the frozen signatures in CONTRACTS.md §2
# and will not compile, or will fail, until core lands them.
run_step "S1/S4/S6/S9: regression checks (lib/lib.test.ts)" "core" \
  node --test --test-name-pattern '^S[0-9]+:' lib/lib.test.ts

# ── S3: deployment artifact ──────────────────────────────────────────────────
# The image must actually build; a Dockerfile nobody has built is a guess. But
# a machine without docker cannot answer the question either way, so say that
# rather than reporting a red the code did not earn. CI runs on ubuntu, which
# has docker, and that is where this claim is actually settled.
if command -v docker >/dev/null 2>&1; then
  run_step "S3: docker build ." "ops" docker build .
else
  echo
  echo "── S3: docker build . ──────────────────────────────────────────────"
  echo "  docker is not installed on this machine — cannot verify here."
  SKIP+=("S3: docker build .  [no docker on this machine; CI settles it]")
fi

# ── S7: restore drill ────────────────────────────────────────────────────────
# Back up first, then dry-run against what that produced. A dry-run with no
# backup on disk only proves the script can complain, which is not the claim.
run_step "S7: scripts/backup.sh" "ops" bash scripts/backup.sh
run_step "S7: scripts/restore.sh --dry-run" "ops" bash scripts/restore.sh --dry-run

# ── summary ───────────────────────────────────────────────────────────────────
echo
echo "════════════════════════════════════════════════════════════════════════"
echo "verify: ${#PASS[@]} passed, ${#FAIL[@]} failed, ${#SKIP[@]} unverifiable here"
for p in "${PASS[@]:-}"; do
  [ -n "${p}" ] && echo "  PASS  ${p}"
done
for f in "${FAIL[@]:-}"; do
  echo "  FAIL  ${f}"
done
for s in "${SKIP[@]:-}"; do
  [ -n "${s}" ] && echo "  ????  ${s}"
done
if [ "${#SKIP[@]}" -gt 0 ]; then
  echo
  echo "  NOTE: ${#SKIP[@]} step(s) could not run here, so a green exit below does"
  echo "        NOT cover them. They are settled in CI, not on this machine."
fi
echo "════════════════════════════════════════════════════════════════════════"

[ "${#FAIL[@]}" -eq 0 ]
