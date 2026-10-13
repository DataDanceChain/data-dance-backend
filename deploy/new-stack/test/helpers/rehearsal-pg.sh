#!/usr/bin/env bash
# rehearsal-pg.sh <package dir> <work dir> <run id>   (local test helper; needs Docker Desktop and node; macOS)
# 60-rehearsal.sh's SQL against a REAL Postgres 17: a stub docker forwards every psql and pg_restore session the script
# opens on ddcnew-db-1 to a throwaway postgres:17 container (label ddcnew-localtest=<run id>, no published port, removed
# at the end), and runs the dump's `pg_restore --list` in a real postgres:17 container too. The one-off containers and
# the scripts' outputs are emulated as in rehearsal-cases.sh. In the cluster: ddc_rehearsal, a small SYNTHETIC "live"
# database (the one the stub api reports), dumped as the P1 daily dump. Checks: the real mark, row counts and digests;
# the live database unchanged by the whole rehearsal; the in-Postgres gate refuses a session on another database; the
# in-Postgres mark check refuses DROP DATABASE on an unmarked copy; the G8 scrub (and keep); --apply and --rollback
# emulated with the real script's SQL on the copy (the four columns, and updatedAt as Prisma sets it), so that the
# rollback check runs against real rows. Prints PASS/FAIL lines; exit 1 on FAIL.
set -u
PKG="$1"; W="$2"; RID="$3"
D=$(command -v docker) || { echo "FAIL rehearsal-pg.sh needs docker"; exit 1; }
command -v node >/dev/null || { echo "FAIL rehearsal-pg.sh needs node"; exit 1; }
unset API_HOST APP_HOST API_PORT WEB_PORT DB_PORT TAKE_OVER_VHOSTS REHEARSAL_CLIENT_ID REHEARSAL_G8 DDC_RUN_LOG DDC_LOCK_HELD
rm -rf "$W"; mkdir -p "$W/bin" "$W/backup/pg" "$W/ddcnew" "$W/switch" "$W/old" "$W/avail" "$W/enabled" "$W/confd" "$W/s"
fails=0; ok() { echo "PASS $*"; }; bad() { echo "FAIL $*"; fails=$((fails+1)); }
COPY=ddc_rehearsal_copy
PG="rehpg-$RANDOM-$RID"
trap '"$D" rm -fv "$PG" >/dev/null 2>&1 || true' EXIT
"$D" run -d --label "ddcnew-localtest=$RID" --name "$PG" --network none -e POSTGRES_USER=ddcuser -e POSTGRES_PASSWORD=DUMMYSECRET-pg -e POSTGRES_DB=ddcnew postgres:17 >/dev/null \
  || { echo "FAIL cannot start postgres:17"; exit 1; }
for _ in $(seq 1 60); do "$D" exec "$PG" pg_isready -h 127.0.0.1 -U ddcuser >/dev/null 2>&1 && break; sleep 1; done
sleep 2; "$D" exec "$PG" pg_isready -h 127.0.0.1 -U ddcuser >/dev/null 2>&1 || { echo "FAIL postgres:17 did not become ready"; exit 1; }
pq() { "$D" exec -i "$PG" psql -X -q -v ON_ERROR_STOP=1 -U ddcuser -d "$1" -tA; }   # <database>, SQL on stdin
# The synthetic live database: the tables the script reads (User with the four switch columns, the four sensitive
# columns of gate G8, partly NULL, and updatedAt; the rebind tables). Users 1-250 hold an old-network pair.
pq postgres <<< 'CREATE DATABASE ddc_rehearsal;' && pq ddc_rehearsal <<'SQL' || bad "cannot create the synthetic live database"
CREATE TABLE "User" (id text PRIMARY KEY, email text, password text, "privateKey" text, "xAccessToken" text, "xRefreshToken" text, "walletAddress" text,
  "web3authVerifier" text, "web3authVerifierId" text, "web3authLinkedAt" timestamp(3), "updatedAt" timestamp(3) NOT NULL);
