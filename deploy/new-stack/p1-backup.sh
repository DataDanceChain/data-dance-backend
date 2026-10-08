#!/usr/bin/env bash
# p1-backup.sh - runbook 4.0 P1 adapted to 2026-10-04 facts: one-off dump, integrity check, restore test, daily cron.
#
# CHANGES ON THE SERVER
#   dump          creates /root/backup (700) and /root/backup/pg (700); writes ddc-<label>-<ts>.dump (600),
#                 its .sha256 (600) and a line in backup.log. Reads the old database with pg_dump only
#                 (ACCESS SHARE locks, no writes to ddc).
#   verify        runs a throwaway container ddcnew-restore-test-20261004 (postgres:17, --network none),
#                 restores the dump into it, counts rows, then removes the container AND its anonymous
#                 volume (trap, also on failure). Reads the old database for one row count.
#   install-cron  writes /root/backup/ddc-pgdump.sh (700), checks it with bash -n, and only then the cron entry
#                 /etc/cron.d/ddc-pgdump (644): daily 03:15 CST, keeps 7 days of ddc-daily-*.dump; one-off dumps are never rotated.
#   status        read-only.
#   dump, verify, install-cron and uninstall-cron also take the run lock /root/ddcnew/.lock and log their output to
#   /root/ddcnew/logs/<ts>-p1-backup-<mode>-<pid>.log (600; common.sh run_begin). status writes nothing.
# PASS CRITERIA THAT STOP THE SCRIPT (verify): sha256 mismatch, pg_restore --list failing or listing nothing,
#   pg_restore exit != 0, a restored user count that is not a number or is below P1_USERS_MIN. A restored count
#   above the live count is only a warning (users deleted since the dump).
# P1_USERS_MIN (verify only, required): the minimum number of "User" rows a complete dump must hold. It is a production
#   figure, so its value lives in the private runbook, not here: ./remote.sh run p1-backup.sh verify P1_USERS_MIN=<n>
# OLD-STACK INTEGRITY: dump, verify, install-cron and uninstall-cron fingerprint the old stack (containers and the old
#   files, common.sh old_snapshot_begin/assert) at start and end and FAIL loudly if anything changed meanwhile.
# UNDO
#   dump/verify   rm /root/backup/pg/ddc-<label>-<ts>.dump{,.sha256}   (verify leaves nothing behind)
#   install-cron  ./p1-backup.sh uninstall-cron   (removes /etc/cron.d/ddc-pgdump and the cron script; keeps dumps)
# Usage: ./p1-backup.sh dump [label] | verify [dump-file] | install-cron | uninstall-cron | status
# Prints sizes, times, counts and hashes only.
set -euo pipefail
HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
. "$HERE/common.sh"
require_server

PG_DIR="$BACKUP_DIR/pg"
RT_NAME=ddcnew-restore-test-20261004
USERS_MIN="${P1_USERS_MIN:-}"   # verify: a restore with fewer "User" rows is incomplete (value from the private runbook)
cmd="${1:-status}"
if [ "$cmd" = verify ]; then
  case "$USERS_MIN" in ''|*[!0-9]*|0*) die "P1_USERS_MIN must be the minimum user count of a complete dump, a positive whole number (the value is in the private runbook): ./remote.sh run p1-backup.sh verify P1_USERS_MIN=<n>";; esac
fi
case "$cmd" in dump|verify|install-cron|uninstall-cron) run_begin "p1-backup-$cmd" "$@";; esac

old_user_count() {
  docker exec "$OLD_DB_CTR" sh -c 'psql -U "$POSTGRES_USER" -d ddc -tAc "SELECT count(*) FROM \"User\""' | tr -dc '0-9'
}

