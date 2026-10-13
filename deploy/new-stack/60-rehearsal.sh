#!/usr/bin/env bash
# 60-rehearsal.sh - the cutover rehearsal (runbook 4.2 rehearsal A, 4.3 rehearsal B with timings) on a COPY of production
# data, inside the new stack: restore the newest verified P1 daily dump into a separate database, migrate it with the
# release image, report on it, run the user migration's --apply and then its --rollback on it, time every step, drop it.
#
# THE COPY is the database ddc_rehearsal_copy in the new stack's Postgres (container ddcnew-db-1, compose project ddcnew,
# service db: checked by its labels). It is never (copy_guard, before every step):
#   - the database the running api uses (read from the api container's environment: host and database name only),
#   - a database named by DATABASE_URL in /root/ddcnew/.env.api, .env.rehearsal or .env.cutover,
#   - ddc, ddc_prod, ddc_rehearsal, ddc_rehearsal2, the cluster's own database (POSTGRES_DB in .env.db), postgres or a
#     template (RESERVED_DBS).
# restore creates it and marks it (COMMENT ON DATABASE, COPY_MARKER). Every later step works on it only while it carries
# that mark: each SQL session on it first proves inside Postgres that it is connected to the marked copy (COPY_GATE_SQL),
# and each one-off container proves inside itself, before its command starts, that its DATABASE_URL names
# db:5432/ddc_rehearsal_copy (GATE_JS; anything else ends the container with exit 97 and nothing runs). psql connects to
# two databases only: the copy, and the maintenance database postgres for CREATE, COMMENT, ALTER and DROP DATABASE of
# the copy (ndb). The new stack's live database is never connected to. The old stack is only read: the size of its
# database, for the disk check.
#
# SUBCOMMANDS, in this order
#   preflight [dump]      read-only. The copy's name against every protected database; the new stack healthy (db
#                         container healthy, api answers 401 on 127.0.0.1:API_PORT/partner/tge/me, INFRA_ONLY=0); whether
#                         the copy exists; the dump restore will use (the newest ddc-daily-*.dump with a .sha256 sidecar
#                         in /root/backup/pg, or <dump>): size, age, sha256; free disk against the need (below);
#                         MemAvailable; the images and the user list. No container is started and nothing is written.
#   restore [dump]        needs REHEARSAL_G8=scrub|keep (gate G8, APPROVAL.md section 7: how the copy treats the
#                         sensitive User columns; refused without it). CREATE DATABASE ddc_rehearsal_copy + its mark,
#                         then pg_restore of the dump into it (timed), then the exact row count of every table
#                         (counts-dump.txt: the dump's counts). With scrub, every non-NULL value of User.password,
#                         privateKey, xAccessToken and xRefreshToken is then replaced by a placeholder (NULL stays NULL,
#                         so mainnetSwitch's counts do not change; timed apart, not part of the window); with keep the
#                         copy holds them as the dump does.
#   migrate [image]       prisma migrate deploy on the copy (timed) in a one-off container of <image> (default: the
#                         running api's image); migrate status before and after.
#   report [image]        the copy is made read-only for the report (ALTER DATABASE ... SET default_transaction_read_only),
#                         then: exact row counts per table against the dump's; scripts/mainnetSwitch.js --plan (GO/NO-GO,
#                         and the accounts that will not re-bind automatically, by reason: counts only);
#                         scripts/backfillSocialPostIdentity.js dry run; scripts/reportDuplicateCampaignGrants.js. Each
#                         timed. Then the read-only setting is reset. <image>: default the one migrate used.
#   apply-switch [image]  mainnetSwitch --plan, --apply --yes (timed), --plan, --rollback --run <id> --yes (timed),
#                         --plan, on the copy only. Before --apply a digest of every User row without updatedAt is kept
#                         in the copy (table rehearsal_users_before); after --apply exactly the users whose old-network
#                         pair it reports cleared differ from it, after --rollback none does (updatedAt, set by Prisma's
#                         @updatedAt and not restored by --rollback, is counted apart).
#   summary               read-only: the timings of every step and the estimate of the cutover window, runbook section
#                         6 steps 1-9 (limit 180 min): each part measured here or, where the runbook gives one, at the
#                         runbook's figure. A part with neither (the off-site copy of the final dump, the points record
#                         repair) is listed as NOT MEASURED, and then no PASS is printed.
#   cleanup               DROP DATABASE ddc_rehearsal_copy WITH (FORCE) (only while it carries the mark; timed), then
#                         the records that hold user or row ids (<ts>-*.out/.err) are removed.
#   The new stack as production: once the running api uses ddc_prod (or the database .env.cutover names), restore,
#   migrate, report and apply-switch refuse; cleanup still drops a leftover copy. Run cleanup before the cutover window:
#   the copy takes about 1-1.5 x the database on the disk the window needs.
#   The one-off containers are `docker compose run --rm --no-deps -T api` of project ddcnew with the override
#   /root/ddcnew/rehearsal/compose.copy.yaml (written by this script; no secret in it), which sets only the image and
#   DATABASE_URL (= the api's DATABASE_URL from .env.api with the database name replaced by the copy's; never printed).
#   They have the api service's env file and mounts, no published port, and the name ddcnew-rehearsal-<step>-<pid>.
#   When /root/mainnet-switch/keep.txt exists it is mounted read-only and passed as --keep-wallet-ids (runbook step 6).
#
# CHANGES ON THE SERVER
#   restore, migrate, report, apply-switch, cleanup: the database ddc_rehearsal_copy only (created, written, dropped), the
#   records in /root/ddcnew/rehearsal/ (700; files 600): timings.tsv, state.env, counts-dump.txt, compose.copy.yaml and
#   per run <ts>-<step>.out/.err (the full script outputs, which hold user and row ids, never printed; removed by
#   cleanup), short-lived
#   one-off containers (removed by --rm) and one `pg_restore --list` container (restore; --network none, --rm). Each takes
#   the run lock /root/ddcnew/.lock and logs to /root/ddcnew/logs/<ts>-60-rehearsal-<step>-<pid>.log (common.sh
#   run_begin), and fingerprints the old stack (common.sh old_snapshot_begin/assert) and the new stack's api, db and web
#   containers (same ids, state, start time and restarts at the end, or FAIL).
#   preflight and summary: nothing.
# DISK: restore needs, before it starts, free space for 1.5 x the restore size (the old database's size, or 3 x the dump
#   when that cannot be read) plus what the nightly P1 dump itself requires (database size + 3G, ddc-pgdump.sh), and stops
#   the restore when the free space falls below BUILD_DISK_FLOOR_MB (3G; the live Postgres instances share the disk):
#   its session is ended inside Postgres and the partial copy dropped. Free space is the lower of / and the new
#   cluster's pgdata (when that is another file system). MemAvailable >= 2000 MB before the restore and before every
#   one-off container (they inherit the api's memory limit, and --plan/--apply load every user); free space >= the
#   nightly dump's own floor before every one-off container.
# OUTPUT: names, counts, sizes, timings, hashes and PASS/WARN/FAIL only. No e-mail, wallet, user id or secret is printed;
#   errors of pg_restore and of the scripts are shown filtered (common.sh log_safe, e-mail addresses and DETAIL lines
#   removed), and kept whole in /root/ddcnew/rehearsal/ (600).
# UNDO
#   ./60-rehearsal.sh cleanup (drops the copy and the records with ids; the timings, state and row counts stay for the
#   window plan); rm -rf /root/ddcnew/rehearsal removes the rest. 99-teardown.sh does not drop the copy (it lives in
#   pgdata): run cleanup before it.
# Usage: ./60-rehearsal.sh preflight [dump] | restore [dump] | migrate [image] | report [image] | apply-switch [image]
#        | summary | cleanup        (dump: a ddc-*.dump in /root/backup/pg; image: ddcnew/backend:<12 hex>)
#        restore also needs REHEARSAL_G8=scrub|keep in its environment (remote.sh passes it as an override).
set -euo pipefail
HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
. "$HERE/common.sh"
require_server
# Every file this script writes is a private record (600) in a private directory (700).
umask 077

COPY_DB=ddc_rehearsal_copy
COPY_MARK_PREFIX='ddcnew-rehearsal-copy:'
COPY_MARKER="$COPY_MARK_PREFIX restored by deploy/new-stack/60-rehearsal.sh, never production"
# Names the copy can never have, whatever the env files say (the old and future production databases, the earlier
# rehearsal databases of 20-env.sh and 40-up.sh, the cluster's own databases).
RESERVED_DBS="ddc ddc_prod ddc_rehearsal ddc_rehearsal2 ddcnew postgres template0 template1"
NEW_DB_CTR="$PROJECT-db-1"; NEW_API_CTR="$PROJECT-api-1"; NEW_WEB_CTR="$PROJECT-web-1"
RH_DIR="$NEW_DIR/rehearsal"
TIMINGS="$RH_DIR/timings.tsv"; STATE="$RH_DIR/state.env"; OVERRIDE="$RH_DIR/compose.copy.yaml"; COUNTS_DUMP="$RH_DIR/counts-dump.txt"
KEEP_FILE="$SWITCH_DIR/keep.txt"
IMAGE_RE='^ddcnew/backend:[0-9a-f]{12}$'
REHEARSAL_MEM_FLOOR_MB=2000
# Runbook section 6: the parts of the window this script cannot measure, at the runbook's figure in minutes (step 4:
# the upper end of 5-10; step 5: the whole step's figure, on top of the measured migrate), and the window's limit.
FREEZE_MIN=5; PUBLIC_MIN=10; CONFIG_MIN=15; SWITCH_MIN=20; SMOKE_MIN=40; OPEN_MIN=10; WINDOW_LIMIT_MIN=180
# Gate G8 (APPROVAL.md section 7): scrub = the sensitive User columns below get a placeholder after the restore (NULL
# stays NULL); keep = the copy holds them as the dump does. restore refuses without a decision.
REHEARSAL_G8="${REHEARSAL_G8:-}"
SCRUB_PLACEHOLDER=rehearsal-scrubbed
USERS_BEFORE=rehearsal_users_before
G=1073741824
RUN_TS=$(date +%Y%m%d-%H%M%S)
USAGE="usage: $0 preflight [dump] | restore [dump] | migrate [image] | report [image] | apply-switch [image] | summary | cleanup"

