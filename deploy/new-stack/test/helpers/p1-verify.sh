#!/usr/bin/env bash
# p1-verify.sh <package dir> <work dir>   (local test helper; touches nothing outside <work dir>)
# Runs the real p1-backup.sh verify against a STUB docker (no container is started) on a GNU userland (ubuntu:jammy,
# as a normal user, DDC_LOCAL_TEST=1): the pass criteria that must STOP the script, and the ones that only warn.
# The user counts are synthetic: P1_USERS_MIN=1000 stands for the production floor, which only the private runbook holds.
# Prints PASS/FAIL lines; exit 1 on FAIL.
set -u
PKG="$1"; W="$2"
unset P1_USERS_MIN
rm -rf "$W"; mkdir -p "$W/bin" "$W/backup/pg" "$W/ddcnew"
fails=0; ok() { echo "PASS $*"; }; bad() { echo "FAIL $*"; fails=$((fails+1)); }
cat > "$W/bin/docker" <<'EOF'
#!/bin/bash
# stub docker for p1-backup.sh verify. Behaviour: STUB_TOC=ok|empty|fail, STUB_RESTORED, STUB_LIVE. Calls are logged.
echo "$*" >> "$STUB_DIR/calls"
case "$1" in
  ps) exit 0;;                                     # no ddc-* container, no restore-test container left
  run)
    if [[ " $* " == *" pg_restore --list "* ]]; then
      cat > /dev/null
      case "$STUB_TOC" in
        ok) printf ';\n; Archive created at 2026-10-04\n;\n1; 2615 2200 SCHEMA - public\n2; 1259 16385 TABLE public User\n';;
        empty) printf ';\n; Archive created at 2026-10-04\n;\n';;
        fail) printf '1; 2615 2200 SCHEMA - public\n'; echo "pg_restore: error: could not read input file: end of file" >&2; exit 1;;
      esac
    else echo started >> "$STUB_DIR/rt"; echo 0123456789abcdef; fi;;
  exec)
    if [[ " $* " == *information_schema* ]]; then echo 42
    elif [[ " $* " == *ddc_restore_test*User* ]]; then printf '%s\n' "$STUB_RESTORED"
    elif [[ " $* " == *ddc-backend-ddc-backend-db-1*User* ]]; then printf '%s\n' "$STUB_LIVE"
    elif [[ " $* " == *" pg_restore "* ]]; then cat > /dev/null; fi;;
  rm) echo removed >> "$STUB_DIR/rt";;
esac
exit 0
EOF
chmod 755 "$W/bin/docker"
printf 'MemTotal:       16000000 kB\nMemAvailable:    8000000 kB\n' > "$W/meminfo"
head -c 4096 /dev/urandom > "$W/backup/pg/ddc-test-20261004-120000.dump"
(cd "$W/backup/pg" && sha256sum ddc-test-20261004-120000.dump > ddc-test-20261004-120000.dump.sha256)
verify() { # <toc> <restored> <live> [P1_USERS_MIN, default 1000] -> output in $W/out, exit status in $RC
  rm -f "$W/rt" "$W/calls"; RC=0
  PATH="$W/bin:$PATH" STUB_DIR="$W" STUB_TOC="$1" STUB_RESTORED="$2" STUB_LIVE="$3" DDC_LOCAL_TEST=1 NEW_DIR="$W/ddcnew" \
    BACKUP_DIR="$W/backup" DDC_MEMINFO="$W/meminfo" P1_USERS_MIN="${4-1000}" bash "$PKG/p1-backup.sh" verify > "$W/out" 2>&1 || RC=$?
}
case_stop() { # <label> <toc> <restored> <live> <expected FAIL text> <rt state: none|removed>
  verify "$2" "$3" "$4"
  local rt; rt=$(cat "$W/rt" 2>/dev/null | tr '\n' ' ')
  if [ "$RC" = 1 ] && grep -q "^FAIL .*$5" "$W/out" && ! grep -q 'PASS throwaway container and its volume removed' "$W/out" \
     && { { [ "$6" = none ] && [ -z "$rt" ]; } || { [ "$6" = removed ] && [ "$rt" = "started removed " ]; }; }; then
    ok "$1 -> STOPS: $(grep -m1 "^FAIL .*$5" "$W/out" | cut -c1-110); restore container: ${rt:-never started}"
  else sed 's/^/    /' "$W/out"; bad "$1 (rc=$RC rt=[$rt])"; fi
}
case_stop "pg_restore --list fails" fail 1500 1500 "pg_restore --list failed (exit 1)" none
case_stop "pg_restore --list lists nothing" empty 1500 1500 "pg_restore --list listed no TOC entries" none
case_stop "restored users 999 (one below P1_USERS_MIN=1000)" ok 999 1500 "restored user count 999 < 1000 (P1_USERS_MIN)" removed
case_stop "restored user count empty" ok "" 1500 "restored user count is not a number" removed
case_stop "restored user count without digits (psql printed an error word)" ok "ERROR" 1500 "restored user count is not a number" removed
verify ok 1600 1500
[ "$RC" = 0 ] && grep -q '^WARN restored user count 1600 > live 1500' "$W/out" && grep -q 'PASS throwaway container and its volume removed' "$W/out" \
  && ok "restored 1600 > live 1500 -> warning only, verify passes" || { sed 's/^/    /' "$W/out"; bad "above-live case (rc=$RC)"; }
verify ok 1200 1500
[ "$RC" = 0 ] && grep -q '^PASS restored user count 1200 within \[1000, live 1500\]' "$W/out" && grep -q '^PASS pg_restore --list ok, toc_entries=2' "$W/out" \
  && ok "restored 1200 within [1000, live 1500] -> PASS" || { sed 's/^/    /' "$W/out"; bad "within case (rc=$RC)"; }
# P1_USERS_MIN is required for verify and must be a positive whole number: refused before docker is called at all
for v in unset "" abc 12x 0 007; do
  if [ "$v" = unset ]; then
    rm -f "$W/rt" "$W/calls"; RC=0
    PATH="$W/bin:$PATH" STUB_DIR="$W" STUB_TOC=ok STUB_RESTORED=1200 STUB_LIVE=1500 DDC_LOCAL_TEST=1 NEW_DIR="$W/ddcnew" \
      BACKUP_DIR="$W/backup" DDC_MEMINFO="$W/meminfo" bash "$PKG/p1-backup.sh" verify > "$W/out" 2>&1 || RC=$?
  else verify ok 1200 1500 "$v"; fi
  if [ "$RC" = 1 ] && grep -q '^FAIL P1_USERS_MIN must be the minimum user count' "$W/out" && [ ! -s "$W/calls" ] && [ ! -e "$W/rt" ]; then
    ok "P1_USERS_MIN=${v} -> refused before any docker call"
  else sed 's/^/    /' "$W/out"; bad "P1_USERS_MIN=${v} (rc=$RC)"; fi
done
echo "p1-verify.sh: fails=$fails"
[ "$fails" = 0 ]
