#!/usr/bin/env bash
# root-guard.sh <package dir>   (local test helper)
# Runs as ROOT inside a throwaway ubuntu:22.04 container (run-local-tests.sh section 11), WITHOUT DDC_LOCAL_TEST, with
# the server's directory layout (/root/ddcnew, /root/ddc-backend, /root/backup, /etc/nginx/sites-*, /etc/cron.d):
# guard_write_path for every target the scripts write (first run and re-run), the refusals, require_server, and
# run_begin (run lock + server-side log). Prints PASS/FAIL lines; exit 1 on FAIL.
set -u
PKG="$1"
fails=0; ok() { echo "PASS $*"; }; bad() { echo "FAIL $*"; fails=$((fails+1)); }
[ "$(id -u)" = 0 ] || { echo "FAIL root-guard.sh must run as root"; exit 1; }
unset DDC_LOCAL_TEST NEW_DIR OLD_ENV BACKUP_DIR DDC_PROC DDC_MEMINFO SRV_DIR PARTNER_CRYPT_IMAGE PARTNER_ALLOWED_IP DDC_TEST_RUN_ID \
  API_HOST APP_HOST API_PORT WEB_PORT DB_PORT TAKE_OVER_VHOSTS MAINNET_DIR NGINX_CONFD NGINX_LOCAL_URL
A=api-rehearsal.datadance.ai; P=app-rehearsal.datadance.ai   # the default hosts (common.sh)
mkdir -p /root/ddc-backend/keys_fixed /root/ddc /opt/ddc /root/deploy-src /root/ddc-mainnet /etc/nginx/sites-available /etc/nginx/sites-enabled /etc/cron.d /stub
echo A=1 > /root/ddc-backend/backend.env; echo key > /root/ddc-backend/keys_fixed/apn_key.p8
for v in api.datadance.co app.datadance.co; do echo 'server {}' > "/etc/nginx/sites-available/$v"; ln -sfn "../sites-available/$v" "/etc/nginx/sites-enabled/$v"; done
printf '#!/bin/sh\nexit 0\n' > /stub/docker; chmod 755 /stub/docker; export PATH="/stub:$PATH"
# shellcheck source=../../common.sh
. "$PKG/common.sh"

# Every target the scripts pass to guard_write_path or write directly (10-build, 20-env, 30-nginx, 40-up, p1, p2, run_begin)
TARGETS="/root/ddcnew /root/ddcnew/deploy /root/ddcnew/src /root/ddcnew/src/backend-0123456789ab /root/ddcnew/src/frontend-0123456789ab
 /root/ddcnew/src/frontend-current /root/ddcnew/logs /root/ddcnew/logs/20261004-120000-10-build-77.log /root/ddcnew/.lock
 /root/ddcnew/keys_fixed /root/ddcnew/keys_fixed/apn_key.p8 /root/ddcnew/keys_fixed/apn_key.p8.tmp /root/ddcnew/assets /root/ddcnew/.env
 /root/ddcnew/.env.rehearsal /root/ddcnew/.env.db /root/ddcnew/secrets /root/ddcnew/compose.yaml /root/ddcnew/.env.api
 /root/ddcnew/.env.api.new /root/ddcnew/pgdata /root/backup/pg /root/backup/ddc-pgdump.sh /root/backup/disk-need.txt /etc/cron.d/ddc-pgdump
 /root/ddcnew/settings.env /root/ddcnew/nginx-render /root/ddcnew/nginx-render/$A /root/ddcnew/vhost-takeover /root/ddcnew/vhost-takeover/20261005-120000-1
 /etc/nginx/sites-available/$A /etc/nginx/sites-available/$P /etc/nginx/sites-available/$A.new /etc/nginx/sites-available/$P.new
 /etc/nginx/sites-enabled/$A /etc/nginx/sites-enabled/$P
 /srv/ddcnew /srv/ddcnew/partner-info /srv/ddcnew/partner-info/index.html /srv/ddcnew/partner-info/secret.json
 /srv/ddcnew/partner-info/.index.html.new /srv/ddcnew/partner-info/.secret.json.new"
allowed() { # <label>
  local p out n=0
  for p in $TARGETS; do
    if out=$( (guard_write_path "$p") 2>&1 ); then n=$((n + 1)); else bad "$1: $p refused: $out"; return; fi
  done
  ok "$1: all $n targets allowed"
}
allowed "first run, nothing exists yet"
# what an earlier run leaves behind: files, directories, the in-tree frontend link, the enabled-vhost links
mkdir -p /root/ddcnew/deploy /root/ddcnew/src/backend-0123456789ab /root/ddcnew/src/frontend-0123456789ab /root/ddcnew/logs \
         /root/ddcnew/keys_fixed /root/ddcnew/assets /root/ddcnew/secrets /root/ddcnew/pgdata /root/backup/pg