# ---------------------------------------------------------------------------
# Small helpers (portable: the local test runs them on macOS too)
# ---------------------------------------------------------------------------
file_bytes() { wc -c < "$1" | tr -d ' '; }
file_mtime() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1"; }
fmt_secs() { printf '%ss (%d min %02d s)' "$1" $(( $1 / 60 )) $(( $1 % 60 )); }
gb() { awk -v b="$1" 'BEGIN { printf "%.1f", b / 1073741824 }'; }
# Error output of pg_restore, prisma and the scripts, on its way to the terminal and the run log: common.sh log_safe, then
# DETAIL/STATEMENT lines (they can quote row values) and anything shaped like an e-mail address removed.
err_safe() { grep -vE '^[[:space:]]*(pg_restore: )?(DETAIL|STATEMENT|HINT|CONTEXT|Command was):' | log_safe | sed -E 's/[^[:space:]<>"(),;]+@[^[:space:]<>"(),;]+/<e-mail removed>/g'; }
# Free space in MB where the copy grows: the lower of / (the live Postgres instances and the dumps) and the new cluster's
# pgdata when it exists (another file system there would fill first). Empty when / cannot be read.
rh_disk_avail_mb() {
  local a p
  a=$(disk_avail_mb)
  case "$a" in ''|*[!0-9]*) printf '%s' "$a"; return 0;; esac
  if [ -d "$NEW_DIR/pgdata" ]; then
    p=$(df -Pk "$NEW_DIR/pgdata" 2>/dev/null | awk 'NR == 2 {print int($4 / 1024)}' || true)
    case "$p" in ''|*[!0-9]*) ;; *) if [ "$p" -lt "$a" ]; then a=$p; fi;; esac
  fi
  printf '%s' "$a"
}
g8_check() { # restore only: the G8 decision is given and is one of the two this script implements
  case "$REHEARSAL_G8" in
    scrub|keep) ;;
    "") die "gate G8 is not decided for this restore (APPROVAL.md section 7): pass REHEARSAL_G8=scrub (the sensitive User columns get a placeholder after the restore) or REHEARSAL_G8=keep (the copy holds them as the dump does)";;
    *) die "REHEARSAL_G8 must be scrub or keep, not '$REHEARSAL_G8'";;
  esac
}

rh_dir_init() {
  guard_write_path "$RH_DIR"
  ( umask 077; install -d -m 700 "$RH_DIR" ) || die "cannot create $RH_DIR"
}
# timings.tsv: one line per measured step: <step> TAB <seconds> TAB <ISO time> TAB <note>; summary reads the latest.
timing_add() { # <step> <seconds> [note]
  guard_write_path "$TIMINGS"
  ( umask 077; printf '%s\t%s\t%s\t%s\n' "$1" "$2" "$(date '+%Y-%m-%dT%H:%M:%S%z')" "${3:-}" >> "$TIMINGS" ) || die "cannot write $TIMINGS"
  pass "time: $1 $(fmt_secs "$2")${3:+ ($3)}"
}
state_get() { if [ -f "$STATE" ]; then sed -n "s/^$1=//p" "$STATE" | tail -n 1; fi; }
state_set() { # <NAME> <value>: the record is written whole to a temporary file and renamed
  [[ "$2" =~ ^[A-Za-z0-9._:/+-]*$ ]] || die "state_set: bad value for $1"
  guard_write_path "$STATE"; guard_write_path "$STATE.tmp"
  ( umask 077; { if [ -f "$STATE" ]; then grep -v "^$1=" "$STATE" || true; fi; printf '%s=%s\n' "$1" "$2"; } > "$STATE.tmp" ) \
    && mv -f "$STATE.tmp" "$STATE" || die "cannot write $STATE"
}