INSERT INTO "User" SELECT 'uid-secret-' || g, 'someone' || g || '@example.com', CASE WHEN g % 3 = 0 THEN 'DUMMYSECRET-pwhash-' || g END,
  CASE WHEN g % 10 = 0 THEN 'DUMMYSECRET-key-' || g END, CASE WHEN g % 4 = 0 THEN 'DUMMYSECRET-xat-' || g END, CASE WHEN g % 4 = 0 THEN 'DUMMYSECRET-xrt-' || g END,
  '0x' || md5(g::text), CASE WHEN g <= 250 THEN 'web3auth-google-sapphire-devnet' END, CASE WHEN g <= 250 THEN 'vid-' || g END,
  CASE WHEN g <= 250 THEN now() - interval '2 days' END, now() - interval '1 day' FROM generate_series(1, 300) g;
CREATE TABLE "Point" (id serial PRIMARY KEY, "userId" text REFERENCES "User"(id), amount int);
INSERT INTO "Point" ("userId", amount) SELECT 'uid-secret-' || (g % 300 + 1), g FROM generate_series(1, 1000) g;
CREATE TABLE "Web3AuthNetworkRebind" (id text PRIMARY KEY);
CREATE TABLE "Web3AuthNetworkRebindRun" (id text PRIMARY KEY);
CREATE TABLE "_prisma_migrations" (id text PRIMARY KEY);
INSERT INTO "_prisma_migrations" VALUES ('m1'), ('m2');
SQL
live_state() { pq ddc_rehearsal <<< "SELECT (SELECT count(*) FROM \"User\") || ' ' || (SELECT count(*) FROM \"Point\") || ' ' || md5(string_agg(md5(ROW(u.*)::text), '' ORDER BY id)) || ' ' || coalesce(shobj_description((SELECT oid FROM pg_database WHERE datname = 'ddc_rehearsal'), 'pg_database'), '-') || ' ' || current_setting('default_transaction_read_only') FROM \"User\" u;"; }
LIVE0=$(live_state)
DUMP="$W/backup/pg/ddc-daily-20261013-0315.dump"
"$D" exec "$PG" pg_dump -U ddcuser -d ddc_rehearsal -Fc > "$DUMP" || bad "pg_dump of the synthetic live database"
if command -v sha256sum >/dev/null; then s=$(sha256sum < "$DUMP" | cut -c1-64); else s=$(shasum -a 256 < "$DUMP" | cut -c1-64); fi
printf '%s  %s\n' "$s" "$(basename "$DUMP")" > "$DUMP.sha256"; touch -t 202610130321 "$DUMP"