do_dump() {
  local label="${1:-oneoff}" ts out t0 t1 size db_bytes need avail
  case "$label" in *[!a-z0-9-]*|"") die "label must be [a-z0-9-]";; esac
  guard_write_path "$PG_DIR"
  docker inspect "$OLD_DB_CTR" >/dev/null || die "old db container $OLD_DB_CTR not found"
  old_snapshot_begin
  db_bytes=$(docker exec "$OLD_DB_CTR" sh -c 'psql -U "$POSTGRES_USER" -d ddc -tAc "SELECT pg_database_size(current_database())"' | tr -dc '0-9')
  avail=$(( $(df -B1 --output=avail / | tail -1 | tr -dc '0-9') ))
  need=$(( db_bytes + 2*1024*1024*1024 ))
  say "old db size_gb=$(awk -v b="$db_bytes" 'BEGIN{printf "%.2f", b/1024^3}') disk_avail_gb=$(awk -v b="$avail" 'BEGIN{printf "%.1f", b/1024^3}')"
  [ "$avail" -gt "$need" ] || die "not enough disk for a dump (need db size + 2G)"
  install -d -m 700 "$BACKUP_DIR" "$PG_DIR"
  umask 077
  ts=$(date +%Y%m%d-%H%M%S)
  out="$PG_DIR/ddc-$label-$ts.dump"
  t0=$(date +%s)
  # shellcheck disable=SC2064  # expand $out now: it is local and validated ([a-z0-9-] label)
  trap "rm -f '$out.part'" EXIT
  docker exec -e DBN="$OLD_DB_NAME" "$OLD_DB_CTR" sh -c 'pg_dump -U "$POSTGRES_USER" -d "$DBN" -Fc' > "$out.part"
  mv "$out.part" "$out"; chmod 600 "$out"; trap - EXIT
  (cd "$PG_DIR" && sha256sum "$(basename "$out")" > "$(basename "$out").sha256"); chmod 600 "$out.sha256"
  t1=$(date +%s); size=$(stat -c %s "$out")
  echo "$(date -Is) ok $out $size bytes $((t1-t0))s" >> "$PG_DIR/backup.log"; chmod 600 "$PG_DIR/backup.log"
  pass "dump $(basename "$out") size_mb=$((size/1024/1024)) seconds=$((t1-t0)) sha256=$(cut -c1-16 "$out.sha256")... mode=$(stat -c %a "$out")"
  old_snapshot_assert
}

latest_dump() { find "$PG_DIR" -maxdepth 1 -name 'ddc-*.dump' -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2-; }

cleanup_rt() { docker rm -fv "$RT_NAME" >/dev/null 2>&1 || true; }

do_verify() {
  local f="${1:-}" toc_out toc rc t0 t1 restored live mem d
  [ -n "$f" ] || f="$(latest_dump)"
  [ -f "$f" ] || die "no dump found"
  old_snapshot_begin
  say "dump=$(basename "$f") size_mb=$(( $(stat -c %s "$f")/1024/1024 ))"
  (cd "$(dirname "$f")" && sha256sum -c --quiet "$(basename "$f").sha256") || die "sha256 mismatch"
  pass "sha256 matches"
  # 1) integrity: pg_restore --list reads the whole TOC; its own exit status counts (not hidden behind a pipe)
  rc=0; toc_out=$(docker run --rm -i --pull never --network none postgres:17 pg_restore --list < "$f") || rc=$?
  [ "$rc" = 0 ] || die "pg_restore --list failed (exit $rc): the dump is unreadable or truncated"
  toc=$(printf '%s\n' "$toc_out" | grep -cv '^;' || true); toc_out=""
  [ "$toc" -gt 0 ] || die "pg_restore --list listed no TOC entries"
  pass "pg_restore --list ok, toc_entries=$toc"
  # 2) restore test in a throwaway container (no port, no network), removed afterwards
  d=$(disk_avail_gb); [ "$d" -ge 6 ] || die "disk ${d}G < 6G, not starting the restore test"
  mem=$(mem_avail_mb); [ "$mem" -ge 2000 ] || die "MemAvailable ${mem}MB < 2000MB, not starting the restore test"
  docker ps -a --format '{{.Names}}' | grep -qx "$RT_NAME" && die "$RT_NAME already exists; remove it first (docker rm -fv $RT_NAME)"
  trap cleanup_rt EXIT
  docker run -d --name "$RT_NAME" --network none --memory 1500m -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17 >/dev/null
  for _ in $(seq 1 60); do docker exec "$RT_NAME" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1 && break; sleep 2; done
  docker exec "$RT_NAME" createdb -U postgres ddc_restore_test
  t0=$(date +%s); rc=0
  docker exec -i "$RT_NAME" pg_restore -U postgres -d ddc_restore_test --no-owner --no-acl --exit-on-error < "$f" || rc=$?
  t1=$(date +%s)
  [ "$rc" = 0 ] && pass "pg_restore exit=0 seconds=$((t1-t0))" || die "pg_restore exit=$rc"
  restored=$(docker exec "$RT_NAME" psql -U postgres -d ddc_restore_test -tAc 'SELECT count(*) FROM "User"' | tr -dc '0-9') || die "cannot count the restored users"
  live=$(old_user_count) || die "cannot count the live users"
  say "users restored=${restored:-?} live=${live:-?}"
  case "$restored" in ''|*[!0-9]*) die "restored user count is not a number: the restore is not usable";; esac
  [ "$restored" -ge "$USERS_MIN" ] || die "restored user count $restored < $USERS_MIN (P1_USERS_MIN): the dump or the restore is incomplete"
  case "$live" in
    ''|*[!0-9]*) warn "live user count unreadable: upper bound not checked (restored $restored >= $USERS_MIN passed)";;
    *) if [ "$restored" -gt "$live" ]; then warn "restored user count $restored > live $live: users were deleted after the dump (check with the team)"
       else pass "restored user count $restored within [$USERS_MIN, live $live]"; fi;;
  esac
  say "tables restored=$(docker exec "$RT_NAME" psql -U postgres -d ddc_restore_test -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")"
  cleanup_rt; trap - EXIT
  docker ps -a --format '{{.Names}}' | grep -qx "$RT_NAME" && die "$RT_NAME still exists" || pass "throwaway container and its volume removed"
  old_snapshot_assert
}