# ---------------------------------------------------------------------------
# The databases: which ones are protected, the copy's state, SQL sessions (ndb), the gates
# ---------------------------------------------------------------------------
# The database the running api uses: "<host> <name>" from its environment (no user, no password, no connection).
api_live_db() {
  docker exec "$NEW_API_CTR" node -e 'const u = new URL(process.env.DATABASE_URL || "x:"); console.log(u.hostname + " " + decodeURIComponent(u.pathname.replace(/^\//, "")))' 2>/dev/null || true
}
env_db_name() { # <env file>: the database name in its DATABASE_URL (nothing when the file or the name is absent)
  local u
  [ -f "$1" ] || return 0
  u=$(env_get_simple DATABASE_URL "$1"); u="${u%%\?*}"
  [ -n "$u" ] || return 0
  printf '%s' "${u##*/}"
}
LIVE_HOST=""; LIVE_DB=""; PROTECTED=""; PROT_WHY=""; CUTOVER_DB=""
# Sets LIVE_HOST, LIVE_DB and PROTECTED (every name the copy must never have). Returns 1 with PROT_WHY when the running
# api's database cannot be read or is not on this stack's Postgres: fail closed.
protected_read() {
  local live n f
  live=$(api_live_db)
  [[ "$live" =~ ^[a-z0-9.-]+\ [A-Za-z0-9_]+$ ]] || { PROT_WHY="cannot read which database the running api ($NEW_API_CTR) uses: the copy's name cannot be checked against it (is the api running?)"; return 1; }
  LIVE_HOST="${live%% *}"; LIVE_DB="${live#* }"
  [ "$LIVE_HOST" = db ] || { PROT_WHY="the running api ($NEW_API_CTR) uses a database on host $LIVE_HOST, not this stack's db: stop and check its env before any rehearsal"; return 1; }
  PROTECTED="$RESERVED_DBS $LIVE_DB"
  CUTOVER_DB=$(env_db_name "$NEW_DIR/.env.cutover")
  for f in .env.api .env.rehearsal .env.cutover; do n=$(env_db_name "$NEW_DIR/$f"); PROTECTED="$PROTECTED $n"; done
  [ ! -f "$NEW_DIR/.env.db" ] || PROTECTED="$PROTECTED $(env_get_simple POSTGRES_DB "$NEW_DIR/.env.db")"
  # shellcheck disable=SC2086  # word splitting of the name list is intended
  PROTECTED=$(printf '%s\n' $PROTECTED | LC_ALL=C sort -u | tr '\n' ' ' | sed 's/ $//')
}
COPY_WHY=""
copy_name_ok() { # the copy's name: this script's fixed name, and none of the protected databases
  [ "$COPY_DB" = ddc_rehearsal_copy ] || { COPY_WHY="the copy must be ddc_rehearsal_copy, not $COPY_DB"; return 1; }
  ( guard_db_name "$COPY_DB" ) >/dev/null 2>&1 || { COPY_WHY="common.sh guard_db_name refuses $COPY_DB"; return 1; }
  case " $PROTECTED " in *" $COPY_DB "*) COPY_WHY="refusing: the copy's name $COPY_DB is a protected database (the running api's, an env file's or a reserved one: $PROTECTED)"; return 1;; esac
}
copy_guard() {
  protected_read || die "$PROT_WHY"
  copy_name_ok || die "$COPY_WHY"
  pass "the copy $COPY_DB is none of the protected databases ($PROTECTED); the running api uses $LIVE_DB"
}
# After protected_read: the new stack serves production once its api uses ddc_prod or the database .env.cutover names.
live_is_production() { [ "$LIVE_DB" = ddc_prod ] || { [ -n "$CUTOVER_DB" ] && [ "$LIVE_DB" = "$CUTOVER_DB" ]; }; }
prod_why() { printf 'the running api uses %s: the new stack is production now. No rehearsal runs next to it (the disk, memory and IO belong to production); ./60-rehearsal.sh cleanup drops a leftover copy' "$LIVE_DB"; }
refuse_if_production() { if live_is_production; then die "$(prod_why)"; fi; }   # restore, migrate, report, apply-switch
# The new stack's Postgres container: this project's db service, running and healthy. Sets NEW_WHY.
NEW_WHY=""
new_db_ok() {
  local l h
  l=$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}/{{index .Config.Labels "com.docker.compose.service"}}' "$NEW_DB_CTR" 2>/dev/null || true)
  [ "$l" = "$PROJECT/db" ] || { NEW_WHY="$NEW_DB_CTR is not the $PROJECT project's db service (labels: ${l:-none})"; return 1; }
  h=$(docker inspect --format '{{.State.Health.Status}}' "$NEW_DB_CTR" 2>/dev/null || true)
  [ "$h" = healthy ] || { NEW_WHY="$NEW_DB_CTR is ${h:-not running}, not healthy"; return 1; }
}
new_api_ok() {
  local c
  c=$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://127.0.0.1:$API_PORT/partner/tge/me" || true)
  [ "$c" = 401 ] || { NEW_WHY="the api on 127.0.0.1:$API_PORT answers ${c:-nothing} for /partner/tge/me, not 401"; return 1; }
}
# One psql session in the new stack's Postgres on <database>, the SQL on stdin, tuples only, stopping at the first
# error. Only two databases are ever connected to: the maintenance database postgres and the copy.
ndb() {
  case "$1" in postgres|"$COPY_DB") ;; *) die "ndb: refusing to connect to database $1 (only postgres and $COPY_DB)";; esac
  docker exec -i "$NEW_DB_CTR" sh -c 'exec psql -X -q -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$0" -tA' "$1"
}
# First statement of every session on the copy: it must be connected to the copy, and the copy must carry the mark.
COPY_GATE_SQL="DO \$gate\$ BEGIN IF current_database() <> '$COPY_DB' OR coalesce(shobj_description((SELECT oid FROM pg_database WHERE datname = current_database()), 'pg_database'), '') NOT LIKE '$COPY_MARK_PREFIX%' THEN RAISE EXCEPTION 'refusing: this session is not on the marked rehearsal copy'; END IF; END \$gate\$;"
copy_sql() { { printf '%s\n' "$COPY_GATE_SQL"; cat; } | ndb "$COPY_DB"; }
# First statement of every maintenance session that changes the copy (ALTER or DROP DATABASE): the copy carries the mark.
mark_check_sql() {
  printf "DO \$gate\$ BEGIN IF coalesce(shobj_description((SELECT oid FROM pg_database WHERE datname = '%s'), 'pg_database'), '') NOT LIKE '%s%%' THEN RAISE EXCEPTION 'refusing: %s does not carry the rehearsal mark'; END IF; END \$gate\$;\n" \
    "$COPY_DB" "$COPY_MARK_PREFIX" "$COPY_DB"
}
copy_state() { # absent | marked | foreign (exists without this script's mark)
  local c
  c=$(printf "SELECT 'db:' || coalesce(shobj_description(oid, 'pg_database'), '') FROM pg_database WHERE datname = '%s';\n" "$COPY_DB" | ndb postgres) \
    || die "cannot query the new stack's Postgres ($NEW_DB_CTR)"
  case "$c" in "") echo absent;; "db:$COPY_MARK_PREFIX"*) echo marked;; *) echo foreign;; esac
}
copy_require_marked() {
  local st; st=$(copy_state) || exit 1   # copy_state printed why it could not ask Postgres
  case "$st" in
    marked) pass "$COPY_DB exists and carries this script's mark";;
    absent) die "$COPY_DB does not exist: run ./60-rehearsal.sh restore first";;
    *) die "$COPY_DB exists WITHOUT this script's mark: 60-rehearsal.sh did not create it, so it touches nothing in it (ask the team whose it is)";;
  esac
}
copy_readonly() { # on|off: default_transaction_read_only for every new session on the copy
  { mark_check_sql
    case "$1" in
      on) printf 'ALTER DATABASE "%s" SET default_transaction_read_only = on;\n' "$COPY_DB";;
      *) printf 'ALTER DATABASE "%s" RESET default_transaction_read_only;\n' "$COPY_DB";;
    esac; } | ndb postgres
}
copy_terminate() { printf "SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE datname = '%s' AND pid <> pg_backend_pid();\n" "$COPY_DB" | ndb postgres; }
copy_drop() { { mark_check_sql; printf 'DROP DATABASE "%s" WITH (FORCE);\n' "$COPY_DB"; } | ndb postgres; }
# Exact row count of every table of the copy: "<table> <rows>" per line, sorted (runbook section 6 step 2).
COUNTS_SQL="SELECT table_name || ' ' || (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', table_schema, table_name), false, true, '')))[1]::text FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name;"
copy_counts() { printf '%s\n' "$COUNTS_SQL" | copy_sql; }
# Every User row before mainnetSwitch --apply, kept in the copy as id + md5 of the row without updatedAt + updatedAt
# (DROP + CREATE TABLE rehearsal_users_before). Prints the number of users kept.
users_snapshot() {
  copy_sql <<SQL
DROP TABLE IF EXISTS $USERS_BEFORE;
CREATE TABLE $USERS_BEFORE AS SELECT id, md5((to_jsonb(u) - 'updatedAt')::text) AS h, to_jsonb(u) ->> 'updatedAt' AS t FROM "User" u;
SELECT count(*) FROM $USERS_BEFORE;
SQL
}
# The users now against that snapshot: "<changed> <updatedAt only>". changed = users added, removed, or different in any
# column but updatedAt; updatedAt only = users equal in every other column whose updatedAt differs.
users_diff() {
  copy_sql <<SQL
SELECT count(*) FILTER (WHERE u.id IS NULL OR b.id IS NULL OR md5((to_jsonb(u) - 'updatedAt')::text) <> b.h) || ' ' || count(*) FILTER (WHERE u.id IS NOT NULL AND b.id IS NOT NULL AND md5((to_jsonb(u) - 'updatedAt')::text) = b.h AND (to_jsonb(u) ->> 'updatedAt') IS DISTINCT FROM b.t) FROM "User" u FULL JOIN $USERS_BEFORE b ON b.id = u.id;
SQL
}
users_snapshot_drop() { copy_sql <<< "DROP TABLE $USERS_BEFORE;"; }
# Gate G8 = scrub: every non-NULL value of the sensitive User columns becomes the placeholder, in one transaction.
# Prints "before <n n n n>", "after <n n n n>" (non-NULL values per column) and "left <rows with an original value>".
SCRUB_SQL="BEGIN;
SELECT 'before ' || count(\"password\") || ' ' || count(\"privateKey\") || ' ' || count(\"xAccessToken\") || ' ' || count(\"xRefreshToken\") FROM \"User\";
UPDATE \"User\" SET \"password\" = CASE WHEN \"password\" IS NULL THEN NULL ELSE '$SCRUB_PLACEHOLDER' END, \"privateKey\" = CASE WHEN \"privateKey\" IS NULL THEN NULL ELSE '$SCRUB_PLACEHOLDER' END, \"xAccessToken\" = CASE WHEN \"xAccessToken\" IS NULL THEN NULL ELSE '$SCRUB_PLACEHOLDER' END, \"xRefreshToken\" = CASE WHEN \"xRefreshToken\" IS NULL THEN NULL ELSE '$SCRUB_PLACEHOLDER' END WHERE \"password\" IS NOT NULL OR \"privateKey\" IS NOT NULL OR \"xAccessToken\" IS NOT NULL OR \"xRefreshToken\" IS NOT NULL;
SELECT 'after ' || count(\"password\") || ' ' || count(\"privateKey\") || ' ' || count(\"xAccessToken\") || ' ' || count(\"xRefreshToken\") FROM \"User\";
SELECT 'left ' || count(*) FROM \"User\" WHERE \"password\" <> '$SCRUB_PLACEHOLDER' OR \"privateKey\" <> '$SCRUB_PLACEHOLDER' OR \"xAccessToken\" <> '$SCRUB_PLACEHOLDER' OR \"xRefreshToken\" <> '$SCRUB_PLACEHOLDER';
COMMIT;"
copy_scrub() { printf '%s\n' "$SCRUB_SQL" | copy_sql; }
rebind_tables() { copy_sql <<< "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('Web3AuthNetworkRebind', 'Web3AuthNetworkRebindRun');"; }

# ---------------------------------------------------------------------------
# The dump (P1): which one, and whether it is intact
# ---------------------------------------------------------------------------
dump_arg_check() { # <path>: a P1 dump in $BACKUP_DIR/pg named ddc-<label>-<ts>.dump, a regular file, not a link
  local r b
  [ -f "$1" ] && [ ! -L "$1" ] || die "dump $1 is not a regular file"
  r=$(resolve_path "$1"); b=$(basename "$r")
  [ "$(dirname "$r")" = "$(resolve_path "$BACKUP_DIR/pg")" ] || die "dump $1 is not in $BACKUP_DIR/pg (P1 dumps only)"
  [[ "$b" =~ ^ddc-[a-z0-9-]+\.dump$ ]] || die "dump $b is not named ddc-<label>-<ts>.dump (P1)"
}
# The newest ddc-daily-*.dump that has its .sha256 sidecar (the nightly script writes it right after the dump; a dump
# without one was interrupted). Empty when there is none.
latest_daily() {
  local f best="" bt=0 t
  for f in "$BACKUP_DIR"/pg/ddc-daily-*.dump; do
    [ -f "$f" ] && [ ! -L "$f" ] && [ -f "$f.sha256" ] || continue
    t=$(file_mtime "$f"); if [ "$t" -gt "$bt" ]; then bt=$t; best=$f; fi
  done
  printf '%s' "$best"
}
dump_pick() { # [argument]: prints the dump to use
  if [ -n "${1:-}" ]; then printf '%s' "$1"; return 0; fi
  latest_daily
}
dump_sha_ok() { # <dump>: its .sha256 sidecar names it and matches it
  local line want
  [ -f "$1.sha256" ] || return 1
  line=$(head -n 1 "$1.sha256"); want="${line%% *}"
  [ "${line#*  }" = "$(basename "$1")" ] && [[ "$want" =~ ^[0-9a-f]{64}$ ]] && [ "$(sha256 < "$1")" = "$want" ]
}
# Seconds the dump took, estimated from its name (the start, to the minute) and its modification time (the end).
dump_est_seconds() {
  python3 - "$1" <<'PY' 2>/dev/null || true
import datetime, os, re, sys
f = sys.argv[1]
m = re.search(r"-(\d{8})-(\d{4})(\d{2})?\.dump$", os.path.basename(f))
if m:
    start = datetime.datetime.strptime(m.group(1) + m.group(2) + (m.group(3) or "00"), "%Y%m%d%H%M%S")
    s = int(os.path.getmtime(f) - start.timestamp())
    if 0 <= s < 86400:
        print(s)
PY
}
old_db_bytes() {
  docker exec "$OLD_DB_CTR" sh -c 'psql -U "$POSTGRES_USER" -d "$0" -tAc "SELECT pg_database_size(current_database())"' "$OLD_DB_NAME" 2>/dev/null | tr -dc '0-9' || true
}
# Free space the restore needs: 1.5 x the restore size (indexes, WAL) plus what the nightly P1 dump requires itself
# (database size + 3G: ddc-pgdump.sh skips below it). Sets NEED_BYTES and NEED_TEXT.
NEED_BYTES=0; NEED_TEXT=""
disk_need() { # <old database bytes or empty> <dump bytes>
  local rest src nightly
  if [ -n "$1" ] && [ "$1" -gt 0 ]; then rest="$1"; src="the old database's size"
  else rest=$(( $2 * 3 )); src="3 x the dump (the old database's size could not be read)"; fi
  nightly=$(( rest + 3 * G ))
  NEED_BYTES=$(( rest * 3 / 2 + nightly ))
  NEED_TEXT="need $(gb "$NEED_BYTES")G = copy 1.5 x $(gb "$rest")G ($src) + the nightly P1 dump's own floor $(gb "$nightly")G (database size + 3G)"
}

# ---------------------------------------------------------------------------
# Images and the one-off containers on the copy
# ---------------------------------------------------------------------------
image_check_name() { [[ "$1" =~ $IMAGE_RE ]] || die "image '$1' is not ddcnew/backend:<12 hex> (a 10-build.sh image; an -infra image never gets production data)"; }
running_api_image() { docker inspect --format '{{.Config.Image}}' "$NEW_API_CTR" 2>/dev/null || true; }
IMAGE=""
resolve_image() { # <argument or empty> <migrate|other>: sets IMAGE; dies unless it is a ddcnew/backend:<12 hex> image on this host
  local src rec
  rec=$(state_get IMAGE)
  if [ -n "$1" ]; then IMAGE="$1"; src="argument"
  elif [ "$2" != migrate ] && [ -n "$rec" ]; then IMAGE="$rec"; src="the one migrate used"
  else IMAGE=$(running_api_image); src="the running api's"; fi
  image_check_name "$IMAGE"
  docker image inspect "$IMAGE" >/dev/null 2>&1 || die "image $IMAGE is not on this host (nothing is pulled: build it with 10-build.sh first)"
  say "image: $IMAGE ($src)"
  if [ "$2" != migrate ] && [ -n "$rec" ] && [ "$rec" != "$IMAGE" ]; then warn "the copy was migrated with $rec, this step runs $IMAGE"; fi
}
# The api's DATABASE_URL (.env.api) with the database name replaced by the copy's. Printed to the caller's variable only.
copy_url() {
  local u
  u=$(env_get_simple DATABASE_URL "$NEW_DIR/.env.api")
  [ -n "$u" ] || die "no DATABASE_URL in $NEW_DIR/.env.api"
  printf '%s' "$u" | COPY_DB="$COPY_DB" python3 -c '
import os, sys, urllib.parse as up
u = up.urlsplit(sys.stdin.read())
if u.scheme not in ("postgres", "postgresql") or u.hostname != "db" or (u.port or 5432) != 5432: sys.exit(3)
if up.parse_qs(u.query).get("schema", ["public"]) != ["public"]: sys.exit(4)
sys.stdout.write(up.urlunsplit((u.scheme, u.netloc, "/" + os.environ["COPY_DB"], u.query, "")))' \
    || die "DATABASE_URL in $NEW_DIR/.env.api is not postgresql://...@db:5432/<database>?schema=public: no one-off container is pointed at the copy"
}
override_write() {
  guard_write_path "$OVERRIDE"
  ( umask 077; cat > "$OVERRIDE" <<'EOF'
# Written by deploy/new-stack/60-rehearsal.sh for its own one-off containers only (docker compose run --rm --no-deps api):
# the image and DATABASE_URL of the rehearsal copy, both set by the script for each call. Never used by `up`. No secret
# here: the values come from the script's environment.
services:
  api:
    image: ${REHEARSAL_IMAGE:?60-rehearsal.sh sets it}
    environment:
      DATABASE_URL: ${REHEARSAL_DATABASE_URL:?60-rehearsal.sh sets it}
      REHEARSAL_EXPECT_DB: ${REHEARSAL_EXPECT_DB:?60-rehearsal.sh sets it}
EOF
  ) || die "cannot write $OVERRIDE"
}
# The gate each one-off container runs before its command: it prints where DATABASE_URL points (host, port, database,
# schema; never the user or password) and exits 97, so that the command never starts, unless that is db:5432/<the copy>.
GATE_JS='const u = new URL(process.env.DATABASE_URL || "x:"); const s = u.searchParams.get("schema") || "public";
console.log("db_target=" + u.hostname + ":" + (u.port || "5432") + u.pathname + " schema=" + s);
if (u.hostname !== "db" || (u.port || "5432") !== "5432" || decodeURIComponent(u.pathname) !== "/" + process.env.REHEARSAL_EXPECT_DB || s !== "public") process.exit(97);'
GATE_LINE="db_target=db:5432/$COPY_DB schema=public"
COPY_URL=""; CX_VOLS=(); CX_KEEP=()
cx_prepare() { # memory and disk, the copy's URL, the override, keep.txt
  local n mem d dbb floor
  # A one-off container inherits the api's mem_limit and oom_score_adj (the same as the live new-stack containers), and
  # mainnetSwitch --plan/--apply load every user: the same memory floor as the restore. Free space at least the nightly
  # P1 dump's own floor (migrate's index builds and --apply's backup table grow the copy; nothing watches them).
  mem=$(mem_avail_mb); case "$mem" in ''|*[!0-9]*) die "cannot read MemAvailable: no one-off container started";; esac
  [ "$mem" -ge "$REHEARSAL_MEM_FLOOR_MB" ] || die "MemAvailable ${mem}MB < ${REHEARSAL_MEM_FLOOR_MB}MB: no one-off container started (it inherits the api's memory limit, and the host has no swap)"
  d=$(rh_disk_avail_mb); case "$d" in ''|*[!0-9]*) die "cannot read the free disk space on /: no one-off container started";; esac
  dbb=$(old_db_bytes)
  if [ -z "$dbb" ] || [ "$dbb" = 0 ]; then dbb=$(state_get DUMP_BYTES | tr -dc '0-9'); dbb=$(( ${dbb:-0} * 3 )); fi   # as disk_need
  floor=$(( dbb + 3 * G ))
  [ $(( d * 1048576 )) -ge "$floor" ] || die "free disk $(gb $(( d * 1048576 )))G < the nightly P1 dump's own floor $(gb "$floor")G (database size + 3G): no one-off container started (free space, or ./60-rehearsal.sh cleanup)"
  pass "MemAvailable ${mem}MB >= ${REHEARSAL_MEM_FLOOR_MB}MB; free disk $(gb $(( d * 1048576 )))G >= the nightly P1 dump's own floor $(gb "$floor")G"
  COPY_URL=$(copy_url)
  override_write
  if [ -f "$KEEP_FILE" ] && [ ! -L "$KEEP_FILE" ]; then
    n=$(grep -cvE '^[[:space:]]*(#|$)' "$KEEP_FILE" || true)
    CX_VOLS=(-v "$KEEP_FILE:/tmp/keep.txt:ro"); CX_KEEP=(--keep-wallet-ids /tmp/keep.txt)
    say "keep.txt: $n user id(s), passed to mainnetSwitch as --keep-wallet-ids (mounted read-only)"
  else
    say "no $KEEP_FILE: mainnetSwitch runs without --keep-wallet-ids (runbook: the list is settled before the window)"
  fi
}
CX_OUT=""; CX_ERR=""; CX_RC=0
# One one-off container on the copy: <step label> <command...>. Its stdout (gate line removed) goes to CX_OUT, its stderr
# to CX_ERR (both 600 in the records), its exit status to CX_RC. Dies when the gate refused or the container did not start.
copy_exec() {
  local label="$1" first
  shift
  CX_OUT="$RH_DIR/$RUN_TS-$label.out"; CX_ERR="$RH_DIR/$RUN_TS-$label.err"; CX_RC=0
  guard_write_path "$CX_OUT"; guard_write_path "$CX_ERR"
  ( umask 077
    REHEARSAL_IMAGE="$IMAGE" REHEARSAL_DATABASE_URL="$COPY_URL" REHEARSAL_EXPECT_DB="$COPY_DB" API_PORT="$API_PORT" WEB_PORT="$WEB_PORT" DB_PORT="$DB_PORT" \
      docker compose -p "$PROJECT" --project-directory "$NEW_DIR" -f "$NEW_DIR/compose.yaml" -f "$OVERRIDE" \
      run --rm --no-deps -T --name "$PROJECT-rehearsal-$label-$$" ${CX_VOLS[@]+"${CX_VOLS[@]}"} api \
      sh -c 'node -e "$1" || exit 97; shift; exec "$@"' rehearsal-gate "$GATE_JS" "$@" > "$CX_OUT" 2> "$CX_ERR" ) || CX_RC=$?
  first=$(head -n 1 "$CX_OUT" 2>/dev/null || true)
  if [ "$CX_RC" = 97 ] || { [ -n "$first" ] && [ "$first" != "$GATE_LINE" ]; }; then
    die "the one-off container for '$label' does not point at the copy (its gate printed '${first:-nothing}', exit $CX_RC): its command did not run"
  fi
  if [ -z "$first" ]; then
    { tail -n 5 "$CX_ERR" | err_safe; } || true
    die "the one-off container for '$label' did not start (exit $CX_RC; filtered stderr above, whole in $CX_ERR)"
  fi
  tail -n +2 "$CX_OUT" > "$CX_OUT.tmp" && mv -f "$CX_OUT.tmp" "$CX_OUT"
}
cx_fail() { # <what>: the filtered tail of the last one-off container's stderr, then FAIL
  { tail -n 8 "$CX_ERR" | err_safe; } || true
  die "$1 (exit $CX_RC; filtered stderr above, the whole output in $CX_OUT and $CX_ERR)"
}