cat > "$W/bin/docker" <<'EOF'
#!/bin/bash
# stub docker that forwards ddcnew-db-1's sessions to a real postgres:17 ($STUB_PG); see rehearsal-pg.sh
S="$STUB_DIR"; D="$STUB_REAL_DOCKER"
printf '%s\n' "$*" >> "$S/calls"
case "$1" in
  ps) if [[ "$*" == *'{{.Names}}'* ]]; then printf '%s\n' ddc-backend-ddc-backend-db-1 ddcnew-api-1 ddcnew-db-1 ddcnew-web-1; fi; exit 0;;
  image) case "$2" in inspect) [ "$3" = ddcnew/backend:0123456789ab ] && exit 0; exit 1;; ls) echo ddcnew/backend:0123456789ab; exit 0;; esac; exit 1;;
  inspect)
    c="${!#}"
    case "$3" in
      *RestartPolicy*) echo "/$c|feed-$c|running|2026-09-20T00:00:00Z|0|always";;
      *RestartCount*) echo "/$c|id-$c|running|2026-10-10T00:00:00Z|0";;
      *Labels*) echo ddcnew/db;;
      *Health*) echo healthy;;
      *Config.Image*) echo ddcnew/backend:0123456789ab;;
    esac; exit 0;;
  exec)
    shift; [ "$1" = -i ] && shift; ctr="$1"; shift
    case "$ctr" in
      ddcnew-api-1) echo "db ddc_rehearsal"; exit 0;;
      ddc-backend-ddc-backend-db-1) echo 1073741824; exit 0;;
    esac
    [ "$ctr" = ddcnew-db-1 ] && [ "$1" = sh ] && [ "$2" = -c ] || { echo "stub exec: unexpected $ctr $*" >&2; exit 1; }
    db="$4"
    echo "db=$db" >> "$S/sessions"
    # STUB_REDIRECT_COPY: a psql session meant for the copy lands on that database instead (the gate must refuse it)
    if [ "$db" = ddc_rehearsal_copy ] && [ -n "${STUB_REDIRECT_COPY:-}" ] && [[ "$3" != *pg_restore* ]]; then db="$STUB_REDIRECT_COPY"; fi
    if [ "${STUB_FAKE_MARKED:-0}" = 1 ] && [ "$db" = postgres ]; then
      sql=$(cat)
      # STUB_FAKE_MARKED: the script is told the copy carries the mark; Postgres itself must still refuse the DROP
      if [[ "$sql" == "SELECT 'db:'"* ]]; then echo "db:ddcnew-rehearsal-copy: (faked by the test)"; exit 0; fi
      printf '%s\n' "$sql" | "$D" exec -i "$STUB_PG" sh -c "$3" "$db"; exit $?
    fi
    exec "$D" exec -i "$STUB_PG" sh -c "$3" "$db";;
  run)
    if [[ "$*" == *"pg_restore --list"* ]]; then exec "$D" run --rm -i --network none --label "ddcnew-localtest=$STUB_RID" postgres:17 pg_restore --list; fi
    if [[ "$*" == *"--entrypoint sh"* ]]; then printf '%s\n' scripts/mainnetSwitch.js scripts/backfillSocialPostIdentity.js scripts/reportDuplicateCampaignGrants.js; exit 0; fi
    exit 1;;
  compose)
    while [ $# -gt 0 ] && [ "$1" != api ]; do shift; done
    shift; [ "$1" = sh ] && [ "$4" = rehearsal-gate ] || exit 1
    gate="$5"; shift 5
    DATABASE_URL="${REHEARSAL_DATABASE_URL:-}" REHEARSAL_EXPECT_DB="${REHEARSAL_EXPECT_DB:-}" node -e "$gate" || exit 97
    case "$*" in
      true) exit 0;;
      "npx prisma migrate status") printf '2 migrations found in prisma/migrations\n\nDatabase schema is up to date!\n';;
      "npx prisma migrate deploy") printf '2 migrations found in prisma/migrations\nNo pending migrations to apply.\n';;
      "node scripts/mainnetSwitch.js --plan --json"*)
        to=300; pend=0; runs='[]'
        if [ -f "$S/run" ]; then to=0; pend=300; runs='[{"id": "20261013120000_ab12", "rolled_back_at": null}]'
        elif [ -f "$S/rolledback" ]; then runs='[{"id": "20261013120000_ab12", "rolled_back_at": "2026-10-13T12:05:00Z"}]'; fi
        printf '{"mode": "plan", "go": true, "blockers": [], "warnings": [], "from_network": "sapphire_devnet", "to_network": "sapphire_mainnet", "report": {"users_total": 300, "records": {"pending": %s, "rebound": 0}, "to_record": {"total": %s}, "not_automatic": {}}, "runs": %s}\n' "$pend" "$to" "$runs";;
      "node scripts/mainnetSwitch.js --apply --yes --json"*)   # scripts/mainnetSwitch.js apply(): backup, then clear the stale pairs (updateMany: updatedAt too)
        "$D" exec -i "$STUB_PG" psql -X -q -v ON_ERROR_STOP=1 -U ddcuser -d ddc_rehearsal_copy -tA > /dev/null <<'SQL' || exit 3