ln -sfn frontend-0123456789ab /root/ddcnew/src/frontend-current
for f in .lock keys_fixed/apn_key.p8 .env .env.rehearsal .env.db compose.yaml .env.api logs/20261004-120000-10-build-77.log; do echo x > "/root/ddcnew/$f"; done
for f in /root/backup/ddc-pgdump.sh /root/backup/disk-need.txt /etc/cron.d/ddc-pgdump "/etc/nginx/sites-available/$A" "/etc/nginx/sites-available/$P"; do echo x > "$f"; done
ln -sfn "/etc/nginx/sites-available/$A" "/etc/nginx/sites-enabled/$A"
ln -sfn "../sites-available/$P" "/etc/nginx/sites-enabled/$P"
mkdir -p /srv/ddcnew/partner-info; echo x > /srv/ddcnew/partner-info/index.html; echo x > /srv/ddcnew/partner-info/secret.json
allowed "re-run: existing files and directories, in-tree symlinks (src/frontend-current, sites-enabled/<the two hosts>), /srv/ddcnew/partner-info"

refused() { # <label> <path> <expected text>
  local out
  if out=$( (guard_write_path "$2") 2>&1 ); then bad "$1: $2 was ALLOWED"
  else case "$out" in *"$3"*) ok "$1: $(printf '%s' "$out" | head -1 | cut -c1-110)";; *) bad "$1: unexpected message: $out";; esac; fi
}
ln -sfn /root/ddc-backend /root/ddcnew/evil
refused "symlink into /root/ddc-backend" /root/ddcnew/evil/backend.env "belongs to the old stack (/root/ddc-backend)"
refused "the symlink itself" /root/ddcnew/evil "belongs to the old stack (/root/ddc-backend)"
rm -rf /root/ddcnew/keys_fixed; ln -sfn /root/ddc-backend/keys_fixed /root/ddcnew/keys_fixed
refused "keys_fixed swapped for a link to the production keys" /root/ddcnew/keys_fixed/apn_key.p8 "belongs to the old stack (/root/ddc-backend)"
rm -f /root/ddcnew/keys_fixed; mkdir -p /root/ddcnew/keys_fixed
refused ".. traversal into the old backend" /root/ddcnew/../ddc-backend/backend.env "belongs to the old stack (/root/ddc-backend)"
refused ".. traversal into the old app" /root/ddcnew/src/../../ddc/docker-compose.yml "belongs to the old stack (/root/ddc)"
refused ".. traversal out of the allowlist" /root/backup/../.ssh/authorized_keys "not a new-stack path"
ln -sfn ../sites-available/api.datadance.co "/etc/nginx/sites-enabled/$A"
refused "an API-host link that points at the old api vhost" "/etc/nginx/sites-enabled/$A" "not a new-stack path"
ln -sfn "/etc/nginx/sites-available/$A" "/etc/nginx/sites-enabled/$A"
echo x > /root/ddc-mainnet/compose.yaml
refused "Race's mainnet directory" /root/ddc-mainnet/compose.yaml "belongs to the old stack (/root/ddc-mainnet)"
ln -sfn /root/ddc-mainnet /root/ddcnew/race
refused "a symlink into /root/ddc-mainnet" /root/ddcnew/race/compose.yaml "belongs to the old stack (/root/ddc-mainnet)"
rm -f /root/ddcnew/race
refused "Race's older vhost name (not one of the settings' hosts)" /etc/nginx/sites-available/tge-api.datadance.ai "not a new-stack path"
for p in /etc/nginx/sites-available/api.datadance.co /etc/nginx/sites-enabled/app.datadance.co "/etc/nginx/sites-available/$A.evil" \
         /etc/nginx/nginx.conf /etc/cron.d/other /root/.bashrc /tmp/x /root/ddcnewx/a /opt/ddc/x /root/deploy-src/x \
         /srv/other/index.html /srv/ddcnewx/a /srv/ddcnew/../www/x; do
  case "$p" in /opt/ddc/*|/root/deploy-src/*) want="belongs to the old stack";; *) want="not a new-stack path";; esac
  refused "outside the allowlist" "$p" "$want"
done
ln -sfn /root/ddc-backend /srv/ddcnew/evil
refused "symlink from /srv/ddcnew into /root/ddc-backend" /srv/ddcnew/evil/backend.env "belongs to the old stack (/root/ddc-backend)"
rm -f /srv/ddcnew/evil

# require_server as root, with the defaults and with overrides that only the local test may use
out=$( (require_server && echo REQ-OK) 2>&1 ); [ "$out" = REQ-OK ] && ok "require_server passes as root with the defaults" || bad "require_server: $out"
for o in "DDC_PROC=/tmp/fakeproc|DDC_PROC override" "DDC_MEMINFO=/tmp/m|DDC_MEMINFO override" "BUILD_DISK_FLOOR_MB=1000|BUILD_DISK_FLOOR_MB may only be raised" \
         "BUILD_MEM_FLOOR_MB=500|BUILD_MEM_FLOOR_MB may only be raised" "NEW_DIR=/tmp/x|NEW_DIR override" "DDC_LOCAL_TEST=1|refused when running as root" \
         "SRV_DIR=/tmp/x|SRV_DIR override" "MAINNET_DIR=/tmp/x|MAINNET_DIR override" "NGINX_CONFD=/tmp/x|NGINX_* overrides" "NGINX_LOCAL_URL=http://x|NGINX_* overrides" \
         "API_HOST=api.datadance.ai|is a production host" "APP_HOST=app.example.com|is not a host name of the form" "API_PORT=10000|is a port of the old stack" \
         "DB_PORT=99999|use a port from 1024 to 65535" "TAKE_OVER_VHOSTS=1|TAKE_OVER_VHOSTS must be yes"; do
  kv="${o%%|*}"; want="${o#*|}"
  out=$( (export "${kv?}"; . "$PKG/common.sh"; require_server && echo REQ-OK) 2>&1 )
  case "$out" in *"$want"*) ok "require_server refuses $kv as root";; *) bad "require_server with $kv: $out";; esac
done

out=$( (export API_HOST=api-coexist.datadance.ai APP_HOST=app-coexist.datadance.ai API_PORT=10031; . "$PKG/common.sh"; require_server && guard_write_path /etc/nginx/sites-available/api-coexist.datadance.ai && echo REQ-OK) 2>&1 )
[ "$out" = REQ-OK ] && ok "require_server accepts valid host and port overrides as root, and the write guard follows the overridden host" || bad "valid overrides as root: $out"
mkdir -p /root/ddcnew; printf 'API_HOST=%s\nAPP_HOST=%s\nAPI_PORT=10020\nWEB_PORT=9021\nDB_PORT=15434\n' "$A" "$P" > /root/ddcnew/settings.env
out=$( (export API_HOST=api-coexist.datadance.ai; . "$PKG/common.sh"; require_server && echo REQ-OK) 2>&1 )
case "$out" in *"differs from API_HOST=$A recorded in /root/ddcnew/settings.env"*) ok "as root, an override that differs from the recorded settings stops require_server";; *) bad "settings conflict as root: $out";; esac
rm -f /root/ddcnew/settings.env
# 50-partner-page.sh as root (the server's mode): refusals that come before any secret is read
pp() { # <expected text> <command> [VAR=value...]: stdin /dev/null
  local want="$1" c="$2" out rc=0; shift 2
  out=$(env "$@" bash "$PKG/50-partner-page.sh" "$c" < /dev/null 2>&1) || rc=$?
  case "$rc:$out" in 0:*) bad "50-partner-page.sh $c ($*) passed: $out";; *"$want"*) ok "50-partner-page.sh $c as root ($*) refused: $(printf '%s\n' "$out" | grep '^FAIL' | head -1 | cut -c1-110)";;
    *) bad "50-partner-page.sh $c ($*): unexpected: $out";; esac
}
pp "PARTNER_CRYPT_IMAGE override is only allowed with DDC_LOCAL_TEST=1" status PARTNER_CRYPT_IMAGE=node:22-alpine
pp "DDC_TEST_RUN_ID is only allowed with DDC_LOCAL_TEST=1" status DDC_TEST_RUN_ID=lt1
pp "PARTNER_ALLOWED_IP=<the partner server's address> is required" apply
pp "is not an IPv4 or IPv6 address" apply PARTNER_ALLOWED_IP=203.0.113.300
pp "SRV_DIR override is only allowed" apply SRV_DIR=/var/www PARTNER_ALLOWED_IP=203.0.113.7
rm -rf /srv/ddcnew/partner-info; mkdir -p /root/ddcnew/evilpage; ln -sfn /root/ddcnew/evilpage /srv/ddcnew/partner-info
pp "the page must not live under /root" apply PARTNER_ALLOWED_IP=203.0.113.7
rm -f /srv/ddcnew/partner-info; mkdir -p /srv/elsewhere; ln -sfn /srv/elsewhere /srv/ddcnew/partner-info
pp "is a symbolic link" apply PARTNER_ALLOWED_IP=203.0.113.7
rm -f /srv/ddcnew/partner-info; mkdir -p /srv/ddcnew/partner-info
pp "no page password on stdin" apply PARTNER_ALLOWED_IP=203.0.113.7
log=$(ls /root/ddcnew/logs/*-50-partner-page-apply-*.log 2>/dev/null | tail -1)
[ -n "$log" ] && [ "$(stat -c %a "$log")" = 600 ] && grep -q 'FAIL no page password on stdin' "$log" \
  && ok "the refused apply ran under the run lock and left its server-side log (600)" || bad "50-partner-page.sh apply log (log=$log)"

# run_begin: one write run at a time, server-side log (600), lock inherited by a child write script only
mkdir -p /t
cat > /t/w.sh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
. "$PKG/common.sh"
require_server
run_begin "lt-$1" "$@"
say "working as pid $$"
case "$1" in
  hold) sleep "${2:-6}";;
  child) bash /t/w.sh inner;;
  inner) say "inner run: shares the parent's lock";;
esac
say "done $1"
EOF
export PKG
rm -f /root/ddcnew/.lock /root/ddcnew/logs/*-lt-*.log
bash /t/w.sh hold 8 > /t/hold.out 2>&1 & holder=$!
for _ in $(seq 1 40); do grep -q 'working as pid' /t/hold.out 2>/dev/null && break; sleep 0.25; done
rc=0; bash /t/w.sh second > /t/second.out 2>&1 || rc=$?
[ "$rc" = 1 ] && grep -q 'FAIL another ddcnew write script is running (pid [0-9]* lt-hold since' /t/second.out && ! grep -q 'done second' /t/second.out \
  && ok "a second write run stops at once and names the holder: $(grep -o 'another ddcnew write script is running ([^)]*)' /t/second.out)" || { cat /t/second.out; bad "second run while the lock is held (rc=$rc)"; }
rc=0; DDC_LOCK_HELD=/root/ddcnew/.lock DDC_RUN_LOG=/root/ddcnew/logs/forged.log bash /t/w.sh forged > /t/forged.out 2>&1 || rc=$?
[ "$rc" = 1 ] && grep -q 'FAIL another ddcnew write script is running' /t/forged.out && ok "DDC_LOCK_HELD set by hand (no inherited lock fd) does not bypass the lock" || { cat /t/forged.out; bad "forged DDC_LOCK_HELD (rc=$rc)"; }
wait "$holder"; hrc=$?
log=$(ls /root/ddcnew/logs/*-lt-hold-*.log 2>/dev/null | head -1)
[ "$hrc" = 0 ] && [ -n "$log" ] && [ "$(stat -c %a "$log")" = 600 ] && grep -q 'working as pid' "$log" && grep -q 'done hold' "$log" && [ "$(stat -c %a /root/ddcnew/.lock)" = 600 ] \
  && ok "server-side log $(basename "$log") (600) holds the whole run; lock file 600" || bad "holder log/lock (rc=$hrc log=$log)"
slog=$(ls /root/ddcnew/logs/*-lt-second-*.log 2>/dev/null | head -1)
[ -n "$slog" ] && grep -q 'FAIL another ddcnew write script is running' "$slog" && ok "the refused run's FAIL line is in its own server-side log too" || bad "refused run log"
rc=0; bash /t/w.sh child > /t/child.out 2>&1 || rc=$?
[ "$rc" = 0 ] && grep -q 'lock: held by the parent run (pid [0-9]* lt-child' /t/child.out && grep -q 'inner run: shares the parent' /t/child.out && grep -q 'done child' /t/child.out \
  && [ "$(ls /root/ddcnew/logs/*-lt-inner-*.log 2>/dev/null | wc -l)" = 0 ] && grep -q 'inner run: shares the parent' "$(ls /root/ddcnew/logs/*-lt-child-*.log | head -1)" \
  && ok "a write script started by a locked run (99-teardown -> 30-nginx undo) inherits the lock and writes into the parent's log" || { cat /t/child.out; bad "child run (rc=$rc)"; }
rc=0; bash /t/w.sh after > /t/after.out 2>&1 || rc=$?
[ "$rc" = 0 ] && grep -q 'done after' /t/after.out && ok "the lock is free again once the holder ended" || { cat /t/after.out; bad "lock not released (rc=$rc)"; }
echo "root-guard.sh: $(bash --version | head -1 | cut -c1-40), $(realpath --version | head -1), fails=$fails"
[ "$fails" = 0 ]