# ---------------------------------------------------------------------------
# Integrity of both stacks around every write run
# ---------------------------------------------------------------------------
new_snapshot() {
  local c
  for c in "$NEW_API_CTR" "$NEW_DB_CTR" "$NEW_WEB_CTR"; do
    docker inspect --format '{{.Name}}|{{.Id}}|{{.State.Status}}|{{.State.StartedAt}}|{{.RestartCount}}' "$c" 2>/dev/null || printf '/%s|absent\n' "$c"
  done
}
NEW_SNAP_BEFORE=""
integrity_begin() {
  old_snapshot_begin
  NEW_SNAP_BEFORE=$(new_snapshot)
  say "new-stack containers: $(printf '%s\n' "$NEW_SNAP_BEFORE" | cut -d'|' -f1,3 | tr '\n' ' ')(snapshot $(printf '%s' "$NEW_SNAP_BEFORE" | sha256 | cut -c1-12))"
}
integrity_end() {
  local now
  now=$(new_snapshot)
  if [ "$now" = "$NEW_SNAP_BEFORE" ]; then pass "new-stack containers unchanged (api, db, web: same ids, state, start time, restarts): this run restarted none"
  else
    printf 'new-stack container snapshot diff (names/state/start/restarts):\n'
    diff <(printf '%s\n' "$NEW_SNAP_BEFORE" | cut -d'|' -f1,3,4,5) <(printf '%s\n' "$now" | cut -d'|' -f1,3,4,5) || true
    ( old_snapshot_assert ) || true
    die "the new stack's containers changed during this run (a restart by a teammate also triggers this: check who restarted what before assuming this script did)"
  fi
  old_snapshot_assert
}

