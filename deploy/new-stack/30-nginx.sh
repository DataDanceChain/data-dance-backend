#!/usr/bin/env bash
# 30-nginx.sh - host nginx vhosts for the temporary domains (runbook 4.1 step 1).
#
# CHANGES ON THE SERVER
#   apply   writes /etc/nginx/sites-available/tge-api.datadance.ai and .../tge-app.datadance.ai (copies of the
#           api/app vhosts with only server_name and the upstream port changed - exactly the runbook's sed copy;
#           the tge-app copy keeps the http-level `map $http_upgrade $connection_upgrade` block that app.datadance.co
#           also defines: nginx 1.18 (Ubuntu 22.04) and 1.30 accept the identical duplicate map, tested locally),
#           links both into sites-enabled, nginx -t, systemctl reload nginx.
#           The existing vhost files are only read (and their sha256 compared before/after, with the old
#           containers, by old_snapshot_begin/assert). A failed nginx -t removes the two new files again.
#   undo    removes exactly those two links and two files, nginx -t, reload.
#   status  read-only.
#   apply and undo also take the run lock /root/ddcnew/.lock and log to /root/ddcnew/logs/ (common.sh run_begin).
# PASS CRITERION THAT STOPS THE SCRIPT: the old vhosts (api/app/business/admin.datadance.ai) must answer with the same
#   status codes after the reload as before it. If not, apply and undo FAIL (after printing the old-stack integrity
#   check): apply says to run ./30-nginx.sh undo at once.
# CORS: render (and so apply) refuses when the api vhost sets a literal Access-Control-Allow-Origin value (an http(s)://
#   origin), because the tge-api copy would then need https://tge-app.datadance.ai added by hand. Otherwise the CORS
#   lines are copied unchanged.
# UNDO: ./30-nginx.sh undo
set -euo pipefail
HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
. "$HERE/common.sh"
require_server
cmd="${1:-status}"
case "$cmd" in apply|undo) run_begin "30-nginx-$cmd" "$@";; esac

API_SRC=$(readlink -f "$NGINX_ENABLED/api.datadance.co" || true)
APP_SRC=$(readlink -f "$NGINX_ENABLED/app.datadance.co" || true)
API_DST="$NGINX_AVAIL/$TGE_API_HOST"; APP_DST="$NGINX_AVAIL/$TGE_APP_HOST"
API_LNK="$NGINX_ENABLED/$TGE_API_HOST"; APP_LNK="$NGINX_ENABLED/$TGE_APP_HOST"
redact() { awk '{ if (tolower($0) ~ /(auth|token|secret|password|key)/) print "<redacted line>"; else print }'; }
cnt() { grep -cE "$1" "$2" || true; }
code() { curl -s -o /dev/null -m 10 -w '%{http_code}' -H "Host: $1" "http://127.0.0.1$2" || true; }
old_codes() { printf 'api=%s app=%s business=%s admin=%s' "$(code api.datadance.ai /)" "$(code app.datadance.ai /)" "$(code business.datadance.ai /)" "$(code admin.datadance.ai /)"; }

remove_ours() {
  rm -f "$API_LNK" "$APP_LNK" "$API_DST" "$APP_DST" "$API_DST.new" "$APP_DST.new"
}

# render <api-src> <app-src> <api-out> <app-out>: build both copies and check them (no nginx calls).
render() {
    [ "$(cnt '^[[:space:]]*server_name api\.datadance\.ai;' "$1")" = 1 ] || die "api vhost: expected exactly one 'server_name api.datadance.ai;'"
    [ "$(cnt 'localhost:10000;' "$1")" = 1 ] || die "api vhost: expected exactly one upstream localhost:10000"
    [ "$(cnt '^[[:space:]]*server_name app\.datadance\.ai;' "$2")" = 1 ] || die "app vhost: expected exactly one 'server_name app.datadance.ai;'"
    [ "$(cnt 'localhost:9001;' "$2")" = 1 ] || die "app vhost: expected exactly one upstream localhost:9001"
    hard=$(cnt "Access-Control-Allow-Origin[\"']?[[:space:]]+[\"']?https?://" "$1")
    [ "$hard" = 0 ] || die "api vhost now hard-codes $hard CORS origin(s): add https://$TGE_APP_HOST to the tge-api copy by hand, then re-run"
    say "api vhost CORS: lines with \$http_origin=$(cnt 'Access-Control-Allow-Origin.*\$http_origin' "$1"), hard-coded origins=0 -> no CORS change needed"

    sed -e "s#server_name api\.datadance\.ai;#server_name $TGE_API_HOST;#" -e 's#localhost:10000;#localhost:10010;#' "$1" > "$3"
    sed -e "s#server_name app\.datadance\.ai;#server_name $TGE_APP_HOST;#" -e 's#localhost:9001;#localhost:9011;#' "$2" > "$4"

    [ "$(cnt "server_name $TGE_API_HOST;" "$3")" = 1 ] && [ "$(cnt 'server_name' "$3")" = 1 ] || die "tge-api copy: server_name check failed"
    [ "$(cnt 'localhost:10010;' "$3")" = 1 ] && [ "$(cnt '10000' "$3")" = 0 ] || die "tge-api copy: upstream check failed"
    [ "$(cnt "server_name $TGE_APP_HOST;" "$4")" = 1 ] && [ "$(cnt 'server_name' "$4")" = 1 ] || die "tge-app copy: server_name check failed"
    [ "$(cnt 'localhost:9011;' "$4")" = 1 ] && [ "$(cnt '9001' "$4")" = 0 ] || die "tge-app copy: upstream check failed"
    [ "$(cnt '\$connection_upgrade' "$4")" -ge 1 ] || die "tge-app copy lost the Connection header"
    [ "$(cnt 'location \^~ /downloads/' "$4")" = 1 ] && [ "$(cnt 'location \^~ /architecture/' "$4")" = 1 ] || die "tge-app copy lost /downloads/ or /architecture/"
    say "diff api.datadance.co -> $TGE_API_HOST:"; diff "$1" "$3" | grep '^[<>]' | redact || true
    say "diff app.datadance.co -> $TGE_APP_HOST:"; diff "$2" "$4" | grep '^[<>]' | redact || true

}

