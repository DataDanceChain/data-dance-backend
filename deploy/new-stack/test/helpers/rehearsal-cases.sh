#!/usr/bin/env bash
# rehearsal-cases.sh <package dir> <work dir>   (local test helper; touches nothing outside <work dir>)
# Runs the real 60-rehearsal.sh (DDC_LOCAL_TEST=1, as a normal user) against STUB docker, curl and df: the argument
# handling, the guards that keep it off every database but its copy, a whole rehearsal (preflight, restore, migrate,
# report, apply-switch, summary, cleanup) and the cases that must STOP it. No container is started and no database
# exists: the stub docker keeps the copy's state in files, emulates psql, pg_restore, the one-off containers and the
# scripts' outputs, and runs each one-off container's gate (GATE_JS) through the real node when node is installed (the
# same rule in shell otherwise). Synthetic values only: every secret-shaped value holds DUMMYSECRET, every user id
# uid-secret, every e-mail address someone@example.com, and none of them may reach the output or the run logs.
# When the real docker compose is installed (the Mac), the override the script writes is also checked with compose
# itself: it changes the api service's image and DATABASE_URL, and nothing else.
# Prints PASS/FAIL lines; exit 1 on FAIL.
set -u
PKG="$1"; W="$2"
REAL_DOCKER=$(command -v docker 2>/dev/null || true)
unset API_HOST APP_HOST API_PORT WEB_PORT DB_PORT TAKE_OVER_VHOSTS REHEARSAL_CLIENT_ID REHEARSAL_G8 DDC_RUN_LOG DDC_LOCK_HELD
rm -rf "$W"; mkdir -p "$W/bin" "$W/backup/pg" "$W/ddcnew" "$W/switch" "$W/old/ddc-backend" "$W/avail" "$W/enabled" "$W/confd"
fails=0; ok() { echo "PASS $*"; }; bad() { echo "FAIL $*"; fails=$((fails+1)); }
COPY=ddc_rehearsal_copy