# ---------------------------------------------------------------------------
# Subcommands
# ---------------------------------------------------------------------------
do_preflight() {
  local fails=0 warns=0 st f b dbb now age est avail mem imgs
  pf_fail() { printf 'FAIL %s\n' "$*"; fails=$((fails + 1)); }
  pf_warn() { warn "$*"; warns=$((warns + 1)); }
  settings_say
  step "1. the new stack and the databases the copy must never be"
  if new_db_ok; then pass "$NEW_DB_CTR is the $PROJECT project's db service and healthy"; else pf_fail "$NEW_WHY"; fi
  if new_api_ok; then pass "the api answers 401 on 127.0.0.1:$API_PORT/partner/tge/me"; else pf_fail "$NEW_WHY"; fi
  if ( refuse_if_infra_only ) >/dev/null 2>&1; then pass "INFRA_ONLY=0 in $NEW_DIR/.env: the stack's image may hold production data"
  else pf_fail "$( ( refuse_if_infra_only ) 2>&1 | sed 's/^FAIL //' | head -n 1 )"; fi
  say "running api image: $(running_api_image)"
  if protected_read; then
    say "the running api uses $LIVE_HOST:5432/$LIVE_DB; protected databases: $PROTECTED"
    if copy_name_ok; then pass "the copy $COPY_DB is none of the protected databases"; else pf_fail "$COPY_WHY"; fi
    if live_is_production; then pf_fail "$(prod_why)"; fi
  else pf_fail "$PROT_WHY"; fi
  case "$REHEARSAL_G8" in
    scrub) pass "gate G8: REHEARSAL_G8=scrub (restore replaces the sensitive User columns' values by a placeholder)";;
    keep) pf_warn "gate G8: REHEARSAL_G8=keep: the copy will hold the sensitive User columns as the dump does";;
    "") pf_warn "gate G8 not given: restore needs REHEARSAL_G8=scrub or REHEARSAL_G8=keep (APPROVAL.md section 7)";;
    *) pf_fail "REHEARSAL_G8 must be scrub or keep, not '$REHEARSAL_G8'";;
  esac
  if new_db_ok; then
    if st=$( ( copy_state ) 2>&1 ); then
      case "$st" in
        absent) pass "$COPY_DB does not exist yet: restore can create it";;
        marked) pf_warn "$COPY_DB exists (restored earlier): restore refuses until cleanup; migrate, report and apply-switch use it. Drop it with cleanup before the cutover window (it takes the disk the window needs)";;
        *) pf_fail "$COPY_DB exists WITHOUT this script's mark: nothing here touches it (ask the team whose it is)";;
      esac
    else pf_fail "${st#FAIL }"; fi
    say "databases in the new cluster: $(printf "SELECT string_agg(datname || '=' || pg_size_pretty(pg_database_size(datname)), ' ' ORDER BY datname) FROM pg_database WHERE NOT datistemplate;\n" | ndb postgres 2>/dev/null || echo '?')"
  fi
  step "2. the dump (P1)"
  f=$(dump_pick "${1:-}")
  if [ -z "$f" ]; then pf_fail "no ddc-daily-*.dump with its .sha256 in $BACKUP_DIR/pg (p1-backup.sh install-cron; or pass a dump)"; b=0
  else
    b=$(file_bytes "$f"); now=$(date +%s); age=$(( (now - $(file_mtime "$f")) / 3600 ))
    say "dump: $(basename "$f") size_mb=$(( b / 1048576 )) age_h=$age"
    [ "$age" -le 26 ] || pf_warn "the dump is ${age}h old: the nightly dump did not run or failed (p1-backup.sh status); the rehearsal would use older data"
    if dump_sha_ok "$f"; then pass "sha256 matches $(basename "$f").sha256"; else pf_fail "sha256 of $(basename "$f") does not match its .sha256 sidecar (or the sidecar is missing or malformed)"; fi
    est=$(dump_est_seconds "$f"); [ -z "$est" ] || say "dump time (from its name and modification time, to the minute): $(fmt_secs "$est")"
  fi
  step "3. disk and memory"
  dbb=$(old_db_bytes)
  say "old database size: $([ -n "$dbb" ] && echo "$(gb "$dbb")G" || echo 'unreadable')"
  disk_need "$dbb" "$b"
  avail=$(rh_disk_avail_mb)
  case "$avail" in ''|*[!0-9]*) pf_fail "cannot read the free disk space on /";;
    *) if [ $(( avail * 1048576 )) -ge "$NEED_BYTES" ]; then pass "free disk $(gb $(( avail * 1048576 )))G >= $NEED_TEXT"
       else pf_fail "free disk $(gb $(( avail * 1048576 )))G < $NEED_TEXT: expand the disk first (APPROVAL.md section 3)"; fi;;
  esac
  mem=$(mem_avail_mb)
  case "$mem" in ''|*[!0-9]*) pf_fail "cannot read MemAvailable";;
    *) if [ "$mem" -ge "$REHEARSAL_MEM_FLOOR_MB" ]; then pass "MemAvailable ${mem}MB >= ${REHEARSAL_MEM_FLOOR_MB}MB"; else pf_fail "MemAvailable ${mem}MB < ${REHEARSAL_MEM_FLOOR_MB}MB"; fi;;
  esac
  step "4. images, the user list and earlier records"
  imgs=$(docker image ls --format '{{.Repository}}:{{.Tag}}' 2>/dev/null | { grep -E '^ddcnew/backend:' || true; } | LC_ALL=C sort | tr '\n' ' ')
  say "ddcnew/backend images here: ${imgs:-none} (migrate takes one as its argument; default the running api's)"
  if [ -f "$KEEP_FILE" ]; then say "keep.txt: $(grep -cvE '^[[:space:]]*(#|$)' "$KEEP_FILE" || true) user id(s)"; else say "no $KEEP_FILE (mainnetSwitch then runs without --keep-wallet-ids)"; fi
  if [ -f "$TIMINGS" ]; then say "earlier timings: $(grep -c . "$TIMINGS" || true) line(s) in $TIMINGS (./60-rehearsal.sh summary)"; fi
  [ "$fails" = 0 ] || die "REHEARSAL PREFLIGHT FAIL: $fails check(s) failed, $warns warning(s)"
  pass "REHEARSAL PREFLIGHT PASS ($warns warning(s))"
}