case "$cmd" in
  apply)
    for p in "$API_DST" "$APP_DST" "$API_LNK" "$APP_LNK"; do guard_write_path "$p"; done
    nginx -t 2>/dev/null || die "nginx -t fails BEFORE any change; not touching nginx"
    old_snapshot_begin
    before=$(old_codes); say "old vhosts before: $before"
    render "$API_SRC" "$APP_SRC" "$API_DST.new" "$APP_DST.new"

    mv "$API_DST.new" "$API_DST"; mv "$APP_DST.new" "$APP_DST"; chmod 644 "$API_DST" "$APP_DST"
    ln -sfn "$API_DST" "$API_LNK"; ln -sfn "$APP_DST" "$APP_LNK"
    install -d -m 700 "$NEW_DIR/logs"
    if ! nginx -t 2>"$NEW_DIR/logs/nginx-t.out"; then
      tail -3 "$NEW_DIR/logs/nginx-t.out" | redact
      remove_ours; nginx -t 2>/dev/null && say "rolled back: the two new files removed, nginx -t passes again"
      die "nginx -t failed with the new vhosts"
    fi
    pass "nginx -t ok"
    systemctl reload nginx; sleep 1
    pass "nginx reloaded"
    grep -nE 'server_name|listen|proxy_pass|alias' "$API_DST" "$APP_DST"
    after=$(old_codes); say "old vhosts after:  $after"
    if [ "$before" = "$after" ]; then pass "old vhosts answer exactly as before"
    else
      printf 'FAIL old vhost status codes changed: before [%s] after [%s]\n' "$before" "$after" >&2
      ( old_snapshot_assert ) || true   # report containers and old files too, then stop
      die "old vhost status codes changed after the reload — run ./30-nginx.sh undo now"
    fi
    say "tge-api /partner/tge/me=$(code $TGE_API_HOST /partner/tge/me) (502 until 40-up.sh, then 401)  tge-app /=$(code $TGE_APP_HOST /) (502 until 40-up.sh)"
    old_snapshot_assert
    ;;
  undo)
    old_snapshot_begin
    before=$(old_codes)
    remove_ours
    nginx -t 2>/dev/null || die "nginx -t fails after removing the tge vhosts - check by hand"
    systemctl reload nginx; sleep 1
    pass "tge-api / tge-app vhosts removed, nginx reloaded"
    after=$(old_codes)
    if [ "$before" = "$after" ]; then pass "old vhosts unchanged ($after)"
    else
      printf 'FAIL old vhost status codes changed: before [%s] after [%s]\n' "$before" "$after" >&2
      ( old_snapshot_assert ) || true
      die "old vhost status codes changed after the reload — the tge vhosts are already removed: check the old stack now (nginx -t, docker ps, the old vhosts)"
    fi
    old_snapshot_assert
    ;;
  render)  # local test only: ./30-nginx.sh render <api-src> <app-src> <out-dir>
    ddc_local_test || die "render is for the local test (DDC_LOCAL_TEST=1)"
    mkdir -p "$4"; render "$2" "$3" "$4/$TGE_API_HOST" "$4/$TGE_APP_HOST"; pass "rendered and checked both copies"
    ;;
  status)
    ls -l "$API_LNK" "$APP_LNK" "$API_DST" "$APP_DST" 2>&1 | awk '{print $NF, $(NF-1), $(NF-2)}'
    [ -f "$API_DST" ] && grep -nE 'server_name|proxy_pass' "$API_DST" "$APP_DST" || true
    say "old: $(old_codes)"
    ;;
  *) die "usage: $0 apply | undo | status | render (local test)";;
esac