BEGIN;
CREATE TABLE mainnet_switch_backup_20261013120000_ab12 AS SELECT id, "walletAddress", "web3authVerifier", "web3authVerifierId", "web3authLinkedAt", now() AS "backedUpAt" FROM "User";
UPDATE "User" SET "web3authVerifier" = NULL, "web3authVerifierId" = NULL, "web3authLinkedAt" = NULL, "updatedAt" = now() WHERE "web3authVerifier" IS NOT NULL;
COMMIT;
SQL
        touch "${S:?}/run"; rm -f "${S:?}/rolledback"
        echo '{"mode": "apply", "go": true, "applied": true, "run_id": "20261013120000_ab12", "backup_table": "mainnet_switch_backup_20261013120000_ab12", "accounts": 300, "old_network_pairs_cleared": 250}';;
      "node scripts/mainnetSwitch.js --rollback --run 20261013120000_ab12 --yes --json")   # rollback(): the four columns from the backup, updatedAt untouched
        { printf '%s\n' 'UPDATE "User" u SET "walletAddress" = b."walletAddress", "web3authVerifier" = b."web3authVerifier", "web3authVerifierId" = b."web3authVerifierId", "web3authLinkedAt" = b."web3authLinkedAt" FROM mainnet_switch_backup_20261013120000_ab12 b WHERE u.id = b.id;'
          # STUB_ROLLBACK_EXTRA=1: one user ends with another e-mail address (a column outside the four)
          if [ "${STUB_ROLLBACK_EXTRA:-0}" = 1 ]; then printf '%s\n' "UPDATE \"User\" SET email = 'changed@example.com' WHERE id = 'uid-secret-7';"; fi
        } | "$D" exec -i "$STUB_PG" psql -X -q -v ON_ERROR_STOP=1 -U ddcuser -d ddc_rehearsal_copy -tA > /dev/null || exit 3
        rm -f "${S:?}/run"; touch "${S:?}/rolledback"
        echo '{"mode": "rollback", "go": true, "rolled_back": true, "run_id": "20261013120000_ab12", "accounts_restored": 300, "records_deleted": 300}';;
      "node scripts/backfillSocialPostIdentity.js") printf 'mode dry-run: scanned 0 social rows\n  would update: 0\n';;
      "node scripts/reportDuplicateCampaignGrants.js") printf 'one-time campaign grants written more than once: 0 group(s)\n';;
      *) exit 1;;
    esac; exit 0;;
esac
exit 1
EOF
printf '#!/bin/bash\ncase "$*" in *"/partner/tge/me"*) printf 401;; *) printf 000;; esac\n' > "$W/bin/curl"
printf '#!/bin/bash\nprintf "Filesystem 1024-blocks Used Available Capacity Mounted on\\n/dev/stub 104857600 1 51200000 1%%%% /\\n"\n' > "$W/bin/df"
chmod 755 "$W/bin/docker" "$W/bin/curl" "$W/bin/df"
printf 'MemTotal:       16000000 kB\nMemAvailable:    8000000 kB\n' > "$W/meminfo"
cp "$PKG/compose.yaml" "$W/ddcnew/compose.yaml"
printf 'API_IMAGE=ddcnew/backend:0123456789ab\nWEB_IMAGE=ddcnew/web:tge-0123456789ab\nINFRA_ONLY=0\n' > "$W/ddcnew/.env"
printf 'DATABASE_URL="postgresql://ddcuser:DUMMYSECRET-pg@db:5432/ddc_rehearsal?schema=public"\n' > "$W/ddcnew/.env.api"
printf 'POSTGRES_USER=ddcuser\nPOSTGRES_PASSWORD=DUMMYSECRET-pg\nPOSTGRES_DB=ddcnew\n' > "$W/ddcnew/.env.db"
reh() {
  RC=0
  env PATH="$W/bin:$PATH" STUB_DIR="$W/s" STUB_REAL_DOCKER="$D" STUB_PG="$PG" STUB_RID="$RID" DDC_LOCAL_TEST=1 NEW_DIR="$W/ddcnew" BACKUP_DIR="$W/backup" \
    SWITCH_DIR="$W/switch" OLD_BACKEND_DIR="$W/old/ddc-backend" OLD_APP_DIR="$W/old/ddc" OLD_ENV="$W/old/ddc-backend/backend.env" MAINNET_DIR="$W/old/ddc-mainnet" \
    NGINX_AVAIL="$W/avail" NGINX_ENABLED="$W/enabled" NGINX_CONFD="$W/confd" DDC_MEMINFO="$W/meminfo" BUILD_WATCH_INTERVAL=1 \
    REHEARSAL_G8="${REHEARSAL_G8-scrub}" bash "$PKG/60-rehearsal.sh" "$@" > "$W/out" 2>&1 < /dev/null || RC=$?
}
show() { sed 's/^/    /' "$W/out" | tail -n "${1:-15}"; }
copy_comment() { pq postgres <<< "SELECT coalesce(shobj_description(oid, 'pg_database'), '<none>') FROM pg_database WHERE datname = '$COPY';"; }
counts() { pq "$1" <<< "SELECT (SELECT count(*) FROM \"User\") || ' ' || (SELECT count(*) FROM \"Point\") || ' ' || (SELECT count(*) FROM \"_prisma_migrations\");"; }
# <database>: non-NULL values of the four G8 columns, then the users holding a value other than the placeholder
sens() { pq "$1" <<< "SELECT count(password) || ' ' || count(\"privateKey\") || ' ' || count(\"xAccessToken\") || ' ' || count(\"xRefreshToken\") || ' ' || count(*) FILTER (WHERE password <> 'rehearsal-scrubbed' OR \"privateKey\" <> 'rehearsal-scrubbed' OR \"xAccessToken\" <> 'rehearsal-scrubbed' OR \"xRefreshToken\" <> 'rehearsal-scrubbed') FROM \"User\";"; }