RESTORE_DONE=0; RESTORE_STOP=""; RESTORE_DMIN=""
restore_abort() { # EXIT trap of restore: a restore that did not complete leaves no partial copy behind
  [ "$RESTORE_DONE" = 0 ] || return 0
  if [ "$( ( copy_state ) 2>/dev/null )" = marked ]; then
    if ( ( copy_terminate; copy_drop ) >/dev/null 2>&1 ); then say "the partial copy $COPY_DB (created by this run) was dropped"
    else warn "could not drop the partial copy $COPY_DB: run ./60-rehearsal.sh cleanup"; fi
  fi
}
# pg_restore of <dump> into the copy, while the free space (rh_disk_avail_mb: / and pgdata) stays above
# BUILD_DISK_FLOOR_MB. A stop ends the restore's session inside Postgres (the docker exec client alone would leave it
# running) and sets RESTORE_STOP.
restore_watched() {
  local pid d rc=0
  docker exec -i "$NEW_DB_CTR" sh -c 'exec pg_restore -U "$POSTGRES_USER" -d "$0" --no-owner --no-acl --exit-on-error' "$COPY_DB" \
    < "$1" > "$RH_DIR/$RUN_TS-restore.err" 2>&1 &
  pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    d=$(rh_disk_avail_mb)
    case "$d" in ''|*[!0-9]*) RESTORE_STOP="free disk on / unreadable"; break;; esac
    if [ -z "$RESTORE_DMIN" ] || [ "$d" -lt "$RESTORE_DMIN" ]; then RESTORE_DMIN=$d; fi
    if [ "$d" -lt "$BUILD_DISK_FLOOR_MB" ]; then RESTORE_STOP="free disk (/ and pgdata) ${d}MB < ${BUILD_DISK_FLOOR_MB}MB"; break; fi
    sleep "$BUILD_WATCH_INTERVAL"
  done
  if [ -n "$RESTORE_STOP" ]; then
    copy_terminate >/dev/null 2>&1 || true
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
    return 1
  fi
  wait "$pid" || rc=$?
  return "$rc"
}
do_restore() {
  local f b dbb avail mem toc rc t0 t1 est n rows users sha_s sc
  local -a a_before=() a_after=()
  g8_check
  refuse_if_infra_only
  new_db_ok || die "$NEW_WHY"
  copy_guard
  refuse_if_production
  local st; st=$(copy_state) || exit 1   # copy_state printed why it could not ask Postgres
  case "$st" in
    absent) ;;
    marked) die "$COPY_DB already exists (an earlier restore): run ./60-rehearsal.sh cleanup first, then restore";;
    *) die "$COPY_DB exists WITHOUT this script's mark: 60-rehearsal.sh did not create it and touches nothing in it (ask the team whose it is)";;
  esac
  step "1. the dump"
  f=$(dump_pick "${1:-}")
  [ -n "$f" ] || die "no ddc-daily-*.dump with its .sha256 in $BACKUP_DIR/pg: pass a dump (./60-rehearsal.sh restore $BACKUP_DIR/pg/<file>)"
  b=$(file_bytes "$f")
  say "dump: $(basename "$f") size_mb=$(( b / 1048576 )) age_h=$(( ($(date +%s) - $(file_mtime "$f")) / 3600 ))"
  t0=$(date +%s)
  dump_sha_ok "$f" || die "sha256 of $(basename "$f") does not match its .sha256 sidecar (or the sidecar is missing or malformed): not restoring it"
  t1=$(date +%s); sha_s=$((t1 - t0))
  pass "sha256 matches (the sidecar is what proves the dump complete)"
  rc=0; toc=$(docker run --rm -i --pull never --network none --name "$PROJECT-rehearsal-toc-$$" postgres:17 pg_restore --list < "$f") || rc=$?
  [ "$rc" = 0 ] || die "pg_restore --list failed (exit $rc): the dump's table of contents cannot be read (not a custom-format dump, or damaged)"
  n=$(printf '%s\n' "$toc" | grep -cv '^;' || true)
  grep -qE ' TABLE DATA public "?User"? ' <<< "$toc" || die "the dump's table of contents has no data for the User table: not a complete P1 dump"
  toc=""
  pass "pg_restore --list ok: $n entries, with the User table's data"
  step "2. disk and memory"
  dbb=$(old_db_bytes); disk_need "$dbb" "$b"
  avail=$(rh_disk_avail_mb); case "$avail" in ''|*[!0-9]*) die "cannot read the free disk space on /";; esac
  [ $(( avail * 1048576 )) -ge "$NEED_BYTES" ] || die "free disk $(gb $(( avail * 1048576 )))G < $NEED_TEXT: expand the disk first"
  pass "free disk $(gb $(( avail * 1048576 )))G >= $NEED_TEXT"
  mem=$(mem_avail_mb); case "$mem" in ''|*[!0-9]*) die "cannot read MemAvailable";; esac
  [ "$mem" -ge "$REHEARSAL_MEM_FLOOR_MB" ] || die "MemAvailable ${mem}MB < ${REHEARSAL_MEM_FLOOR_MB}MB: not starting the restore"
  pass "MemAvailable ${mem}MB >= ${REHEARSAL_MEM_FLOOR_MB}MB"
  rh_dir_init
  integrity_begin
  step "3. create the copy and restore into it (timed; the restore stops below ${BUILD_DISK_FLOOR_MB}MB free on / or pgdata)"
  trap restore_abort EXIT
  trap 'exit 1' HUP INT TERM
  { printf 'CREATE DATABASE "%s";\n' "$COPY_DB"
    printf "COMMENT ON DATABASE \"%s\" IS '%s %s';\n" "$COPY_DB" "$COPY_MARKER" "$(basename "$f")"; } | ndb postgres >/dev/null \
    || die "CREATE DATABASE $COPY_DB or its mark failed (the psql error above)"
  [ "$(copy_state)" = marked ] || die "$COPY_DB was not created with its mark"
  pass "created $COPY_DB in $NEW_DB_CTR, marked as this script's copy"
  t0=$(date +%s); rc=0; restore_watched "$f" || rc=$?; t1=$(date +%s)
  if [ -n "$RESTORE_STOP" ]; then die "RESTORE STOPPED BY THE WATCHDOG: $RESTORE_STOP (the live Postgres instances share this disk). The partial copy is dropped. Free space or expand the disk, then restore again"; fi
  if [ "$rc" != 0 ]; then
    { grep -c 'error' "$RH_DIR/$RUN_TS-restore.err" | sed 's/^/pg_restore error lines: /'; grep -m 3 'error' "$RH_DIR/$RUN_TS-restore.err" | err_safe; } || true
    die "pg_restore exit=$rc after $(fmt_secs $((t1 - t0))) (filtered errors above, whole in $RH_DIR/$RUN_TS-restore.err). The partial copy is dropped"
  fi
  pass "pg_restore exit=0; lowest free disk during the restore ${RESTORE_DMIN:-?}MB"
  timing_add restore $((t1 - t0)) "$(basename "$f"), $(( b / 1048576 )) MB"
  est=$(dump_est_seconds "$f"); if [ -n "$est" ]; then timing_add dump_est "$est" "from the dump's name and modification time, to the minute"; fi
  timing_add sha256 "$sha_s" "sha256 of $(basename "$f"), $(( b / 1048576 )) MB"
  step "4. exact row counts of the copy = the dump's (runbook section 6 steps 2-3)"
  guard_write_path "$COUNTS_DUMP"
  t0=$(date +%s); ( umask 077; copy_counts > "$COUNTS_DUMP.tmp" ) || die "the row count of the copy failed"; t1=$(date +%s)
  mv -f "$COUNTS_DUMP.tmp" "$COUNTS_DUMP"
  n=$(grep -c . "$COUNTS_DUMP" || true); rows=$(awk '{ s += $2 } END { printf "%d", s }' "$COUNTS_DUMP")
  users=$(awk '$1 == "User" { print $2 }' "$COUNTS_DUMP")
  [ "$n" -gt 0 ] && [ -n "$users" ] || die "the copy has no tables or no User table after the restore"
  pass "tables=$n rows=$rows User=$users (kept in $COUNTS_DUMP)"
  timing_add counts_restore $((t1 - t0)) "$n tables, $rows rows"
  step "5. gate G8: REHEARSAL_G8=$REHEARSAL_G8"
  if [ "$REHEARSAL_G8" = scrub ]; then
    t0=$(date +%s); sc=$(copy_scrub) || die "the G8 scrub of the copy failed (the psql error above): the copy is dropped"; t1=$(date +%s)
    read -r -a a_before <<< "$(sed -n 's/^before //p' <<< "$sc")"; read -r -a a_after <<< "$(sed -n 's/^after //p' <<< "$sc")"
    [ "${#a_before[@]}" = 4 ] && [ "${a_before[*]}" = "${a_after[*]:-}" ] && [ "$(sed -n 's/^left //p' <<< "$sc")" = 0 ] \
      || die "the G8 scrub did not leave every sensitive value replaced with NULL kept (non-NULL per column before: ${a_before[*]:-?}, after: ${a_after[*]:-?}, rows with an original value left: $(sed -n 's/^left //p' <<< "$sc")): the copy is dropped"
    pass "G8 scrub: User.password ${a_before[0]}, privateKey ${a_before[1]}, xAccessToken ${a_before[2]}, xRefreshToken ${a_before[3]} non-NULL values replaced by the placeholder (NULL kept); none left"
    timing_add scrub $((t1 - t0)) "G8 scrub, not part of the window"
  else
    warn "G8 keep: the copy holds User.password, privateKey, xAccessToken and xRefreshToken as the dump does (the recorded G8 decision)"
  fi
  state_set G8 "$REHEARSAL_G8"
  state_set DUMP "$(basename "$f")"; state_set DUMP_BYTES "$b"; state_set RESTORED_AT "$(date +%Y-%m-%dT%H:%M:%S%z)"
  state_set IMAGE ""; state_set MIGRATED_AT ""; state_set DROPPED_AT ""
  RESTORE_DONE=1; trap - EXIT HUP INT TERM
  integrity_end
  say "next: ./60-rehearsal.sh migrate [ddcnew/backend:<12 hex>] (default: the running api's image)"
}

do_migrate() {
  local t0 t1 st
  new_db_ok || die "$NEW_WHY"
  copy_guard
  refuse_if_production
  copy_require_marked
  resolve_image "${1:-}" migrate
  rh_dir_init
  cx_prepare
  integrity_begin
  copy_readonly off >/dev/null || die "could not reset default_transaction_read_only on $COPY_DB (the psql error above)"   # an interrupted report may have left it set
  step "1. where the one-off container's DATABASE_URL points (it must be the copy, or nothing runs)"
  copy_exec migrate-check true
  [ "$CX_RC" = 0 ] || cx_fail "the check container failed"
  pass "$GATE_LINE (gate inside a one-off container of $IMAGE)"
  step "2. prisma migrate status"
  copy_exec migrate-status npx prisma migrate status
  { grep -vE '^[[:space:]]*$' "$CX_OUT" | grep -viE 'postgres(ql)?://' | err_safe | tail -n 12; } || true
  step "3. prisma migrate deploy (timed)"
  t0=$(date +%s); copy_exec migrate-deploy npx prisma migrate deploy; t1=$(date +%s)
  { grep -viE 'postgres(ql)?://' "$CX_OUT" | grep -E 'migrations? (found|applied)|All migrations|No pending|Applying' | err_safe | tail -n 20; } || true
  [ "$CX_RC" = 0 ] || cx_fail "prisma migrate deploy failed on the copy"
  timing_add migrate $((t1 - t0)) "$IMAGE"
  copy_exec migrate-status-after npx prisma migrate status
  st=$(cat "$CX_OUT")
  grep -qi 'Database schema is up to date' <<< "$st" || cx_fail "prisma migrate status is not up to date after the deploy"
  pass "migrate status: Database schema is up to date ($(grep -oE '[0-9]+ migrations? found' <<< "$st" | head -n 1))"
  [ "$(rebind_tables)" = 2 ] && pass "the copy has Web3AuthNetworkRebind and Web3AuthNetworkRebindRun (mainnetSwitch can run)" \
    || warn "the copy lacks Web3AuthNetworkRebind / Web3AuthNetworkRebindRun after the migration: mainnetSwitch will say NO-GO"
  state_set IMAGE "$IMAGE"; state_set MIGRATED_AT "$(date +%Y-%m-%dT%H:%M:%S%z)"
  integrity_end
  say "next: ./60-rehearsal.sh report, then ./60-rehearsal.sh apply-switch"
}