do_install_cron() {
  guard_write_path "$BACKUP_DIR/ddc-pgdump.sh"; guard_write_path /etc/cron.d/ddc-pgdump
  old_snapshot_begin
  install -d -m 700 "$BACKUP_DIR" "$PG_DIR"
  umask 077
  cat > "$BACKUP_DIR/ddc-pgdump.sh" <<'EOF'
#!/usr/bin/env bash
# DDC daily database backup (runbook 4.0 P1). Reads the database only.
# After the cutover change DB_CTR to ddcnew-db-1 and DB_NAME to ddc_prod (runbook section 6 step 9).
set -euo pipefail
umask 077
DB_CTR=ddc-backend-ddc-backend-db-1
DB_NAME=ddc
DIR=/root/backup/pg
KEEP_DAYS=7
TS=$(date +%Y%m%d-%H%M)
OUT="$DIR/ddc-daily-$TS.dump"
trap 'rm -f "$OUT.part"' EXIT
# Never let a dump fill the root disk shared with the live Postgres: need db size + 3G free.
DB_BYTES=$(docker exec -e DBN="$DB_NAME" "$DB_CTR" sh -c 'psql -U "$POSTGRES_USER" -d "$DBN" -tAc "SELECT pg_database_size(current_database())"' | tr -dc 0-9)
AVAIL=$(df -B1 --output=avail "$DIR" | tail -1 | tr -dc 0-9)
if [ -z "$DB_BYTES" ] || [ "$AVAIL" -lt $(( DB_BYTES + 3*1024*1024*1024 )) ]; then echo "$(date -Is) SKIP low disk avail=$AVAIL db=$DB_BYTES" >> "$DIR/backup.log"; exit 1; fi
docker exec -e DBN="$DB_NAME" "$DB_CTR" sh -c 'pg_dump -U "$POSTGRES_USER" -d "$DBN" -Fc' > "$OUT.part"
mv "$OUT.part" "$OUT"
(cd "$DIR" && sha256sum "$(basename "$OUT")" > "$(basename "$OUT").sha256")
# Only the daily files rotate; one-off dumps (ddc-oneoff-*, ddc-pre-*) are kept until removed by hand.
find "$DIR" -maxdepth 1 -name 'ddc-daily-*.dump*' -mtime +"$KEEP_DAYS" -delete
echo "$(date -Is) ok $OUT $(stat -c %s "$OUT") bytes" >> "$DIR/backup.log"
EOF
  chmod 700 "$BACKUP_DIR/ddc-pgdump.sh"
  # The cron entry is written only for a script that parses: a broken one would fail silently every night.
  bash -n "$BACKUP_DIR/ddc-pgdump.sh" || { rm -f "$BACKUP_DIR/ddc-pgdump.sh"; die "cron script syntax check (bash -n) failed: script removed, no cron entry written"; }
  pass "cron script syntax ok"
  umask 022
  cat > /etc/cron.d/ddc-pgdump <<'EOF'
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
15 3 * * * root /root/backup/ddc-pgdump.sh >> /root/backup/pg/cron.log 2>&1
EOF
  chmod 644 /etc/cron.d/ddc-pgdump
  pass "installed /etc/cron.d/ddc-pgdump (03:15 $(date +%Z) daily, keep 7 days of ddc-daily-*)"
  say "cron service: $(systemctl is-active cron 2>/dev/null || echo unknown)"
  old_snapshot_assert
}

do_uninstall_cron() {
  old_snapshot_begin
  rm -f /etc/cron.d/ddc-pgdump "$BACKUP_DIR/ddc-pgdump.sh"
  pass "cron removed; dumps under $PG_DIR kept"
  old_snapshot_assert
}

do_status() {
  ls -l "$PG_DIR" 2>/dev/null | awk 'NR>1 {print $1, $5, $6, $7, $8, $9}' || say "$PG_DIR absent"
  [ -f "$PG_DIR/backup.log" ] && tail -3 "$PG_DIR/backup.log" || true
  [ -f /etc/cron.d/ddc-pgdump ] && say "cron installed" || say "cron not installed"
}

case "$cmd" in
  dump) do_dump "${2:-oneoff}";;
  verify) do_verify "${2:-}";;
  install-cron) do_install_cron;;
  uninstall-cron) do_uninstall_cron;;
  status) do_status;;
  *) die "usage: $0 dump [label] | verify [dump-file] | install-cron | uninstall-cron | status";;
esac