reh preflight
[ "$RC" = 0 ] && grep -q '^PASS REHEARSAL PREFLIGHT PASS' "$W/out" && grep -q '^PASS ddc_rehearsal_copy does not exist yet' "$W/out" && grep -q 'databases in the new cluster: ddc_rehearsal=' "$W/out" \
  && ok "preflight on a real Postgres 17: PASS (the copy absent, the cluster's databases listed)" || { show 30; bad "preflight (rc=$RC)"; }
reh restore
[ "$RC" = 0 ] && grep -q '^PASS tables=5 rows=1302 User=300' "$W/out" && [[ "$(copy_comment)" == "ddcnew-rehearsal-copy: restored by deploy/new-stack/60-rehearsal.sh, never production ddc-daily-20261013-0315.dump" ]] \
  && [ "$(counts $COPY)" = "$(counts ddc_rehearsal)" ] && grep -q 'pg_restore --list ok: .* entries, with the User table' "$W/out" \
  && ok "restore on a real Postgres 17: the copy created with its mark (COMMENT ON DATABASE), the real dump restored, the exact counts equal the live database's" || { show 30; bad "restore (rc=$RC, comment: $(copy_comment))"; }
sl=$(sens ddc_rehearsal); sc=$(sens $COPY)
[ "${sc% *}" = "${sl% *}" ] && [ "${sc##* }" = 0 ] && [ "${sl##* }" -gt 0 ] && grep -q "^PASS G8 scrub: User.password ${sl%% *}, " "$W/out" \
  && ok "the G8 scrub on a real Postgres 17: every non-NULL value of password, privateKey, xAccessToken and xRefreshToken replaced, NULL kept (non-NULL per column ${sc% *} on the copy and live); the live database keeps its ${sl##* } users' values" || { show 30; bad "scrub (live $sl, copy $sc)"; }
reh migrate
[ "$RC" = 0 ] && grep -q '^PASS the copy has Web3AuthNetworkRebind and Web3AuthNetworkRebindRun' "$W/out" && ok "migrate: the real rebind-table query finds both tables on the copy" || { show; bad "migrate (rc=$RC)"; }
reh report
ro_after=$(pq $COPY <<< "SELECT current_setting('default_transaction_read_only');")
[ "$RC" = 0 ] && grep -q '^PASS a new session on ddc_rehearsal_copy is read-only' "$W/out" && grep -q 'tables: identical 5, more rows 0, new 0, missing or fewer rows 0' "$W/out" && [ "$ro_after" = off ] \
  && ok "report: the real ALTER DATABASE ... SET default_transaction_read_only makes new sessions read-only, RESET undoes it; the real counts match the dump's" || { show 30; bad "report (rc=$RC, read-only after: $ro_after)"; }
pq postgres <<< "ALTER DATABASE $COPY SET default_transaction_read_only = on;"
w=$(pq $COPY <<< 'INSERT INTO "_prisma_migrations" VALUES ($$x$$);' 2>&1 || true)
pq postgres <<< "ALTER DATABASE $COPY RESET default_transaction_read_only;"
[[ "$w" == *"read-only transaction"* ]] && ok "  ... and while it is set, a write on the copy is refused by Postgres (cannot execute INSERT in a read-only transaction)" || bad "a write under default_transaction_read_only: $w"
reh apply-switch
left=$(pq $COPY <<< "SELECT count(*) FROM information_schema.tables WHERE table_name = 'rehearsal_users_before';")
[ "$RC" = 0 ] && grep -q '^users kept before --apply: 300 ' "$W/out" && grep -q '^PASS after --apply: 250 users differ from before (the old-network pairs it reports cleared)' "$W/out" \
  && grep -q '^PASS after --rollback every one of the 300 users equals its state before --apply in every column but updatedAt' "$W/out" \
  && grep -q '^updatedAt differs from before --apply on 250 users' "$W/out" && [ "$left" = 0 ] \
  && ok "apply-switch on real rows: --apply (the script's SQL: backup, clear 250 pairs, updatedAt set) changes exactly those 250 users; after --rollback all 300 equal their state before in every column but updatedAt, which stays changed on 250 (counted apart); the kept users dropped" || { show 30; bad "apply-switch (rc=$RC, kept table left: $left)"; }