# mainnetSwitch --json output -> counts only (no ids, no e-mail). Last line: "facts <go 0|1> <to_record> <pending>
# <rebound> <runs not rolled back> <newest run id or ->".
plan_view() {
  python3 - "$1" <<'PY'
import json, sys
o = json.load(open(sys.argv[1]))
r = o.get("report", {})
w = r.get("web3auth_regular", {})
t = r.get("to_record", {})
d = r.get("duplicate_emails", {})
j = lambda v: json.dumps(v or {}, sort_keys=True)
print("plan %s: %s -> %s" % ("GO" if o.get("go") else "NO-GO", o.get("from_network"), o.get("to_network")))
print("users_total %s; by_auth_type %s; organizations %s; disabled %s" % (r.get("users_total"), j(r.get("by_auth_type")), r.get("organizations"), r.get("disabled")))
print("web3auth regular accounts %s: with_wallet %s, with_server_key %s" % (w.get("total"), w.get("with_wallet"), w.get("with_server_key")))
print("  by_login_key %s" % j(w.get("by_login_key")))
print("  by_pair_state %s" % j(w.get("by_pair_state")))
print("existing records %s" % j(r.get("records")))
print("--apply would record %s accounts (old-network pairs cleared: %s)" % (t.get("total"), t.get("old_network_pairs_cleared")))
print("  by_evidence %s" % j(t.get("by_evidence")))
print("  by_policy %s" % j(t.get("by_policy")))
print("duplicate e-mails (case-insensitive): %s groups, %s rows" % (d.get("groups"), d.get("rows")))
na = r.get("not_automatic", {})
print("will NOT re-bind automatically (counts by reason): %s accounts" % sum(v.get("count", 0) for v in na.values()))
for k in sorted(na):
    print("  %s %s" % (k, na[k].get("count")))
if not na:
    print("  none")
runs = o.get("runs", [])
open_runs = [x for x in runs if not x.get("rolled_back_at")]
print("runs %d (not rolled back: %d)" % (len(runs), len(open_runs)))
for x in o.get("warnings", []):
    print("WARNING %s" % x)
for x in o.get("blockers", []):
    print("BLOCKER %s" % x)
rec = r.get("records") or {}
print("facts %d %d %d %d %d %s" % (1 if o.get("go") else 0, t.get("total") or 0, rec.get("pending", 0), rec.get("rebound", 0), len(open_runs), open_runs[-1]["id"] if open_runs else "-"))
PY
}
PLAN_FACTS=""
run_plan() { # <label>: mainnetSwitch --plan --json on the copy; prints the counts, sets PLAN_FACTS
  local v
  copy_exec "$1" node scripts/mainnetSwitch.js --plan --json ${CX_KEEP[@]+"${CX_KEEP[@]}"}
  case "$CX_RC" in 0|1) ;; *) cx_fail "mainnetSwitch --plan failed";; esac
  v=$(plan_view "$CX_OUT" 2>/dev/null) || cx_fail "mainnetSwitch --plan printed no readable JSON"
  grep -vE '^(facts|WARNING|BLOCKER) ' <<< "$v" || true
  { grep -E '^(WARNING|BLOCKER) ' <<< "$v" | err_safe; } || true
  PLAN_FACTS=$(grep '^facts ' <<< "$v" | head -n 1)
  [ -n "$PLAN_FACTS" ] || cx_fail "mainnetSwitch --plan: no result"
}
fact() { # <n>: field n of PLAN_FACTS (1 go, 2 to_record, 3 pending, 4 rebound, 5 open runs, 6 newest open run)
  local a
  read -r -a a <<< "$PLAN_FACTS"
  printf '%s' "${a[$1]:-}"
}
json_field() { python3 -c 'import json, sys; o = json.load(open(sys.argv[1])); v = o.get(sys.argv[2]); print("" if v is None else (str(v).lower() if isinstance(v, bool) else v))' "$1" "$2" 2>/dev/null || true; }
do_report() {
  local t0 t1 present now bad=0 v line
  new_db_ok || die "$NEW_WHY"
  copy_guard
  refuse_if_production
  copy_require_marked
  [ -f "$COUNTS_DUMP" ] || die "$COUNTS_DUMP missing: the copy's counts after the restore are the reference (run cleanup, then restore again)"
  resolve_image "${1:-}" other
  rh_dir_init
  cx_prepare
  integrity_begin
  step "1. the copy read-only for this report (default_transaction_read_only = on for every new session)"
  copy_readonly on >/dev/null || die "could not make $COPY_DB read-only for the report (the psql error above)"
  trap '( copy_readonly off >/dev/null 2>&1 ) || warn "could not reset default_transaction_read_only on $COPY_DB: ./60-rehearsal.sh apply-switch resets it"' EXIT
  [ "$(copy_sql <<< 'SHOW default_transaction_read_only;')" = on ] && pass "a new session on $COPY_DB is read-only" || die "the copy is not read-only for new sessions"
  step "2. exact row counts per table: the copy now against the dump's (counted right after the restore)"
  now="$RH_DIR/$RUN_TS-counts.txt"; guard_write_path "$now"
  t0=$(date +%s); ( umask 077; copy_counts > "$now" ) || die "the row count of the copy failed"; t1=$(date +%s)
  timing_add counts_report $((t1 - t0)) "$(grep -c . "$now" || true) tables"
  v=$(awk 'NR == FNR { d[$1] = $2; next } { n[$1] = $2 }
    END {
      for (t in d) if (!(t in n)) { printf "LOST %s dump=%s now=missing\n", t, d[t]; lost++ }
      for (t in n) {
        if (!(t in d)) { printf "NEW %s now=%s (not in the dump: a migration or the switch)\n", t, n[t]; added++ }
        else if (n[t] + 0 < d[t] + 0) { printf "LOST %s dump=%s now=%s\n", t, d[t], n[t]; lost++ }
        else if (n[t] != d[t]) { printf "MORE %s dump=%s now=%s (+%d)\n", t, d[t], n[t], n[t] - d[t]; more++ }
        else same++
      }
      printf "facts %d %d %d %d\n", same, more, added, lost
    }' "$COUNTS_DUMP" "$now" | LC_ALL=C sort)
  { grep -vE '^facts ' <<< "$v" | sed 's/^/  /'; } || true
  read -r -a line <<< "$(grep '^facts ' <<< "$v")"
  say "tables: identical ${line[1]}, more rows ${line[2]}, new ${line[3]}, missing or fewer rows ${line[4]}"
  if [ "${line[4]}" = 0 ]; then pass "every table of the dump is on the copy with at least the dump's rows"
  else printf 'FAIL %s table(s) of the dump are missing or have fewer rows on the copy (listed above)\n' "${line[4]}"; bad=1; fi
  step "3. the scripts in $IMAGE"
  present=$(docker run --rm --pull never --network none --name "$PROJECT-rehearsal-probe-$$" --entrypoint sh "$IMAGE" -c 'for f in "$@"; do if [ -f "$f" ]; then echo "$f"; fi; done' probe \
    scripts/mainnetSwitch.js scripts/backfillSocialPostIdentity.js scripts/reportDuplicateCampaignGrants.js 2>/dev/null | tr '\n' ' ') || present=""
  say "present: ${present:-none}"
  step "4. mainnetSwitch --plan (timed): GO / NO-GO and the accounts that will not re-bind automatically"
  if [[ " $present " == *" scripts/mainnetSwitch.js "* ]]; then
    t0=$(date +%s); run_plan report-plan; t1=$(date +%s)
    timing_add plan $((t1 - t0)) "exit $CX_RC"
    [ "$(fact 1)" = 1 ] && pass "mainnetSwitch --plan: GO" || warn "mainnetSwitch --plan: NO-GO on the copy (BLOCKER lines above)"
    say "GO/NO-GO here follows the rehearsal api's WEB3AUTH_* settings (.env.api); in the window --plan runs with .env.cutover's"
  else printf 'FAIL scripts/mainnetSwitch.js is not in %s\n' "$IMAGE"; bad=1; fi
  step "5. backfillSocialPostIdentity.js dry run (timed; writes nothing)"
  if [[ " $present " == *" scripts/backfillSocialPostIdentity.js "* ]]; then
    t0=$(date +%s); copy_exec report-backfill node scripts/backfillSocialPostIdentity.js; t1=$(date +%s)
    [ "$CX_RC" = 0 ] || cx_fail "backfillSocialPostIdentity.js dry run failed on the copy"
    grep -q '^mode dry-run:' "$CX_OUT" || cx_fail "backfillSocialPostIdentity.js did not run as a dry run"
    grep -vE '^    row ' "$CX_OUT" | sed 's/^/  /'
    timing_add backfill $((t1 - t0)) "dry run"
  else warn "scripts/backfillSocialPostIdentity.js is not in $IMAGE (an image before backend PR #54): skipped"; fi
  step "6. reportDuplicateCampaignGrants.js (timed)"
  if [[ " $present " == *" scripts/reportDuplicateCampaignGrants.js "* ]]; then
    t0=$(date +%s); copy_exec report-duplicates node scripts/reportDuplicateCampaignGrants.js; t1=$(date +%s)
    [ "$CX_RC" = 0 ] || cx_fail "reportDuplicateCampaignGrants.js failed on the copy"
    head -n 1 "$CX_OUT" | sed 's/^/  /'
    awk 'match($0, /: [0-9]+ rows, -?[0-9.]+ points/) { split(substr($0, RSTART + 2, RLENGTH - 2), a, " "); r += a[1]; p += a[3]; g++ }
      END { printf "  in all: %d group(s), %d rows, %s points (per group, with user ids: in the records only)\n", g, r, p }' "$CX_OUT"
    timing_add duplicates $((t1 - t0)) ""
  else warn "scripts/reportDuplicateCampaignGrants.js is not in $IMAGE (an image before backend PR #54): skipped"; fi
  step "7. the copy writable again"
  copy_readonly off >/dev/null || die "could not reset default_transaction_read_only on $COPY_DB (the psql error above)"; trap - EXIT
  pass "default_transaction_read_only reset on $COPY_DB"
  say "the whole outputs (with user and row ids) stay on the server until cleanup: $RH_DIR/$RUN_TS-report-*.out (600)"
  integrity_end
  [ "$bad" = 0 ] || die "the report found the problems above"
}

do_apply_switch() {
  local t0 t1 kept acc run runid restored deleted cleared
  local -a dd=()
  new_db_ok || die "$NEW_WHY"
  copy_guard
  refuse_if_production
  copy_require_marked
  [ "$(rebind_tables)" = 2 ] || die "the copy has no Web3AuthNetworkRebind tables: run ./60-rehearsal.sh migrate first"
  resolve_image "${1:-}" other
  rh_dir_init
  cx_prepare
  integrity_begin
  copy_readonly off >/dev/null || die "could not reset default_transaction_read_only on $COPY_DB (the psql error above)"
  step "1. --plan before"
  run_plan switch-plan-before
  [ "$(fact 1)" = 1 ] || die "mainnetSwitch --plan says NO-GO on the copy (BLOCKER lines above): --apply would refuse"
  [ "$(fact 5)" = 0 ] || die "the copy holds a run that was never rolled back ($(fact 6)): for clean timings run cleanup, restore and migrate again"
  acc=$(fact 2)
  kept=$(users_snapshot) || die "could not keep the users before --apply (the psql error above)"
  [[ "$kept" =~ ^[0-9]+$ ]] || die "could not keep the users before --apply (no count)"
  say "users kept before --apply: $kept (a digest of every column but updatedAt per user, in $USERS_BEFORE on the copy)"
  step "2. --apply --yes (timed)"
  t0=$(date +%s); copy_exec switch-apply node scripts/mainnetSwitch.js --apply --yes --json ${CX_KEEP[@]+"${CX_KEEP[@]}"}; t1=$(date +%s)
  [ "$CX_RC" = 0 ] || cx_fail "mainnetSwitch --apply failed on the copy"
  [ "$(json_field "$CX_OUT" applied)" = true ] || die "mainnetSwitch --apply applied nothing on the copy (to record before: $acc): nothing to roll back"
  runid=$(json_field "$CX_OUT" run_id); run=$(json_field "$CX_OUT" accounts)
  [[ "$runid" =~ ^[0-9]{14}_[0-9a-f]{4}$ ]] || die "mainnetSwitch --apply returned no run id"
  timing_add apply $((t1 - t0)) "$run accounts recorded"
  cleared=$(json_field "$CX_OUT" old_network_pairs_cleared)
  say "run_id $runid, backup table $(json_field "$CX_OUT" backup_table), accounts $run, old-network pairs cleared $cleared"
  [ "$run" = "$acc" ] && pass "--apply recorded exactly the $acc accounts --plan announced" || die "--apply recorded $run accounts, --plan announced $acc"
  [[ "$cleared" =~ ^[0-9]+$ ]] || die "mainnetSwitch --apply reported no old_network_pairs_cleared"
  read -r -a dd <<< "$(users_diff)"
  [ "${dd[0]:-}" = "$cleared" ] && pass "after --apply: $cleared users differ from before (the old-network pairs it reports cleared); every other user is unchanged" \
    || die "after --apply ${dd[0]:-?} users differ from before in a column other than updatedAt (added, removed or changed); --apply reports $cleared old-network pairs cleared"
  [ "$cleared" != 0 ] || warn "--apply cleared no old-network pair: the check after --rollback then proves the records only, not a restore of the users' columns"
  step "3. --plan after the apply"
  run_plan switch-plan-applied
  [ "$(fact 2)" = 0 ] && [ "$(fact 3)" = "$acc" ] && pass "after --apply: nothing left to record, $acc pending re-binds" \
    || die "after --apply --plan shows to_record $(fact 2) and pending $(fact 3), expected 0 and $acc"
  step "4. --rollback (timed)"
  t0=$(date +%s); copy_exec switch-rollback node scripts/mainnetSwitch.js --rollback --run "$runid" --yes --json; t1=$(date +%s)
  [ "$CX_RC" = 0 ] || cx_fail "mainnetSwitch --rollback failed on the copy"
  [ "$(json_field "$CX_OUT" rolled_back)" = true ] || die "mainnetSwitch --rollback did not roll the run back"
  restored=$(json_field "$CX_OUT" accounts_restored); deleted=$(json_field "$CX_OUT" records_deleted)
  timing_add rollback $((t1 - t0)) "$restored accounts restored"
  [ "$restored" = "$acc" ] && [ "$deleted" = "$acc" ] && pass "--rollback restored $restored accounts and deleted $deleted records" \
    || die "--rollback restored $restored accounts and deleted $deleted records, expected $acc each"
  step "5. --plan after the rollback, and every user against its state before --apply"
  run_plan switch-plan-rolled-back
  [ "$(fact 2)" = "$acc" ] && [ "$(fact 3)" = 0 ] && [ "$(fact 5)" = 0 ] && pass "after --rollback: $acc accounts to record again, no pending record, no open run" \
    || die "after --rollback --plan shows to_record $(fact 2), pending $(fact 3), open runs $(fact 5); expected $acc, 0, 0"
  read -r -a dd <<< "$(users_diff)"
  [ "${dd[0]:-}" = 0 ] && pass "after --rollback every one of the $kept users equals its state before --apply in every column but updatedAt" \
    || die "after --rollback ${dd[0]:-?} users differ from before --apply in a column other than updatedAt (added, removed or changed)"
  say "updatedAt differs from before --apply on ${dd[1]:-?} users: --apply sets it (Prisma @updatedAt) and --rollback does not restore it; a production rollback leaves it changed too"
  users_snapshot_drop >/dev/null || warn "could not drop $USERS_BEFORE on the copy (cleanup drops the whole copy)"
  integrity_end
  say "next: ./60-rehearsal.sh summary; when done: ./60-rehearsal.sh cleanup"
}

# The cutover window estimate, runbook section 6 steps 1-9, one row per part (window_parts below, in the order of the
# steps): meas <key> <label> takes the latest measured time of <key> from timings.tsv, fig <minutes> <label> the runbook's
# figure. A part with neither (offsite_copy: the encrypted off-site copy of the final dump, measured with gate G6's
# tooling; points_repair: the repair of the points records after the restore, no script yet) shows NOT MEASURED, and
# then no PASS is printed. Such a part counts once its time is in timings.tsv (<key> TAB <seconds> TAB <time> TAB <note>).
do_summary() {
  local f
  settings_say
  [ -f "$TIMINGS" ] || { say "no timings yet ($TIMINGS): run restore, migrate, report and apply-switch first"; return 0; }
  for f in DUMP DUMP_BYTES RESTORED_AT G8 IMAGE MIGRATED_AT DROPPED_AT; do say "$f=$(state_get "$f")"; done
  step "timings (the latest run of each step; runs = how often it was measured)"
  awk -F'\t' -v freeze="$FREEZE_MIN" -v public="$PUBLIC_MIN" -v config="$CONFIG_MIN" -v sw="$SWITCH_MIN" -v smoke="$SMOKE_MIN" \
      -v open="$OPEN_MIN" -v lim="$WINDOW_LIMIT_MIN" '
    { s[$1] = $2; w[$1] = $3; nt[$1] = $4; c[$1]++ }
    function row(k) { if (k in s) printf "%-16s %8d s %7.1f min  runs %-3d %s  %s\n", k, s[k], s[k] / 60, c[k], w[k], nt[k]; else printf "%-16s %10s %11s\n", k, "-", "-" }
    function meas(k, label) {
      if (k in s) { printf "  %7.1f min  %s\n", s[k] / 60, label; total += s[k] / 60 }
      else { printf "  %11s  %s: NOT MEASURED (%s)\n", "-", label, k; miss++; missing = missing " " k }
    }
    function fig(m, label) { printf "  %7.1f min  %s (runbook figure)\n", m, label; total += m }
    END {
      printf "%-16s %10s %11s  %s\n", "step", "seconds", "minutes", "runs, when, note"
      n = split("dump_est sha256 restore counts_restore scrub migrate counts_report plan backfill duplicates apply rollback cleanup offsite_copy points_repair", k, " ")
      for (i = 1; i <= n; i++) row(k[i])
      printf "\ncutover window estimate (runbook section 6, steps 1-9):\n"
      total = 0; miss = 0; missing = ""
      fig(freeze, "freeze the old stack (step 1)")
      meas("dump_est", "final dump (step 2, timed from the nightly dump)")
      meas("counts_restore", "row counts of the old database (step 2, timed on the copy right after its restore, cached: the old database counts cold, likely slower)")
      meas("sha256", "sha256 of the final dump (step 2)")
      meas("offsite_copy", "encrypted off-site copy of the final dump and its sha256 there (step 2)")
      meas("restore", "restore (step 3)")
      meas("counts_restore", "row counts of the new database (step 3)")
      fig(public, "uploaded files, public/ (step 4, the upper end of 5-10 min)")
      meas("migrate", "migrate deploy (step 5)")
      fig(config, "the rest of step 5: configuration, database check, migrate status, api recreate, boot log (the whole step)")
      meas("plan", "--plan (step 6)")
      meas("apply", "--apply (step 6)")
      meas("plan", "--plan again (step 6)")
      meas("backfill", "social post backfill after the release (dry-run time, the --apply run writes and takes longer)")
      meas("points_repair", "points record repair after the restore (no script yet)")
      fig(sw, "web image and domain switch (step 7)")
      fig(smoke, "smoke tests behind the gate (step 8)")
      fig(open, "opening (step 9)")
      printf "  %7.1f min  in all: the measured parts and the runbook figures (limit %d min)\n", total, lim
      if (miss) printf "WARN the estimate is incomplete: %d part(s) neither measured nor given a runbook figure (%s): no PASS until each is measured\n", miss, substr(missing, 2)
      else if (total <= lim) printf "PASS the estimate fits the %d-minute window\n", lim
      if (total > lim) printf "WARN the estimate is longer than the %d-minute window: lengthen the window and the notice\n", lim
    }' "$TIMINGS"
}

# The per-run outputs that hold user and row ids (<ts>-<step>.out/.err, <ts>-restore.err): removed by cleanup.
records_prune() {
  local f n=0
  for f in "$RH_DIR"/[0-9]*-[0-9]*-*.out "$RH_DIR"/[0-9]*-[0-9]*-*.out.tmp "$RH_DIR"/[0-9]*-[0-9]*-*.err; do
    [ -f "$f" ] || continue
    guard_write_path "$f"; rm -f -- "$f"; n=$((n + 1))
  done
  pass "records with user or row ids removed: $n file(s) (<ts>-*.out/.err); kept: timings.tsv, state.env and the row counts"
}

do_cleanup() {
  local t0 t1
  new_db_ok || die "$NEW_WHY"
  copy_guard
  if live_is_production; then warn "the running api uses $LIVE_DB: the new stack is production; cleanup only drops the copy"; fi
  rh_dir_init
  local st; st=$(copy_state) || exit 1   # copy_state printed why it could not ask Postgres
  case "$st" in
    absent) pass "$COPY_DB does not exist: nothing to drop"; records_prune; return 0;;
    marked) ;;
    *) die "$COPY_DB exists WITHOUT this script's mark: 60-rehearsal.sh did not create it and does not drop it (ask the team whose it is)";;
  esac
  integrity_begin
  step "drop $COPY_DB (timed)"
  say "sessions on the copy ended: $(copy_terminate)"
  t0=$(date +%s); copy_drop >/dev/null || die "DROP DATABASE $COPY_DB failed or was refused (the psql error above): nothing dropped"; t1=$(date +%s)
  [ "$(copy_state)" = absent ] || die "$COPY_DB still exists after DROP DATABASE"
  pass "$COPY_DB dropped"
  timing_add cleanup $((t1 - t0)) ""
  if [ -e "$OVERRIDE" ]; then guard_write_path "$OVERRIDE"; rm -f -- "$OVERRIDE"; fi
  state_set DROPPED_AT "$(date +%Y-%m-%dT%H:%M:%S%z)"
  records_prune
  say "free disk on / now: $(disk_avail_mb)MB; the timings stay in $RH_DIR (./60-rehearsal.sh summary)"
  integrity_end
}

# ---------------------------------------------------------------------------
cmd="${1:-}"
[ "$#" -le 2 ] || die "$USAGE"
arg="${2:-}"
case "$cmd" in
  preflight|restore) [ -z "$arg" ] || dump_arg_check "$arg";;
  migrate|report|apply-switch) [ -z "$arg" ] || image_check_name "$arg";;
  summary|cleanup) [ -z "$arg" ] || die "$cmd takes no argument";;
  *) die "$USAGE";;
esac
case "$cmd" in restore|migrate|report|apply-switch|cleanup) run_begin "60-rehearsal-$cmd" "$@";; esac
case "$cmd" in
  preflight) do_preflight "$arg";;
  restore) do_restore "$arg";;
  migrate) do_migrate "$arg";;
  report) do_report "$arg";;
  apply-switch) do_apply_switch "$arg";;
  summary) do_summary;;
  cleanup) do_cleanup;;
esac