cat > "$W/bin/docker" <<'EOF'
#!/bin/bash
# stub docker for 60-rehearsal.sh (test/helpers/rehearsal-cases.sh). State in $STUB_DIR: copy (absent|marked|foreign),
# ro (on|off), migrated, run, rolledback, snap (the users kept before --apply). Every call is logged to calls, every psql
# session to sql.log, every one-off container to oneoffs.
S="$STUB_DIR"
printf '%s\n' "$*" >> "$S/calls"; printf '%s\n' "$*" >> "$S/allcalls"
st() { cat "$S/$1" 2>/dev/null || echo "$2"; }
counts() {
  local p=5000 m=3
  [ -f "$S/migrated" ] && m=11
  [ "${STUB_LOST:-0}" = 1 ] && [ -f "$S/migrated" ] && p=4990
  { echo "Point $p"; echo "User 1500"; echo "_prisma_migrations $m"
    if [ -f "$S/migrated" ]; then echo "Web3AuthNetworkRebind 0"; echo "Web3AuthNetworkRebindRun $([ -f "$S/rolledback" ] && echo 1 || echo 0)"; fi
  } | LC_ALL=C sort
}
plan_json() {
  local to=1200 pend=0 runs='[]' go=true bl='[]' r
  if [ -f "$S/run" ]; then r=$(cat "$S/run"); to=0; pend=1200
    runs="[{\"id\": \"$r\", \"backup_table\": \"mainnet_switch_backup_$r\", \"accounts\": 1200, \"applied_at\": \"2026-10-13T12:00:00Z\", \"rolled_back_at\": null}]"
  elif [ -f "$S/rolledback" ]; then
    runs='[{"id": "20261013120000_ab12", "backup_table": "mainnet_switch_backup_20261013120000_ab12", "accounts": 1200, "applied_at": "2026-10-13T12:00:00Z", "rolled_back_at": "2026-10-13T12:05:00Z"}]'
  fi
  if [ ! -f "$S/migrated" ]; then go=false; bl='["tables Web3AuthNetworkRebind / Web3AuthNetworkRebindRun missing: run `npx prisma migrate deploy` first"]'
  elif [ "${STUB_NOGO:-0}" = 1 ]; then go=false; bl='["backend would not boot with this environment: WEB3AUTH_CLIENT_ID is not set (ask someone@example.com)"]'; fi
  cat <<J
{ "mode": "plan", "go": $go, "blockers": $bl,
  "warnings": ["no X/twitter connection in WEB3AUTH_REBIND_VERIFIERS: X accounts will not re-bind"],
  "from_network": "sapphire_devnet", "to_network": "sapphire_mainnet",
  "report": { "users_total": 1500, "by_auth_type": {"web3auth": 1450, "traditional": 50},
    "web3auth_regular": {"total": 1440, "by_login_key": {"email": 1000, "x": 400, "apple_relay": 40}, "by_pair_state": {"old_network": 1200, "unlinked": 240}, "with_wallet": 1300, "with_server_key": 5},
    "organizations": 10, "disabled": 3, "records": {"pending": $pend, "rebound": 0},
    "to_record": {"total": $to, "by_evidence": {"devnet_pair": $to}, "by_policy": {"replace": $to}, "old_network_pairs_cleared": $to},
    "duplicate_emails": {"groups": 2, "rows": 4, "ids": ["uid-secret-dup-1", "uid-secret-dup-2"]},
    "not_automatic": {"apple_relay_address_may_differ": {"count": 40, "ids": ["uid-secret-apple-1"]}, "not_web3auth": {"count": 50, "ids": ["uid-secret-trad-1"]}, "organization": {"count": 10, "ids": ["uid-secret-org-1"]}} },
  "runs": $runs }
J
  [ "$go" = true ] || exit 1
}
# backfillSocialPostIdentity.js's record part: <restore verb> <supersede verb> <link-key rows> <restored> <superseded> <earlier>
records_part() {
  printf 'other sources: %s rows stored under a post link key, %s records (%s rows read)\n' "$3" "$(( $4 + 1 ))" "$3"
  printf '  %s own identity: %s (order id %s, title key 0, content only 0; content hash kept, held by another row: 0)\n' "$1" "$4" "$4"
  printf '  earliest copy already holds the identity: %s\n  %s superseded (later copies): %s (stored under a link key %s, under the identity itself 0)\n' "$([ "$4" = 0 ] && echo 0 || echo 1)" "$2" "$5" "$5"
  printf '  already superseded by an earlier run: %s\n    amazon: restore %s, supersede %s\n  conflicts (left unchanged, nothing deleted): 0\n' "$6" "$4" "$5"
  printf "superseded rows per user, this run and earlier runs (points unchanged; each row's share of its upload batch):\n"
  printf '  user uid-secret-5: rows 6, points 60.00 (base 60.00, bonus 0.00), upline 0.00, no batch 0\n'
  printf '  total: users 1, rows 6, points 60.00 (base 60.00, bonus 0.00), upline 0.00, no batch 0\n'
}
case "$1" in
  ps) if [[ "$*" == *'{{.Names}}'* ]]; then printf '%s\n' ddc-backend-ddc-backend-db-1 ddcnew-api-1 ddcnew-db-1 ddcnew-web-1; fi; exit 0;;
  image)
    imgs="${STUB_IMAGES:-ddcnew/backend:0123456789ab ddcnew/backend:abcdef012345}"
    case "$2" in
      inspect) case " $imgs " in *" $3 "*) echo '[{}]'; exit 0;; *) echo "Error: No such image: $3" >&2; exit 1;; esac;;
      ls) printf '%s\n' $imgs postgres:17; exit 0;;
    esac; exit 1;;
  inspect)
    fmt="$3"; c="${!#}"
    case "$fmt" in
      *RestartPolicy*) echo "/$c|feed-$c|running|2026-09-20T00:00:00Z|0|always";;
      *RestartCount*)
        t=2026-10-10T00:00:00Z
        if [ "${STUB_RESTART:-0}" = 1 ] && [ "$c" = ddcnew-db-1 ]; then if [ -f "$S/snap-db" ]; then t=2026-10-13T09:00:00Z; else touch "$S/snap-db"; fi; fi
        echo "/$c|id-$c|running|$t|0";;
      *Labels*) echo "${STUB_LABELS:-ddcnew/db}";;
      *Health*) echo "${STUB_HEALTH:-healthy}";;
      *Config.Image*) echo "${STUB_RUNNING_IMAGE:-ddcnew/backend:0123456789ab}";;
      *) echo "stub inspect: unexpected format $fmt" >&2; exit 1;;
    esac; exit 0;;
  exec)
    shift; [ "$1" = -i ] && shift
    ctr="$1"; shift
    case "$ctr" in
      ddcnew-api-1) [ "${STUB_LIVE_DB:-ddc_rehearsal}" = none ] || echo "${STUB_LIVE_HOST:-db} ${STUB_LIVE_DB:-ddc_rehearsal}"; exit 0;;
      ddc-backend-ddc-backend-db-1) echo "${STUB_OLD_BYTES-6442450944}"; exit 0;;
      ddcnew-db-1) ;;
      *) echo "stub exec: unexpected container $ctr" >&2; exit 1;;
    esac
    db="${!#}"
    if [[ "$*" == *pg_restore* ]]; then
      cat > /dev/null; echo "restore $db" >> "$S/restores"
      case "${STUB_RESTORE:-ok}" in
        fail) echo 'pg_restore: error: COPY failed for table "User": ERROR:  duplicate key value violates unique constraint' >&2
              echo 'DETAIL:  Key (email)=(someone@example.com) already exists.' >&2
              echo 'pg_restore: error: could not execute query: ERROR: duplicate row for someone@example.com' >&2; exit 1;;
        slow) exec 9>&-; sleep 4;;   # the run lock (fd 9) stays with the script, not with an orphaned sleep once the client is killed
      esac
      exit 0
    fi
    sql=$(cat)
    printf 'db=%s %s\n' "$db" "$(printf '%s' "$sql" | tr '\n' ' ' | cut -c1-1000)" >> "$S/sql.log"
    case "$db" in postgres|ddc_rehearsal_copy) ;; *) echo "VIOLATION $db" >> "$S/sql.log";; esac
    copy=$(st copy absent)
    if [[ "$sql" == *"current_database() <> 'ddc_rehearsal_copy'"* ]]; then
      [ "$db" = ddc_rehearsal_copy ] && [ "$copy" = marked ] || { echo 'ERROR:  refusing: this session is not on the marked rehearsal copy' >&2; exit 3; }
    fi
    if [[ "$sql" == *"does not carry the rehearsal mark"* ]] && [ "$copy" != marked ]; then echo 'ERROR:  refusing: does not carry the rehearsal mark' >&2; exit 3; fi
    case "$sql" in
      *"SELECT 'db:'"*) case "$copy" in marked) echo "db:ddcnew-rehearsal-copy: restored by deploy/new-stack/60-rehearsal.sh, never production x.dump";; foreign) echo "db:";; esac;;
      *"CREATE DATABASE"*) [ "$copy" = absent ] || { echo 'ERROR:  database exists' >&2; exit 3; }; echo marked > "$S/copy";;
      *"DROP DATABASE"*) echo absent > "$S/copy"; rm -f "$S/migrated" "$S/run" "$S/rolledback" "$S/snap" "$S/scrubbed" "$S/repaired";;
      *"SET default_transaction_read_only = on"*) echo on > "$S/ro";;
      *"RESET default_transaction_read_only"*) echo off > "$S/ro";;
      *"SHOW default_transaction_read_only"*) st ro off;;
      *pg_terminate_backend*) echo 0; echo terminate >> "$S/terminated";;
      *"string_agg(datname"*) echo "ddc_rehearsal=9 MB ddcnew=8 MB";;
      *query_to_xml*) counts;;
      *rehearsal-scrubbed*)   # the G8 scrub: non-NULL values per column before and after, rows with an original value left
        printf 'before 50 5 400 400\nafter 50 5 400 400\nleft %s\n' "$([ "${STUB_SCRUB_BAD:-0}" = 1 ] && echo 3 || echo 0)"; touch "$S/scrubbed";;
      *"CREATE TABLE rehearsal_users_before"*) touch "$S/snap"; echo 1500;;
      *"FULL JOIN rehearsal_users_before"*)   # "<changed> <updatedAt only>": after --apply, then after --rollback
        [ -f "$S/snap" ] || { echo 'ERROR:  relation "rehearsal_users_before" does not exist' >&2; exit 3; }
        if [ -f "$S/run" ]; then echo "${STUB_DIFF_APPLIED:-1200 0}"
        elif [ "${STUB_DIGEST_BAD:-0}" = 1 ]; then echo "3 1197"   # STUB_DIGEST_BAD=1: 3 users not restored by the rollback
        else echo "0 1200"; fi;;
      *"DROP TABLE rehearsal_users_before"*) rm -f "$S/snap";;
      *Web3AuthNetworkRebindRun*) [ -f "$S/migrated" ] && echo 2 || echo 0;;
      *) echo "stub psql: unexpected SQL" >&2; exit 3;;
    esac; exit 0;;
  run)
    if [[ "$*" == *"pg_restore --list"* ]]; then
      cat > /dev/null
      case "${STUB_TOC:-ok}" in
        ok) printf ';\n; Archive created at 2026-10-13\n;\n1; 2615 2200 SCHEMA - public owner\n2; 1259 16385 TABLE public User owner\n3; 0 16385 TABLE DATA public User owner\n';;
        nouser) printf ';\n1; 2615 2200 SCHEMA - public owner\n2; 0 16390 TABLE DATA public Point owner\n';;
        fail) echo 'pg_restore: error: could not read input file: end of file' >&2; exit 1;;
      esac; exit 0
    fi
    if [[ "$*" == *"--entrypoint sh"* ]]; then printf '%s\n' ${STUB_SCRIPTS:-scripts/mainnetSwitch.js scripts/backfillSocialPostIdentity.js scripts/reportDuplicateCampaignGrants.js}; exit 0; fi
    echo "stub docker run: unexpected $*" >&2; exit 1;;
  compose)
    shift; files=""; svc=""; isrun=0; rm_=0; nodeps=0; name=""; vols=""
    while [ $# -gt 0 ]; do
      case "$1" in
        -f) files="$files $2"; shift 2;;
        -p|--project-directory) shift 2;;
        run) isrun=1; shift;;
        --rm) rm_=1; shift;;
        --no-deps) nodeps=1; shift;;
        -T) shift;;
        --name) name="$2"; shift 2;;
        -v) vols="$vols $2"; shift 2;;
        api) svc=api; shift; break;;
        *) echo "stub compose: unexpected argument $1" >&2; exit 1;;
      esac
    done
    [ "$isrun" = 1 ] && [ "$rm_" = 1 ] && [ "$nodeps" = 1 ] && [ "$svc" = api ] || { echo "stub compose: not a one-off run of api" >&2; exit 1; }
    case "$files" in *compose.yaml*compose.copy.yaml*) ;; *) echo "stub compose: no override" >&2; exit 1;; esac
    printf 'run name=%s vols=%s\n' "$name" "$vols" >> "$S/oneoffs"
    [ "$1" = sh ] && [ "$2" = -c ] && [ "$4" = rehearsal-gate ] || { echo "stub compose: no gate" >&2; exit 1; }
    gate="$5"; shift 5
    printf '%s' "$gate" > "$S/gate.js"
    if [ "${STUB_IGNORE_OVERRIDE:-0}" = 1 ]; then url=$(sed -n 's/^DATABASE_URL="\(.*\)"$/\1/p' "$STUB_NEW_DIR/.env.api"); else url="${REHEARSAL_DATABASE_URL:-}"; fi
    if command -v node >/dev/null 2>&1; then
      DATABASE_URL="$url" REHEARSAL_EXPECT_DB="${REHEARSAL_EXPECT_DB:-}" node -e "$gate" || exit 97
    else   # the gate's rule in shell (ubuntu:jammy has no node)
      rest="${url#*://}"; rest="${rest#*@}"; hp="${rest%%/*}"; path="/${rest#*/}"; q=""
      case "$path" in *\?*) q="${path#*\?}"; path="${path%%\?*}";; esac
      host="${hp%%:*}"; port=5432; case "$hp" in *:*) port="${hp#*:}";; esac
      schema=public; case "$q" in *schema=*) schema="${q#*schema=}"; schema="${schema%%&*}";; esac
      echo "db_target=$host:$port$path schema=$schema"
      [ "$host" = db ] && [ "$port" = 5432 ] && [ "$path" = "/${REHEARSAL_EXPECT_DB:-}" ] && [ "$schema" = public ] || exit 97
    fi
    printf 'cmd %s\n' "$*" >> "$S/oneoffs"
    case "$*" in
      true) exit 0;;
      "npx prisma migrate status")
        if [ -f "$S/migrated" ]; then printf '11 migrations found in prisma/migrations\n\nDatabase schema is up to date!\n'
        else printf '11 migrations found in prisma/migrations\nFollowing migrations have not yet been applied:\n20261002190000_web3auth_network_rebind\n'; exit 1; fi;;
      "npx prisma migrate deploy")
        [ "${STUB_MIGRATE:-ok}" = ok ] || { echo 'Error: P3018 a migration failed to apply (row of someone@example.com)' >&2; exit 1; }
        touch "$S/migrated"; printf '11 migrations found in prisma/migrations\nApplying migration `20261002190000_web3auth_network_rebind`\nAll migrations have been successfully applied.\n';;
      "node scripts/mainnetSwitch.js --plan --json"*) plan_json;;
      "node scripts/mainnetSwitch.js --apply --yes --json"*)
        [ "$(st ro off)" = off ] || { echo '{"mode": "apply", "error": "25006 cannot execute CREATE TABLE in a read-only transaction"}'; exit 3; }
        if [ "${STUB_APPLY:-ok}" = noop ]; then echo '{"mode": "apply", "go": true, "applied": false, "nothing_to_do": true, "warnings": []}'; exit 0; fi
        echo 20261013120000_ab12 > "$S/run"; rm -f "$S/rolledback"
        printf '{"mode": "apply", "go": true, "applied": true, "run_id": "20261013120000_ab12", "backup_table": "mainnet_switch_backup_20261013120000_ab12", "accounts": %s, "by_evidence": {"devnet_pair": 1200}, "by_policy": {"replace": 1200}, "old_network_pairs_cleared": 1200, "warnings": []}\n' "${STUB_APPLY_ACCOUNTS:-1200}";;
      "node scripts/mainnetSwitch.js --rollback --run 20261013120000_ab12 --yes --json")
        [ -f "$S/run" ] || { echo '{"mode": "rollback", "go": false, "blockers": ["run not found"]}'; exit 1; }
        rm -f "$S/run"; touch "$S/rolledback"
        printf '{"mode": "rollback", "go": true, "rolled_back": true, "run_id": "20261013120000_ab12", "backup_table": "mainnet_switch_backup_20261013120000_ab12", "accounts_restored": %s, "rebinds_reverted": 0, "records_deleted": 1200}\n' "${STUB_ROLLBACK_RESTORED:-1200}";;
      "node scripts/backfillSocialPostIdentity.js")
        printf 'mode dry-run: scanned 50 social rows\n  would update: 7\n  already current: 40\n  no permalink (unchanged): 3\n  conflicts (left unchanged, nothing deleted): 1\n    row r-uid-secret-1 user uid-secret-9: identity kept by r-2\n'
        records_part 'would restore' 'would mark' 10 4 6 0
        printf 'Dry run: nothing was written. Re-run with --apply to write.\n';;
      "node scripts/backfillSocialPostIdentity.js --apply")   # the record repair: changes on the first run, none after
        [ "$(st ro off)" = off ] || { echo 'error: cannot execute UPDATE in a read-only transaction' >&2; exit 3; }
        [ "${STUB_REPAIR:-ok}" != fail ] || { echo 'Error: record repair failed (row of someone@example.com)' >&2; exit 1; }
        if [ -f "$S/repaired" ] && [ "${STUB_REPAIR:-ok}" != again ]; then u=0; l=0; r=0; sp=0; e=6; else u=7; l=10; r=4; sp=6; e=0; fi
        touch "$S/repaired"
        printf 'mode apply: scanned 50 social rows\n  updated: %s\n  already current: 40\n  no permalink (unchanged): 3\n  conflicts (left unchanged, nothing deleted): 1\n    row r-uid-secret-1 user uid-secret-9: identity kept by r-2\n' "$u"
        [ "${STUB_REPAIR:-ok}" = nopart2 ] || records_part 'restored' 'marked' "$l" "$r" "$sp" "$e";;
      "node scripts/reportDuplicateCampaignGrants.js")
        printf 'one-time campaign grants written more than once: 2 group(s)\n  user uid-secret-2 first_action fa-1: 2 rows, 200 points, 2026-10-01T00:00:00.000Z .. 2026-10-02T00:00:00.000Z\n  user uid-secret-3 referral_boost rb-9: 3 rows, 150 points, 2026-10-03T00:00:00.000Z .. 2026-10-04T00:00:00.000Z\n';;
      *) echo "stub compose: unexpected command $*" >&2; exit 1;;
    esac; exit 0;;