# A rollback that leaves one user different in a column outside the four switch columns: FAIL (a digest of the four
# columns alone would have passed it).
reh cleanup; reh restore; STUB_ROLLBACK_EXTRA=1 reh apply-switch
[ "$RC" = 1 ] && grep -q 'after --rollback 1 users differ from before --apply in a column other than updatedAt' "$W/out" \
  && ok "apply-switch on real rows: a rollback that leaves one user with another e-mail address -> FAIL" || { show 20; bad "rollback with an extra change (rc=$RC)"; }
# REHEARSAL_G8=keep: the copy holds the sensitive values as the dump does. Then the in-Postgres gate: a session meant for
# the copy that lands on another database refuses before its statements.
reh cleanup; REHEARSAL_G8=keep reh restore
[ "$RC" = 0 ] && [ "$(sens $COPY)" = "$(sens ddc_rehearsal)" ] && grep -q '^WARN G8 keep' "$W/out" && ok "restore with REHEARSAL_G8=keep on a real Postgres 17: the sensitive values as the dump has them ($(sens $COPY))" || { show 20; bad "keep (rc=$RC)"; }
STUB_REDIRECT_COPY=ddc_rehearsal reh report
[ "$RC" = 1 ] && grep -q 'refusing: this session is not on the marked rehearsal copy' "$W/out" && [ "$(live_state)" = "$LIVE0" ] \
  && ok "the gate inside Postgres: a copy session that lands on the live database raises before any statement (the live database: same rows, digest, no comment, not read-only)" || { show 20; bad "gate redirect (rc=$RC)"; }
# The in-Postgres mark check: DROP DATABASE of an unmarked database named like the copy is refused by Postgres itself.
reh cleanup
pq postgres <<< "CREATE DATABASE $COPY;"
STUB_FAKE_MARKED=1 reh cleanup
exists=$(pq postgres <<< "SELECT count(*) FROM pg_database WHERE datname = '$COPY';")
[ "$RC" = 1 ] && [ "$exists" = 1 ] && grep -q 'does not carry the rehearsal mark' "$W/out" \
  && ok "the mark check inside Postgres: told (falsely) that an unmarked $COPY carries the mark, cleanup's DROP is still refused by Postgres; the database stays" || { show 20; bad "mark check (rc=$RC, exists=$exists)"; }
reh cleanup
[ "$RC" = 1 ] && grep -q "exists WITHOUT this script's mark" "$W/out" && ok "cleanup of the unmarked $COPY: refused by the script" || { show; bad "unmarked cleanup (rc=$RC)"; }
reh restore
[ "$RC" = 1 ] && grep -q "exists WITHOUT this script's mark" "$W/out" && ok "restore over the unmarked $COPY: refused" || { show; bad "restore over unmarked (rc=$RC)"; }
pq postgres <<< "DROP DATABASE $COPY;"
[ "$(live_state)" = "$LIVE0" ] && ok "the synthetic live database (ddc_rehearsal) is exactly as before the whole run: rows, digest of every User row, no comment, not read-only" || bad "the live database changed: $LIVE0 -> $(live_state)"
dbs=$(sort -u "$W/s/sessions" | tr '\n' ' ')
[ "$dbs" = "db=ddc_rehearsal_copy db=postgres " ] && ok "every session the script opened was on postgres or $COPY" || bad "sessions: $dbs"
leak=$(grep -lE 'DUMMYSECRET|uid-secret|example\.com' "$W/out" "$W/ddcnew/logs/"* 2>/dev/null | tr '\n' ' ')
[ -z "$leak" ] && ok "no secret, user id or e-mail address of the synthetic data in the output or the server-side logs" || bad "leak in: $leak"
echo "rehearsal-pg.sh: postgres $("$D" exec "$PG" postgres --version | awk '{print $3}'), fails=$fails"
[ "$fails" = 0 ]