esac
echo "stub docker: unexpected call $*" >&2
exit 1
EOF
cat > "$W/bin/curl" <<'EOF'
#!/bin/bash
case "$*" in *"/partner/tge/me"*) printf '%s' "${STUB_API_CODE:-401}";; *) printf '000';; esac
EOF
cat > "$W/bin/df" <<'EOF'
#!/bin/bash
# df -Pk /: free space from STUB_DF_MB; after STUB_DF_LOW_AFTER calls, 1000 MB. df -Pk <another path> (the new cluster's
# pgdata): STUB_DF_PG_MB (default 60000), not counted.
if [ "${!#}" != / ]; then printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/stub2 104857600 1 %s 1%% /x\n' $(( ${STUB_DF_PG_MB:-60000} * 1024 )); exit 0; fi
n=$(( $(cat "$STUB_DIR/dfcalls" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$STUB_DIR/dfcalls"
mb="${STUB_DF_MB:-50000}"
if [ -n "${STUB_DF_LOW_AFTER:-}" ] && [ "$n" -gt "$STUB_DF_LOW_AFTER" ]; then mb=1000; fi
printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/stub 104857600 1 %s 1%% /\n' $(( mb * 1024 ))
EOF
chmod 755 "$W/bin/docker" "$W/bin/curl" "$W/bin/df"
printf 'MemTotal:       16000000 kB\nMemAvailable:    8000000 kB\n' > "$W/meminfo"
# The new stack's files as 10-build.sh, 20-env.sh and 40-up.sh leave them (synthetic values).
cp "$PKG/compose.yaml" "$W/ddcnew/compose.yaml"
printf 'API_IMAGE=ddcnew/backend:0123456789ab\nWEB_IMAGE=ddcnew/web:tge-0123456789ab\nINFRA_ONLY=0\nOLD_APP_SWITCHES=1\n' > "$W/ddcnew/.env"
printf 'NODE_ENV=production\nDATABASE_URL="postgresql://ddcuser:DUMMYSECRET-dbpw@db:5432/ddc_rehearsal?schema=public"\nJWT_SECRET="DUMMYSECRET-jwt"\n' > "$W/ddcnew/.env.api"
cp "$W/ddcnew/.env.api" "$W/ddcnew/.env.rehearsal"
printf 'POSTGRES_USER=ddcuser\nPOSTGRES_PASSWORD=DUMMYSECRET-dbpw\nPOSTGRES_DB=ddcnew\n' > "$W/ddcnew/.env.db"
# P1 dumps: two complete daily ones (the newer is picked), a newer one without its sidecar (interrupted: skipped).
sha() { if command -v sha256sum >/dev/null; then sha256sum | cut -c1-64; else shasum -a 256 | cut -c1-64; fi; }
mkdump() { # <name> <touch time> [nosidecar]
  head -c 4096 /dev/urandom > "$W/backup/pg/$1"
  [ "${3:-}" = nosidecar ] || printf '%s  %s\n' "$(sha < "$W/backup/pg/$1")" "$1" > "$W/backup/pg/$1.sha256"
  touch -t "$2" "$W/backup/pg/$1"
}
mkdump ddc-daily-20261012-0315.dump 202610120329
mkdump ddc-daily-20261013-0315.dump 202610130329
mkdump ddc-daily-20261013-1200.dump 202610131201 nosidecar
DUMP_NEW="$W/backup/pg/ddc-daily-20261013-0315.dump"

fresh() { rm -rf "$W/s" "$W/ddcnew/rehearsal" "$W/ddcnew/logs"; mkdir -p "$W/s"; echo absent > "$W/s/copy"; echo off > "$W/s/ro"; }
reh() { # <60-rehearsal.sh args...>: one run; output in $W/out, status in RC; stub knobs come from the caller (VAR=value reh ...)
  RC=0
  env PATH="$W/bin:$PATH" STUB_DIR="$W/s" STUB_NEW_DIR="$W/ddcnew" DDC_LOCAL_TEST=1 NEW_DIR="$W/ddcnew" BACKUP_DIR="$W/backup" SWITCH_DIR="$W/switch" \
    REHEARSAL_G8="${REHEARSAL_G8-scrub}" \
    OLD_BACKEND_DIR="$W/old/ddc-backend" OLD_APP_DIR="$W/old/ddc" OLD_ENV="$W/old/ddc-backend/backend.env" MAINNET_DIR="$W/old/ddc-mainnet" \
    NGINX_AVAIL="$W/avail" NGINX_ENABLED="$W/enabled" NGINX_CONFD="$W/confd" DDC_MEMINFO="$W/meminfo" BUILD_WATCH_INTERVAL=1 \
    bash "$PKG/60-rehearsal.sh" "$@" > "$W/out" 2>&1 < /dev/null || RC=$?
}
show() { sed 's/^/    /' "$W/out" | tail -n "${1:-12}"; }
cnt() { local n; n=$(grep -c -- "$1" "$2" 2>/dev/null) || true; echo "${n:-0}"; }   # <pattern> <file>: 0 also when the file is missing
ncalls() { cnt . "$W/s/calls"; }
created() { cnt 'CREATE DATABASE' "$W/s/sql.log"; }
# refused <label> <expected FAIL text> <args...>: status 1, the FAIL line, and no database created, restored or dropped
refused() {
  local label="$1" want="$2"; shift 2
  reh "$@"
  if [ "$RC" = 1 ] && grep -qF -- "$want" "$W/out" && [ "$(created)" = 0 ] && [ ! -s "$W/s/restores" ] && ! grep -q 'DROP DATABASE' "$W/s/sql.log" 2>/dev/null; then
    ok "$label -> refused: $(grep -m1 '^FAIL' "$W/out" | cut -c1-150)"
  else show; bad "$label (rc=$RC)"; fi
}
mark() { echo "$1" > "$W/s/copy"; }
has_timings() { local s; for s in "$@"; do grep -q "$(printf '^%s\t' "$s")" "$W/ddcnew/rehearsal/timings.tsv" 2>/dev/null || return 1; done; }

echo "-- arguments: refused before any docker call"
for a in "" "bogus" "restore a b" "migrate postgres:17" "migrate ddcnew/backend:0123456789ab-infra" "migrate ddcnew/backend:0123456789AB" "report ddcnew/web:tge-0123456789ab" \
         "apply-switch ddcnew/backend:abc" "summary x" "cleanup now" "restore /etc/hosts" "restore $W/ddcnew/.env.db" \
         "record" "record offsite_copy" "record offsite_copy 600 x" "record restore 600" "record points_repair 600" "record offsite_copy 0" \
         "record offsite_copy 86401" "record offsite_copy 6m" "record offsite_copy -5" "record offsite_copy 060"; do
  fresh
  # shellcheck disable=SC2086  # the arguments of each case are split on purpose
  reh $a
  if [ "$RC" = 1 ] && grep -q '^FAIL ' "$W/out" && [ "$(ncalls)" = 0 ] && [ ! -e "$W/ddcnew/rehearsal/timings.tsv" ]; then ok "60-rehearsal.sh ${a:-<none>}: $(grep -m1 '^FAIL' "$W/out" | cut -c1-110)"
  else show; bad "60-rehearsal.sh ${a:-<none>} (rc=$RC, docker calls $(ncalls))"; fi
done
fresh; ln -sfn "$DUMP_NEW" "$W/backup/pg/ddc-daily-20261013-0400.dump"
reh restore "$W/backup/pg/ddc-daily-20261013-0400.dump"
[ "$RC" = 1 ] && grep -q 'is not a regular file' "$W/out" && [ "$(ncalls)" = 0 ] && ok "restore <a symlink in the dump directory>: refused before any docker call" || { show; bad "restore of a symlink (rc=$RC)"; }
rm -f "$W/backup/pg/ddc-daily-20261013-0400.dump"
cp "$DUMP_NEW" "$W/backup/pg/other.dump"; fresh; reh preflight "$W/backup/pg/other.dump"
[ "$RC" = 1 ] && grep -q 'is not named ddc-<label>-<ts>.dump' "$W/out" && [ "$(ncalls)" = 0 ] && ok "preflight <a file not named like a P1 dump>: refused before any docker call" || { show; bad "badly named dump (rc=$RC)"; }
rm -f "$W/backup/pg/other.dump"

echo "-- guards: the copy is never a protected database, never on another container, never foreign"
fresh; STUB_LIVE_DB=$COPY refused "the running api uses $COPY" "is a protected database" restore
fresh; STUB_LIVE_DB=$COPY refused "the running api uses $COPY (cleanup)" "is a protected database" cleanup
fresh; printf 'DATABASE_URL="postgresql://ddcuser:DUMMYSECRET-dbpw@db:5432/%s?schema=public"\n' "$COPY" > "$W/ddcnew/.env.cutover"
refused ".env.cutover names $COPY" "is a protected database" restore; rm -f "$W/ddcnew/.env.cutover"
fresh; STUB_LIVE_DB=none refused "the running api's database cannot be read" "cannot read which database the running api" restore
fresh; STUB_LIVE_HOST=ddc-backend-db refused "the running api uses another host" "uses a database on host ddc-backend-db, not this stack's db" migrate
fresh; STUB_LABELS=ddc-backend/db refused "ddcnew-db-1 is not this project's db service" "is not the ddcnew project's db service" restore
[ ! -s "$W/s/sql.log" ] && ok "  ... and no SQL session was opened" || bad "SQL ran although the db container is not this project's"
fresh; STUB_HEALTH=starting refused "the new db is not healthy" "is starting, not healthy" restore
fresh; sed -i.bak 's/^INFRA_ONLY=0$/INFRA_ONLY=1/' "$W/ddcnew/.env"; refused "INFRA_ONLY=1" "INFRA_ONLY=1" restore; mv -f "$W/ddcnew/.env.bak" "$W/ddcnew/.env"
for c in restore migrate report apply-switch cleanup; do
  fresh; mark foreign; reh "$c"
  [ "$RC" = 1 ] && grep -q "exists WITHOUT this script's mark" "$W/out" && [ "$(cat "$W/s/copy")" = foreign ] && ! grep -qE 'DROP DATABASE|ALTER DATABASE' "$W/s/sql.log" && [ ! -s "$W/s/oneoffs" ] \
    && ok "a $COPY without this script's mark: $c refuses and touches nothing" || { show; bad "foreign copy, $c (rc=$RC)"; }
done
fresh; mark marked; refused "restore over an existing marked copy" "already exists (an earlier restore): run ./60-rehearsal.sh cleanup first" restore
fresh; STUB_LIVE_DB=ddc_prod refused "the running api uses ddc_prod (the new stack is production)" "the running api uses ddc_prod: the new stack is production now" restore
for c in migrate report apply-switch; do
  fresh; mark marked; STUB_LIVE_DB=ddc_prod reh "$c"
  [ "$RC" = 1 ] && grep -q 'the new stack is production now' "$W/out" && [ ! -s "$W/s/oneoffs" ] && ! grep -qE 'ALTER DATABASE|DROP' "$W/s/sql.log" 2>/dev/null \
    && ok "the running api uses ddc_prod: $c refuses before any one-off container or change" || { show; bad "$c next to production (rc=$RC)"; }
done
fresh; printf 'DATABASE_URL="postgresql://ddcuser:DUMMYSECRET-dbpw@db:5432/ddc_live2?schema=public"\n' > "$W/ddcnew/.env.cutover"
STUB_LIVE_DB=ddc_live2 refused "the running api uses the database .env.cutover names" "the running api uses ddc_live2: the new stack is production now" restore; rm -f "$W/ddcnew/.env.cutover"
fresh; mark marked; STUB_LIVE_DB=ddc_prod reh cleanup
[ "$RC" = 0 ] && [ "$(cat "$W/s/copy")" = absent ] && grep -q '^WARN the running api uses ddc_prod: the new stack is production; cleanup only drops the copy' "$W/out" \
  && ok "the running api uses ddc_prod: cleanup still drops a leftover copy (with a WARN)" || { show; bad "cleanup next to production (rc=$RC)"; }
fresh; STUB_LIVE_DB=ddc_prod reh preflight
[ "$RC" = 1 ] && grep -q '^FAIL the running api uses ddc_prod: the new stack is production now' "$W/out" && ok "preflight next to production: FAIL" || { show 20; bad "preflight next to production (rc=$RC)"; }
for v in "" maybe; do
  fresh; REHEARSAL_G8="$v" reh restore
  [ "$RC" = 1 ] && grep -qE '^FAIL (gate G8 is not decided for this restore|REHEARSAL_G8 must be scrub or keep)' "$W/out" && [ "$(ncalls)" = 0 ] \
    && ok "restore with REHEARSAL_G8='$v': refused before any docker call ($(grep -m1 '^FAIL' "$W/out" | cut -c1-80)...)" || { show; bad "restore with REHEARSAL_G8='$v' (rc=$RC)"; }
done
fresh; REHEARSAL_G8='' reh preflight
[ "$RC" = 0 ] && grep -q '^WARN gate G8 not given: restore needs REHEARSAL_G8=scrub or REHEARSAL_G8=keep' "$W/out" && ok "preflight without REHEARSAL_G8: a WARN (restore will need it), still PASS" || { show 20; bad "preflight without G8 (rc=$RC)"; }
for c in migrate report apply-switch; do
  fresh; reh "$c"
  [ "$RC" = 1 ] && grep -q "$COPY does not exist: run ./60-rehearsal.sh restore first" "$W/out" && [ ! -s "$W/s/oneoffs" ] && ok "$c without a copy: refused" || { show; bad "$c without a copy (rc=$RC)"; }
done

echo "-- the dump, the disk and the memory: restore refuses before it creates anything"
bk="$W/backup/pg/ddc-daily-20261013-0315.dump.sha256"; cp "$bk" "$bk.keep"; printf '%s  %s\n' "$(printf '0%.0s' $(seq 1 64))" ddc-daily-20261013-0315.dump > "$bk"
fresh; refused "a dump whose sha256 does not match" "does not match its .sha256 sidecar" restore; mv -f "$bk.keep" "$bk"
fresh; STUB_TOC=fail refused "pg_restore --list fails" "pg_restore --list failed (exit 1)" restore
fresh; STUB_TOC=nouser refused "a table of contents without the User table's data" "has no data for the User table" restore
fresh; STUB_DF_MB=15000 refused "15 GB free for an old database of 6 GB (need 18 GB)" "need 18.0G = copy 1.5 x 6.0G (the old database's size) + the nightly P1 dump's own floor 9.0G" restore
fresh; STUB_OLD_BYTES="" STUB_DF_MB=2000 refused "old database size unreadable: 3 x the dump instead" "3 x the dump (the old database's size could not be read)" restore
mkdir -p "$W/ddcnew/pgdata"
fresh; STUB_DF_PG_MB=10000 refused "50 GB free on / but 9.8 GB on the new cluster's pgdata (another file system)" "free disk 9.8G < need 18.0G" restore
rmdir "$W/ddcnew/pgdata"
printf 'MemTotal:       16000000 kB\nMemAvailable:    1500000 kB\n' > "$W/meminfo"
fresh; refused "MemAvailable 1464 MB" "MemAvailable 1464MB < 2000MB" restore
for c in migrate report apply-switch; do
  fresh; mark marked; touch "$W/s/migrated"
  if [ "$c" = report ]; then mkdir -p "$W/ddcnew/rehearsal"; echo 'User 1500' > "$W/ddcnew/rehearsal/counts-dump.txt"; fi
  reh "$c"
  [ "$RC" = 1 ] && grep -q 'MemAvailable 1464MB < 2000MB: no one-off container started' "$W/out" && [ ! -s "$W/s/oneoffs" ] \
    && ok "MemAvailable 1464 MB: $c refuses before any one-off container (they inherit the api's memory limit)" || { show; bad "$c with low memory (rc=$RC)"; }
done
printf 'MemTotal:       16000000 kB\nMemAvailable:    8000000 kB\n' > "$W/meminfo"
fresh; mark marked; STUB_DF_MB=8000 reh migrate
[ "$RC" = 1 ] && grep -q "free disk 7.8G < the nightly P1 dump's own floor 9.0G (database size + 3G): no one-off container started" "$W/out" && [ ! -s "$W/s/oneoffs" ] \
  && ok "8 GB free for an old database of 6 GB: migrate refuses before any one-off container (the nightly dump's own floor 9 GB)" || { show; bad "migrate with low disk (rc=$RC)"; }
fresh; mark marked; STUB_IMAGES="ddcnew/backend:abcdef012345" reh migrate
[ "$RC" = 1 ] && grep -q 'image ddcnew/backend:0123456789ab is not on this host' "$W/out" && [ ! -s "$W/s/oneoffs" ] && ok "migrate with the running api's image missing on the host: refused (nothing is pulled)" || { show; bad "missing image (rc=$RC)"; }

echo "-- restore failures leave no partial copy"
fresh; STUB_RESTORE=fail reh restore
[ "$RC" = 1 ] && grep -q '^FAIL pg_restore exit=1' "$W/out" && [ "$(cat "$W/s/copy")" = absent ] && grep -q 'the partial copy ddc_rehearsal_copy (created by this run) was dropped' "$W/out" \
  && ! grep -q 'someone@example.com' "$W/out" && ! grep -rq 'someone@example.com' "$W/ddcnew/logs" && grep -q 'someone@example.com' "$W/ddcnew/rehearsal/"*-restore.err \
  && ok "pg_restore fails -> FAIL, the partial copy is dropped; the e-mail address in its error is in neither the output nor the run log (only in the 600 record)" || { show 20; bad "failed restore (rc=$RC)"; }
fresh; STUB_RESTORE=slow STUB_DF_LOW_AFTER=1 reh restore
[ "$RC" = 1 ] && grep -q 'RESTORE STOPPED BY THE WATCHDOG: free disk (/ and pgdata) 1000MB < 3072MB' "$W/out" && [ -s "$W/s/terminated" ] && [ "$(cat "$W/s/copy")" = absent ] \
  && ok "free disk falls below 3 GB during the restore -> the watchdog ends its session inside Postgres and the partial copy is dropped" || { show 20; bad "restore watchdog (rc=$RC)"; }
fresh; STUB_SCRUB_BAD=1 reh restore
[ "$RC" = 1 ] && grep -q '^FAIL the G8 scrub did not leave every sensitive value replaced' "$W/out" && [ "$(cat "$W/s/copy")" = absent ] && grep -q 'the partial copy ddc_rehearsal_copy (created by this run) was dropped' "$W/out" \
  && ok "a G8 scrub that leaves an original value -> FAIL, and the copy is dropped" || { show 20; bad "scrub failure (rc=$RC)"; }
fresh; REHEARSAL_G8=keep reh restore
[ "$RC" = 0 ] && grep -q '^WARN G8 keep: the copy holds User.password, privateKey, xAccessToken and xRefreshToken as the dump does' "$W/out" && [ ! -f "$W/s/scrubbed" ] \
  && grep -q '^G8=keep$' "$W/ddcnew/rehearsal/state.env" && ! grep -q "$(printf '^scrub\t')" "$W/ddcnew/rehearsal/timings.tsv" \
  && ok "restore with REHEARSAL_G8=keep: no scrub, a WARN, G8=keep recorded" || { show 20; bad "restore with G8 keep (rc=$RC)"; }

echo "-- a whole rehearsal"
fresh; reh preflight
rosql=1; if grep -vE "SELECT 'db:'|string_agg\(datname" "$W/s/sql.log" 2>/dev/null | grep -q .; then rosql=0; fi
[ "$RC" = 0 ] && grep -q '^PASS REHEARSAL PREFLIGHT PASS' "$W/out" && grep -q 'dump: ddc-daily-20261013-0315.dump ' "$W/out" && grep -q "the running api uses db:5432/ddc_rehearsal; protected databases: ddc ddc_prod ddc_rehearsal ddc_rehearsal2 ddcnew postgres template0 template1" "$W/out" \
  && grep -q 'dump time (from its name and modification time, to the minute): 840s' "$W/out" && [ ! -e "$W/ddcnew/rehearsal" ] && [ ! -e "$W/ddcnew/logs" ] && [ "$rosql" = 1 ] \
  && ok "preflight: PASS, the newest daily dump with a sidecar (the newer one without it skipped), dump time 840 s, nothing written, only read-only SQL" || { show 40; bad "preflight (rc=$RC)"; }
grep -qE '^(run|lock):' "$W/out" && bad "preflight took the run lock (it is read-only)"
fresh; STUB_LIVE_DB=$COPY STUB_DF_MB=15000 reh preflight
[ "$RC" = 1 ] && grep -q '^FAIL refusing: the copy.s name ddc_rehearsal_copy is a protected database' "$W/out" && grep -q '^FAIL free disk 14.6G < need 18.0G' "$W/out" && grep -q '^FAIL REHEARSAL PREFLIGHT FAIL: 2 check(s) failed' "$W/out" \
  && ok "preflight reports every failed check, then FAILs (2 here: the copy's name, the disk)" || { show 30; bad "preflight with failures (rc=$RC)"; }
fresh; reh restore
[ "$RC" = 0 ] && [ "$(cat "$W/s/copy")" = marked ] && grep -q '^PASS pg_restore --list ok: 3 entries, with the User table' "$W/out" && grep -q '^PASS tables=3 rows=6503 User=1500' "$W/out" \
  && has_timings restore counts_restore sha256 scrub && grep -q '^G8=scrub$' "$W/ddcnew/rehearsal/state.env" \
  && grep -q '^PASS G8 scrub: User.password 50, privateKey 5, xAccessToken 400, xRefreshToken 400 non-NULL values replaced by the placeholder (NULL kept); none left' "$W/out" \
  && grep -q "$(printf '^dump_est\t840\t')" "$W/ddcnew/rehearsal/timings.tsv" && grep -q '^DUMP=ddc-daily-20261013-0315.dump$' "$W/ddcnew/rehearsal/state.env" \
  && grep -q '^PASS old-stack containers unchanged' "$W/out" && grep -q '^PASS new-stack containers unchanged' "$W/out" && grep -q 'restore ddc_rehearsal_copy' "$W/s/restores" \
  && ok "restore: creates and marks the copy, restores into it, counts the dump's rows, scrubs (G8), records restore, dump_est, sha256, counts_restore and scrub; both stacks unchanged" || { show 40; bad "restore (rc=$RC)"; }
log=$(ls "$W/ddcnew/logs/"*-60-rehearsal-restore-*.log 2>/dev/null | head -n 1)
[ -n "$log" ] && grep -q '^PASS tables=3' "$log" && ok "restore wrote its server-side log ($(basename "$log"))" || bad "no server-side log for restore"
fresh_keep() { rm -f "$W/s/calls" "$W/s/oneoffs"; }   # between the steps of one rehearsal: keep the copy's state
fresh_keep; STUB_IGNORE_OVERRIDE=1 reh migrate
[ "$RC" = 1 ] && grep -q "the one-off container for 'migrate-check' does not point at the copy (its gate printed 'db_target=db:5432/ddc_rehearsal schema=public', exit 97)" "$W/out" \
  && ! grep -q '^cmd ' "$W/s/oneoffs" && [ ! -f "$W/s/migrated" ] \
  && ok "a one-off container whose DATABASE_URL is the live database (the override not applied): its gate refuses (exit 97) and no command runs" || { show 20; bad "gate refusal (rc=$RC)"; }
fresh_keep; reh migrate ddcnew/backend:abcdef012345
[ "$RC" = 0 ] && grep -q '^PASS db_target=db:5432/ddc_rehearsal_copy schema=public' "$W/out" && grep -q '^PASS migrate status: Database schema is up to date (11 migrations found)' "$W/out" \
  && grep -q "$(printf '^migrate\t')" "$W/ddcnew/rehearsal/timings.tsv" && grep -q '^IMAGE=ddcnew/backend:abcdef012345$' "$W/ddcnew/rehearsal/state.env" \
  && grep -q 'run name=ddcnew-rehearsal-migrate-deploy-' "$W/s/oneoffs" && grep -q '^cmd npx prisma migrate deploy$' "$W/s/oneoffs" \
  && ok "migrate <image>: gate passes, migrate deploy timed, status up to date, the image recorded" || { show 30; bad "migrate (rc=$RC)"; }
cp "$W/ddcnew/rehearsal/compose.copy.yaml" "$W/override-copy.yaml" 2>/dev/null || bad "no override file written"
printf '%s\n' uid-keep-1 uid-keep-2 > "$W/switch/keep.txt"
fresh_keep; reh report
[ "$RC" = 0 ] && grep -q 'image: ddcnew/backend:abcdef012345 (the one migrate used)' "$W/out" && grep -q '^PASS a new session on ddc_rehearsal_copy is read-only' "$W/out" \
  && [ "$(cat "$W/s/ro")" = off ] && grep -q 'tables: identical 2, more rows 1, new 2, missing or fewer rows 0' "$W/out" && grep -q '^plan GO: sapphire_devnet -> sapphire_mainnet' "$W/out" \
  && grep -q '^will NOT re-bind automatically (counts by reason): 100 accounts' "$W/out" && grep -q '^  apple_relay_address_may_differ 40$' "$W/out" \
  && grep -q '^ *conflicts (left unchanged, nothing deleted): 1$' "$W/out" && grep -q 'in all: 2 group(s), 5 rows, 350 points' "$W/out" \
  && grep -q 'keep.txt: 2 user id(s)' "$W/out" && grep -q 'vols= .*keep.txt:/tmp/keep.txt:ro' "$W/s/oneoffs" && grep -q '^cmd node scripts/mainnetSwitch.js --plan --json --keep-wallet-ids /tmp/keep.txt$' "$W/s/oneoffs" \
  && has_timings counts_report plan backfill duplicates && ! grep -q 'uid-secret' "$W/out" \
  && grep -q '^ *would restore own identity: 4 (order id 4' "$W/out" && grep -q '^ *total: users 1, rows 6, points 60.00 (base 60.00, bonus 0.00), upline 0.00, no batch 0$' "$W/out" \
  && ! grep -qE '^ *(user|row) ' "$W/out" && grep -q '^  user uid-secret-5: ' "$W/ddcnew/rehearsal/"*-report-backfill.out \
  && grep -q "^GO/NO-GO here follows the rehearsal api's WEB3AUTH_\* settings (.env.api); in the window --plan runs with .env.cutover's" "$W/out" \
  && ok "report: read-only during the report and reset after it; counts against the dump's; --plan as counts by reason (keep.txt passed); backfill dry run as counts (its per-user and row lines only in the record); duplicates in all; each timed" || { show 50; bad "report (rc=$RC)"; }
fresh_keep; STUB_LOST=1 reh report
[ "$RC" = 1 ] && grep -q '^  LOST Point dump=5000 now=4990' "$W/out" && grep -q '^FAIL 1 table(s) of the dump are missing or have fewer rows' "$W/out" && [ "$(cat "$W/s/ro")" = off ] \
  && ok "report: a table with fewer rows than the dump -> FAIL at the end, and the copy is writable again" || { show 20; bad "report with lost rows (rc=$RC)"; }
fresh_keep; STUB_NOGO=1 reh apply-switch
[ "$RC" = 1 ] && grep -q 'mainnetSwitch --plan says NO-GO on the copy' "$W/out" && ! grep -q -- '--apply' "$W/s/oneoffs" && ! grep -q 'someone@example.com' "$W/out" \
  && ok "apply-switch: a NO-GO plan stops it before --apply (and the blocker's e-mail address is masked)" || { show 20; bad "apply-switch NO-GO (rc=$RC)"; }
echo on > "$W/s/ro"
fresh_keep; reh apply-switch
[ "$RC" = 0 ] && grep -q '^PASS --apply recorded exactly the 1200 accounts --plan announced' "$W/out" && grep -q '^PASS after --apply: nothing left to record, 1200 pending re-binds' "$W/out" \
  && grep -q '^PASS --rollback restored 1200 accounts and deleted 1200 records' "$W/out" && grep -q '^PASS after --rollback: 1200 accounts to record again, no pending record, no open run' "$W/out" \
  && grep -q '^users kept before --apply: 1500 ' "$W/out" && grep -q '^PASS after --apply: 1200 users differ from before (the old-network pairs it reports cleared); every other user is unchanged' "$W/out" \
  && grep -q '^PASS after --rollback every one of the 1500 users equals its state before --apply in every column but updatedAt' "$W/out" \
  && grep -q '^updatedAt differs from before --apply on 1200 users: --apply sets it (Prisma @updatedAt) and --rollback does not restore it' "$W/out" && [ ! -f "$W/s/snap" ] \
  && grep -q "$(printf '^apply\t')" "$W/ddcnew/rehearsal/timings.tsv" && grep -q "$(printf '^rollback\t')" "$W/ddcnew/rehearsal/timings.tsv" \
  && ok "apply-switch (after a report left the copy read-only): resets it, --apply timed, --rollback timed; the plan and every user against its state before --apply prove the apply and the rollback (updatedAt counted apart); the kept users dropped" || { show 40; bad "apply-switch (rc=$RC)"; }
# The record repair inside apply-switch: after --apply and its --plan, before --rollback; two runs, the second changes nothing.
order=$(sed -nE 's/^cmd node scripts\/(mainnetSwitch.js --apply|mainnetSwitch.js --rollback|backfillSocialPostIdentity.js --apply).*/\1/p' "$W/s/oneoffs" | tr '\n' '|')
[ "$RC" = 0 ] && [ "$order" = "mainnetSwitch.js --apply|backfillSocialPostIdentity.js --apply|backfillSocialPostIdentity.js --apply|mainnetSwitch.js --rollback|" ] \
  && grep -q "$(printf '^points_repair\t[0-9]*\t.*\trecord repair (backfill --apply): social rows updated, records restored, copies superseded: 7 4 6$')" "$W/ddcnew/rehearsal/timings.tsv" \
  && grep -q "$(printf '^repair_check\t[0-9]*\t.*\trecord repair check (backfill --apply again): no change$')" "$W/ddcnew/rehearsal/timings.tsv" \
  && grep -q '^PASS the second --apply changed nothing (social rows updated, records restored, copies superseded: 0 0 0)$' "$W/out" \
  && grep -q '^ *restored own identity: 4 (order id 4' "$W/out" && ! grep -q 'uid-secret' "$W/out" && ! grep -qE '^ *(user|row) uid' "$W/out" \
  && grep -q '^REPAIRED_FOR=' "$W/ddcnew/rehearsal/state.env" && ! grep -q '^WARN ' "$W/out" \
  && ok "apply-switch: the record repair runs after --apply and before --rollback, twice: the first timed as points_repair (counts in its note), the second changes nothing (repair_check); counts only in the output" || { show 40; bad "apply-switch record repair (rc=$RC, order $order)"; }
nrep() { cnt "$(printf '^points_repair\t')" "$W/ddcnew/rehearsal/timings.tsv"; }
fresh_keep; reh apply-switch
[ "$RC" = 0 ] && grep -q "^WARN an earlier apply-switch repaired this copy's records (restored .*): this run finds them done (0 0 0), so points_repair keeps that run's time" "$W/out" \
  && [ "$(nrep)" = 1 ] && [ "$(cnt "$(printf '^repair_check\t')" "$W/ddcnew/rehearsal/timings.tsv")" = 2 ] \
  && ok "apply-switch again on the same copy: the records are already repaired, so points_repair is not recorded again (a WARN says why); the check still runs" || { show 30; bad "apply-switch on a repaired copy (rc=$RC, points_repair lines $(nrep))"; }
fresh_keep; STUB_REPAIR=again reh apply-switch
[ "$RC" = 1 ] && grep -q '^FAIL the second backfillSocialPostIdentity.js --apply still changed rows or printed no counts (social rows updated, records restored, copies superseded: 7 4 6)' "$W/out" \
  && ! grep -q -- '--rollback' "$W/s/oneoffs" && ok "apply-switch: a second record repair run that still changes rows -> FAIL" || { show 20; bad "repair that does not settle (rc=$RC)"; }
rm -f "$W/s/run"; touch "$W/s/rolledback"
fresh_keep; STUB_REPAIR=fail reh apply-switch
[ "$RC" = 1 ] && grep -q '^FAIL backfillSocialPostIdentity.js --apply failed on the copy' "$W/out" && ! grep -q 'someone@example.com' "$W/out" \
  && ok "apply-switch: a record repair that fails -> FAIL (its e-mail address masked in the output)" || { show 20; bad "failed repair (rc=$RC)"; }
rm -f "$W/s/run"; touch "$W/s/rolledback"
fresh_keep; STUB_SCRIPTS="scripts/mainnetSwitch.js scripts/reportDuplicateCampaignGrants.js" reh apply-switch
[ "$RC" = 1 ] && grep -q '^FAIL scripts/backfillSocialPostIdentity.js is not in ddcnew/backend:abcdef012345: the window runs the record repair after --apply' "$W/out" && [ ! -s "$W/s/oneoffs" ] \
  && ok "apply-switch with an image without backfillSocialPostIdentity.js: refused before any one-off container" || { show 20; bad "image without the backfill (rc=$RC)"; }
fresh_keep; STUB_REPAIR=nopart2 reh apply-switch
[ "$RC" = 0 ] && grep -q "^WARN this image's backfillSocialPostIdentity.js has no record part (other sources): the time covers the social posts only" "$W/out" \
  && grep -q '^PASS the second --apply changed nothing (social rows updated, records restored, copies superseded: 0 - -)$' "$W/out" \
  && ok "apply-switch with a backfill without the record part: a WARN (the time covers the social posts only), the check on the social part" || { show 20; bad "backfill without the record part (rc=$RC)"; }
fresh_keep; STUB_DIGEST_BAD=1 reh apply-switch
[ "$RC" = 1 ] && grep -q "after --rollback 3 users differ from before --apply in a column other than updatedAt" "$W/out" && ok "apply-switch: a rollback that leaves 3 users different from before --apply -> FAIL" || { show 20; bad "rollback leaves users different (rc=$RC)"; }
fresh_keep; STUB_DIFF_APPLIED="1199 0" reh apply-switch
[ "$RC" = 1 ] && grep -q "after --apply 1199 users differ from before in a column other than updatedAt (added, removed or changed); --apply reports 1200 old-network pairs cleared" "$W/out" && ! grep -q -- '--rollback' "$W/s/oneoffs" \
  && ok "apply-switch: --apply changing a number of users other than the pairs it reports cleared -> FAIL before the rollback" || { show 20; bad "apply diff mismatch (rc=$RC)"; }
rm -f "$W/s/run"; touch "$W/s/rolledback"   # the run that FAIL left applied: as if rolled back, for the next cases
fresh_keep; STUB_ROLLBACK_RESTORED=1199 reh apply-switch
[ "$RC" = 1 ] && grep -q -- '--rollback restored 1199 accounts and deleted 1200 records, expected 1200 each' "$W/out" && ok "apply-switch: a rollback that restores one account too few -> FAIL" || { show 20; bad "rollback count (rc=$RC)"; }
echo 20261013120000_ab12 > "$W/s/run"; rm -f "$W/s/rolledback"   # a run applied and never rolled back (an apply-switch stopped half way)
fresh_keep; reh apply-switch
[ "$RC" = 1 ] && grep -q 'holds a run that was never rolled back (20261013120000_ab12)' "$W/out" && ! grep -q -- '--apply' "$W/s/oneoffs" && ok "apply-switch while the copy holds a run that was never rolled back: refused before --apply (clean timings need a fresh copy)" || { show 20; bad "open run (rc=$RC)"; }
rm -f "$W/s/run"; touch "$W/s/rolledback"
fresh_keep; STUB_APPLY=noop reh apply-switch
[ "$RC" = 1 ] && grep -q 'mainnetSwitch --apply applied nothing on the copy' "$W/out" && ok "apply-switch: an --apply with nothing to do -> FAIL (nothing to roll back)" || { show 20; bad "apply noop (rc=$RC)"; }
fresh_keep; STUB_RESTART=1 reh report
[ "$RC" = 1 ] && grep -q "the new stack's containers changed during this run" "$W/out" && ok "a new-stack container restarted during a run -> FAIL (the run says so; it does not assume it did it)" || { show 20; bad "new-stack restart (rc=$RC)"; }
rm -f "$W/s/snap-db"
fresh_keep; reh summary
TT="$W/ddcnew/rehearsal/timings.tsv"
# window(): the estimate's rows (between its heading and the "in all" line); total(): the "in all" figure; want(): the
# expected total from timings.tsv, part by part in the script's order (the latest time of each measured part;
# counts_restore and plan count twice) with the runbook figures (F<min>: 5 + 10 + 15 + 20 + 40 + 10 = 100 min).
window() { sed -n '/^cutover window estimate/,/ in all: /p' "$W/out" | sed '1d;$d'; }
total() { sed -n 's/^ *\([0-9.]*\) min  in all: .*/\1/p' "$W/out"; }
want() { awk -F'\t' '{ s[$1] = $2 } END { n = split("F5 dump_est counts_restore sha256 offsite_copy restore counts_restore F10 migrate F15 plan apply plan backfill points_repair repair_check F20 F40 F10", k, " ")
  for (i = 1; i <= n; i++) { if (k[i] ~ /^F/) t += substr(k[i], 2); else if (k[i] in s) t += s[k[i]] / 60 }; printf "%.2f", t }' "${1:-$TT}"; }
[ "$RC" = 0 ] && grep -qE '^restore +[0-9]+ s' "$W/out" && grep -qE '^apply +[0-9]+ s' "$W/out" && grep -qE '^sha256 +[0-9]+ s' "$W/out" && grep -qE '^scrub +[0-9]+ s' "$W/out" \
  && grep -qE '^points_repair +[0-9]+ s' "$W/out" && grep -qE '^repair_check +[0-9]+ s' "$W/out" \
  && [ "$(window | grep -c .)" = 19 ] && [ "$(window | grep -c '(runbook figure)$')" = 6 ] && [ "$(grep -c 'NOT MEASURED' "$W/out")" = 1 ] \
  && grep -q '^ *- *encrypted off-site copy of the final dump and its sha256 there (step 2): NOT MEASURED (offsite_copy)$' "$W/out" \
  && grep -qE '^ *[0-9]+\.[0-9]{2} min  record repair dry run \(backfillSocialPostIdentity.js, writes nothing; step 6\)$' "$W/out" \
  && grep -qE '^ *[0-9]+\.[0-9]{2} min  record repair \(backfill --apply\)$' "$W/out" \
  && grep -qE '^ *[0-9]+\.[0-9]{2} min  record repair check \(backfill --apply again, changes nothing\)$' "$W/out" \
  && grep -q '^ *5.00 min  freeze the old stack (step 1) (runbook figure)$' "$W/out" && grep -q '^ *20.00 min  web image and domain switch (step 7) (runbook figure)$' "$W/out" \
  && grep -q '^ *10.00 min  opening (step 9) (runbook figure)$' "$W/out" && [ "$(total)" = "$(want)" ] \
  && grep -q '^WARN the estimate is incomplete: 1 part(s) neither measured nor given a runbook figure (offsite_copy): no PASS until each is measured$' "$W/out" \
  && ! grep -q '^PASS the estimate' "$W/out" && [ "$(ncalls)" = 0 ] && ! grep -qE '^(run|lock):' "$W/out" \
  && ok "summary: every timing; the window estimate has its 19 parts (steps 1-9: 6 at the runbook figure; the record repair's dry run, --apply and check measured), total $(total) min = the measured parts + 100 min (two decimals); only the off-site copy NOT MEASURED, so WARN incomplete and no PASS; read-only (no docker call, no lock)" || { show 50; bad "summary (rc=$RC, total $(total), want $(want))"; }
# A part measured by hand: record writes it (run lock and log), then every part is measured: no NOT MEASURED, no WARN, PASS.
fresh_keep; reh record offsite_copy 600
[ "$RC" = 0 ] && grep -q "$(printf '^offsite_copy\t600\t.*\tmeasured by hand (./60-rehearsal.sh record)$')" "$TT" && grep -q '^PASS time: offsite_copy 600s (10 min 00 s)' "$W/out" \
  && [ "$(ncalls)" = 0 ] && ls "$W/ddcnew/logs/"*-60-rehearsal-record-*.log >/dev/null 2>&1 \
  && ok "record offsite_copy 600: one line in timings.tsv (with its note), under the run lock and log, no docker call" || { show 20; bad "record (rc=$RC)"; }
fresh_keep; reh summary
[ "$RC" = 0 ] && ! grep -q 'NOT MEASURED' "$W/out" && ! grep -q '^WARN' "$W/out" && grep -q '^PASS the estimate fits the 180-minute window$' "$W/out" && [ "$(window | grep -c .)" = 19 ] && [ "$(total)" = "$(want)" ] \
  && ok "summary with every part measured: no NOT MEASURED, no WARN, PASS (total $(total) min)" || { show 30; bad "summary fully measured (rc=$RC, total $(total), want $(want))"; }
printf 'restore\t5400\t2026-10-13T20:00:00+0800\ta slower restore\n' >> "$TT"
fresh_keep; reh summary
[ "$RC" = 0 ] && grep -q "^WARN the estimate is longer than the 180-minute window ($(want) min): lengthen the window and the notice$" "$W/out" && ! grep -q '^PASS the estimate' "$W/out" && [ "$(total)" = "$(want)" ] \
  && ok "summary with a 90-minute restore: total $(total) min > 180 -> WARN with the total, no PASS" || { show 30; bad "summary too long (rc=$RC, total $(total), want $(want))"; }
# Hand-made timings (the real file kept aside): a part used twice and missing is listed once; the total is printed with
# two decimals and that figure is compared: 180.00 passes, 180.03 (one second more than 80 min measured) does not.
cp "$TT" "$TT.keep"
tsv() { : > "$TT"; for k in dump_est sha256 offsite_copy restore migrate plan apply backfill points_repair repair_check counts_restore; do
  case " $* " in *" -$k "*) continue;; esac
  v=0; [ "$k" = restore ] && v="${RESTORE_S:-0}"; printf '%s\t%s\t2026-10-13T20:00:00+0800\thand-made\n' "$k" "$v" >> "$TT"; done; }
tsv -counts_restore -offsite_copy; fresh_keep; reh summary
[ "$RC" = 0 ] && [ "$(grep -c 'NOT MEASURED (counts_restore)' "$W/out")" = 2 ] \
  && grep -q '^WARN the estimate is incomplete: 2 part(s) neither measured nor given a runbook figure (counts_restore offsite_copy): no PASS until each is measured$' "$W/out" \
  && ok "summary: counts_restore (used twice) and offsite_copy missing -> two NOT MEASURED rows for counts_restore, but each part named once in the WARN (2 parts)" || { show 30; bad "summary missing list (rc=$RC)"; }
RESTORE_S=4800 tsv; fresh_keep; reh summary
[ "$RC" = 0 ] && [ "$(total)" = 180.00 ] && grep -q '^PASS the estimate fits the 180-minute window$' "$W/out" && ! grep -q '^WARN' "$W/out" \
  && ok "summary at exactly 180.00 min: PASS" || { show 30; bad "summary at 180.00 (rc=$RC, total $(total))"; }
RESTORE_S=4802 tsv; fresh_keep; reh summary
[ "$RC" = 0 ] && [ "$(total)" = 180.03 ] && grep -q '^WARN the estimate is longer than the 180-minute window (180.03 min): lengthen the window and the notice$' "$W/out" && ! grep -q '^PASS the estimate' "$W/out" \
  && ok "summary at 180.03 min: printed as 180.03 and WARN, no PASS (the printed figure is the one compared)" || { show 30; bad "summary at 180.03 (rc=$RC, total $(total))"; }
mv -f "$TT.keep" "$TT"
recs() { find "$W/ddcnew/rehearsal" -maxdepth 1 -type f \( -name '[0-9]*-[0-9]*-*.out' -o -name '[0-9]*-[0-9]*-*.err' \); }   # the records with ids
outs=$(recs | grep -c . || true)
fresh_keep; reh cleanup
[ "$RC" = 0 ] && [ "$(cat "$W/s/copy")" = absent ] && grep -q '^PASS ddc_rehearsal_copy dropped' "$W/out" && [ ! -e "$W/ddcnew/rehearsal/compose.copy.yaml" ] && grep -q "$(printf '^cleanup\t')" "$W/ddcnew/rehearsal/timings.tsv" \
  && grep -q 'does not carry the rehearsal mark' "$W/s/sql.log" && [ "$outs" -gt 5 ] && grep -q "^PASS records with user or row ids removed: $outs file(s)" "$W/out" \
  && [ -z "$(recs)" ] && [ -z "$(find "$W/ddcnew/rehearsal" -name '*.out' -o -name '*.err')" ] && [ -f "$W/ddcnew/rehearsal/state.env" ] && [ -f "$W/ddcnew/rehearsal/counts-dump.txt" ] \
  && ok "cleanup: drops the copy (the session first checks its mark), removes the override and the $outs records with user or row ids, keeps the timings, state and counts" || { show 20; bad "cleanup (rc=$RC, records before $outs)"; }
fresh_keep; reh cleanup
[ "$RC" = 0 ] && grep -q '^PASS ddc_rehearsal_copy does not exist: nothing to drop' "$W/out" && ok "cleanup again: nothing to drop" || { show; bad "second cleanup (rc=$RC)"; }

echo "-- across every run above"
v=$(grep -c VIOLATION "$W/s/sql.log" 2>/dev/null || true)
dbs=$(sed -n 's/^db=\([^ ]*\) .*/\1/p' "$W/s/sql.log" | LC_ALL=C sort -u | tr '\n' ' ')
[ "${v:-0}" = 0 ] && [ "$dbs" = "ddc_rehearsal_copy postgres " ] && ok "psql connected only to postgres and $COPY (no other database, in the last rehearsal's sessions)" || bad "psql sessions on: $dbs (violations: $v)"
leak=$(grep -rlE 'DUMMYSECRET|uid-secret|someone@example\.com' "$W/ddcnew/logs" 2>/dev/null | tr '\n' ' ')
[ -z "$leak" ] && ok "no secret, user id or e-mail address in any server-side run log" || bad "leak in: $leak"
leak=$(grep -lE 'DUMMYSECRET' "$W/ddcnew/rehearsal/"* 2>/dev/null | tr '\n' ' ')
[ -z "$leak" ] && ok "no secret in any record the script wrote (the copy's URL is never written to a file)" || bad "secret in: $leak"
[ "$(stat -c %a "$W/ddcnew/rehearsal" 2>/dev/null || stat -f %Lp "$W/ddcnew/rehearsal")" = 700 ] && [ -z "$(find "$W/ddcnew/rehearsal" -type f ! -perm 600 | head -n 1)" ] \
  && ok "records: directory 700, every file 600" || bad "record modes: $(ls -la "$W/ddcnew/rehearsal")"
old=$(grep 'ddc-backend-ddc-backend-db-1' "$W/s/allcalls" | grep -vE '^inspect --format |^exec ddc-backend-ddc-backend-db-1 sh -c psql -U "\$POSTGRES_USER" -d "\$0" -tAc "SELECT pg_database_size\(current_database\(\)\)" ddc$' | head -n 3)
[ -z "$old" ] && ok "the old database container: only inspected, and asked for its size" || bad "other calls on the old database container: $old"

echo "-- the gate itself (GATE_JS, the real node) and the override (the real docker compose)"
if command -v node >/dev/null 2>&1 && [ -s "$W/s/gate.js" ]; then
  g=0
  for c in "0|postgresql://u:DUMMYSECRET-pw@db:5432/$COPY?schema=public" "0|postgresql://u:DUMMYSECRET-pw@db/$COPY" "97|postgresql://u:DUMMYSECRET-pw@db:5432/ddc_rehearsal?schema=public" \
           "97|postgresql://u:DUMMYSECRET-pw@ddc-backend-db:5432/$COPY?schema=public" "97|postgresql://u:DUMMYSECRET-pw@db:5433/$COPY" "97|postgresql://u:DUMMYSECRET-pw@db:5432/$COPY?schema=other" \
           "97|postgresql://u:DUMMYSECRET-pw@db:5432/${COPY}x" "97|"; do
    rc=0; o=$(DATABASE_URL="${c#*|}" REHEARSAL_EXPECT_DB=$COPY node -e "$(cat "$W/s/gate.js")" 2>&1) || rc=$?
    [ "$rc" = "${c%%|*}" ] && [[ "$o" != *DUMMYSECRET* ]] && g=$((g + 1)) || bad "gate on ${c#*|}: exit $rc, printed $o"
  done
  rc=0; DATABASE_URL="postgresql://u:p@db:5432/$COPY" node -e "$(cat "$W/s/gate.js")" >/dev/null 2>&1 || rc=$?
  [ "$rc" = 97 ] && g=$((g + 1)) || bad "gate without REHEARSAL_EXPECT_DB: exit $rc"
  [ "$g" = 9 ] && ok "GATE_JS (real node): passes only db:5432/$COPY with schema public; refuses the live database, another host or port, another schema, a longer name, no URL and no expected name (9 cases); never prints the password"
else echo "SKIP the gate's own cases need node (run on the Mac)"; fi
if [ -n "$REAL_DOCKER" ] && "$REAL_DOCKER" compose version >/dev/null 2>&1 && [ -s "$W/override-copy.yaml" ]; then
  D="$W/compose-real"; mkdir -p "$D"; cp "$PKG/compose.yaml" "$D/"; cp "$W/override-copy.yaml" "$D/compose.copy.yaml"; cp "$W/ddcnew/.env" "$W/ddcnew/.env.api" "$W/ddcnew/.env.db" "$D/"
  cfg() { (cd "$D" && API_PORT=10020 WEB_PORT=9021 DB_PORT=15434 "$REAL_DOCKER" compose -p ddcnew --project-directory "$D" "$@" config --format json) 2>&1; }
  view='import json, sys
a = json.load(sys.stdin)["services"]["api"]; e = a.get("environment", {})
print(a["image"], e.get("DATABASE_URL", "").split("@")[-1], e.get("NODE_ENV"), e.get("REHEARSAL_EXPECT_DB"), sorted(p.get("published") for p in a.get("ports", [])), len(a.get("volumes", [])))'
  base=$(cfg -f compose.yaml | python3 -c "$view" 2>&1)
  over=$(REHEARSAL_IMAGE=ddcnew/backend:abcdef012345 REHEARSAL_DATABASE_URL="postgresql://ddcuser:DUMMYSECRET-dbpw@db:5432/$COPY?schema=public" REHEARSAL_EXPECT_DB=$COPY cfg -f compose.yaml -f compose.copy.yaml | python3 -c "$view" 2>&1)
  [ "$base" = "ddcnew/backend:0123456789ab db:5432/ddc_rehearsal?schema=public production None ['10020'] 3" ] \
    && [ "$over" = "ddcnew/backend:abcdef012345 db:5432/$COPY?schema=public production $COPY ['10020'] 3" ] \
    && ok "the override (real docker compose): the api service gets the release image and DATABASE_URL = the copy over .env.api's, and keeps everything else (env file, port, mounts)" \
    || bad "override semantics: base [$base] with the override [$over]"
  miss=$(REHEARSAL_IMAGE=ddcnew/backend:abcdef012345 REHEARSAL_EXPECT_DB=$COPY cfg -f compose.yaml -f compose.copy.yaml || true)
  [[ "$miss" == *"60-rehearsal.sh sets it"* ]] && ok "the override without REHEARSAL_DATABASE_URL: compose refuses to run (no fallback to the live database)" || bad "override without the URL: $miss"
  grep -q DUMMYSECRET "$W/override-copy.yaml" && bad "the override file holds a secret" || ok "the override file holds no secret (only \${...} references)"
else echo "SKIP the override check needs the real docker compose (run on the Mac)"; fi

echo "rehearsal-cases.sh: $(bash --version | head -n 1 | cut -c1-40), fails=$fails"
[ "$fails" = 0 ]
