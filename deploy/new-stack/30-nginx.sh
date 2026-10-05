#!/usr/bin/env bash
# 30-nginx.sh - host nginx vhosts for the rehearsal hosts API_HOST and APP_HOST (settings, common.sh; runbook 4.1 step 1).
#
# CHANGES ON THE SERVER
#   apply   writes /etc/nginx/sites-available/<API_HOST> and .../<APP_HOST>: copies of the production api/app vhosts
#           (api.datadance.co, app.datadance.co) with only server_name and the upstream port changed (to API_PORT and
#           WEB_PORT; exactly the runbook's sed copy), each under a first line that marks it as written by this script
#           (common.sh VHOST_MARKER). The app copy keeps the http-level `map $http_upgrade $connection_upgrade` block
#           that app.datadance.co also defines (nginx 1.18 and 1.30 accept the identical duplicate map, tested
#           locally) and, only it, gets one block right after its server_name line: `location ^~ /partner-info/`, the
#           partner info page that 50-partner-page.sh writes to /srv/ddcnew/partner-info/ (static files, no-store,
#           noindex, no referrer, no framing, nosniff, a strict Content-Security-Policy). Links both into sites-enabled,
#           nginx -t, systemctl reload nginx.
#           ONLY ITS OWN FILES: apply refuses to create or overwrite anything at those names (sites-available/<host>,
#           its .new temporary, sites-enabled/<host>) that this script did not write: a file without the marker line,
#           or a link that is not its own. On 10-05 Race's rehearsal vhosts sit at the default names. With
#           TAKE_OVER_VHOSTS=yes (only after Sloan and Race agree) apply first checks that this stack answers on its
#           own ports (api 401 on 127.0.0.1:API_PORT, the web's build marker on 127.0.0.1:WEB_PORT: 40-up.sh runs
#           first), then backs those entries up to /root/ddcnew/vhost-takeover/<ts>-<pid>/ (copies, link targets and
#           a MANIFEST with their sha256, written as MANIFEST.part and renamed only when complete), then replaces them.
#           Only the other party's rehearsal vhost of exactly that host can be taken over: its only server_name is the
#           host and every proxy_pass goes to a host port a ddc-mainnet-* container binds; anything else (a static
#           site, another stack's vhost, a second name) stays refused, flag or not. From the moment the first entry is
#           removed until every check below has passed, ANY failure (a command, a stop, a signal) puts the backed-up
#           entries back at once (marked RESTORED) and reloads nginx if apply had; if that cannot finish, the script
#           says to run undo, then restore. After the reload, the Host-header checks (common.sh host_checks) run
#           through the new vhosts whenever this stack answers (always so after a take-over).
#           apply also refuses when another file that nginx loads declares one of the two hosts as a server_name
#           (nginx would answer from only one of them), and when API_PORT or WEB_PORT is held by anything other than
#           this stack's own container (common.sh port_check).
#           The rendered copies are built and checked in /root/ddcnew/nginx-render/ before anything in /etc/nginx
#           changes. A failed nginx -t removes the new files again.
#   undo    removes this script's own files and links at the two names, never anyone else's (listed, left in place);
#           nginx -t and reload only if something was removed.
#   restore [<backup name>]   the undo of a take-over: sets this script's entries at the backed-up names aside (to
#           /root/ddcnew/vhost-restore-hold/), puts the backed-up files and links of the latest (or the named) complete
#           backup back after checking them against the MANIFEST, then nginx -t and reload. If nginx -t fails, the
#           restored entries go again and this script's come back: the names never end up with neither. Refuses if
#           anything this script did not write sits at those names now. The backup stays, with a RESTORED mark (a
#           second restore of it is refused).
#   status  read-only.
#   apply, undo and restore take the run lock /root/ddcnew/.lock and log to /root/ddcnew/logs/ (common.sh run_begin).
# PASS CRITERION THAT STOPS THE SCRIPT: every other host nginx serves (the production api/app/business/admin hosts and
#   every exact server_name of the other loaded vhosts, Race's included) must answer with the same status codes after
#   the reload as before it. If not, apply, undo and restore FAIL (after printing the old-stack integrity check); apply
#   says to run ./30-nginx.sh undo at once.
# CORS: render (and so apply) refuses when the api vhost sets a literal Access-Control-Allow-Origin value (an http(s)://
#   origin), because the api copy would then need https://<APP_HOST> added by hand. Otherwise the CORS lines are
#   copied unchanged.
# UNDO: ./30-nginx.sh undo (after a take-over, then ./30-nginx.sh restore)
set -euo pipefail
HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
. "$HERE/common.sh"
require_server
cmd="${1:-status}"
case "$cmd" in apply|undo|restore) run_begin "30-nginx-$cmd" "$@";; esac
settings_say

API_SRC=$(readlink -f "$NGINX_ENABLED/api.datadance.co" || true)
APP_SRC=$(readlink -f "$NGINX_ENABLED/app.datadance.co" || true)
API_DST="$NGINX_AVAIL/$API_HOST"; APP_DST="$NGINX_AVAIL/$APP_HOST"
API_LNK="$NGINX_ENABLED/$API_HOST"; APP_LNK="$NGINX_ENABLED/$APP_HOST"
TAKEOVER_ROOT="$NEW_DIR/vhost-takeover"
RENDER_DIR="$NEW_DIR/nginx-render"
redact() { awk '{ if (tolower($0) ~ /(auth|token|secret|password|key)/) print "<redacted line>"; else print }'; }
cnt() { grep -cE "$1" "$2" || true; }
re_host='^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.datadance\.ai$'

# ---------------------------------------------------------------------------
# Vhost entries at a host's names: avail/<host>, avail/<host>.new, enabled/<host>
# ---------------------------------------------------------------------------
entry_path() { if [ "$1" = avail ]; then printf '%s' "$NGINX_AVAIL/$2"; else printf '%s' "$NGINX_ENABLED/$2"; fi; }
entries_of() { local h; for h in "$@"; do printf '%s\n' "enabled $h" "avail $h" "avail $h.new"; done; }
# The entry itself (a symlink is never followed) must be one of <host>'s entries in the two vhost directories.
guard_entry_path() { # <path> <host...>
  local p="$1" dir name h ok=0
  shift
  dir=$(resolve_path "$(dirname -- "$p")"); name=$(basename -- "$p")
  for h in "$@"; do
    [[ "$h" =~ $re_host ]] || die "refusing to write $p: '$h' is not a rehearsal host name"
    case " $PROD_HOSTS " in *" $h "*) die "refusing to write $p: $h is a production host";; esac
    if [ "$dir" = "$(resolve_path "$NGINX_AVAIL")" ] && { [ "$name" = "$h" ] || [ "$name" = "$h.new" ]; }; then ok=1; fi
    if [ "$dir" = "$(resolve_path "$NGINX_ENABLED")" ] && [ "$name" = "$h" ]; then ok=1; fi
  done
  [ "$ok" = 1 ] || die "refusing to write $p: not a vhost entry of $*"
  ddc_local_test || [ "$dir" = /etc/nginx/sites-available ] || [ "$dir" = /etc/nginx/sites-enabled ] || die "refusing to write $p: not under /etc/nginx"
}
# What sits at a path that this script did not write (for the messages; never its content).
describe() {
  local p="$1" names ups
  if [ -L "$p" ]; then printf 'symlink -> %s' "$(readlink -- "$p")"
  elif [ -d "$p" ]; then printf 'directory'
  elif [ -f "$p" ]; then
    names=$(server_names_in "$p" | tr '\n' ' ' | sed 's/ $//')
    ups=$( { grep -oE 'proxy_pass[[:space:]]+[^;]+' "$p" || true; } | awk '{print $2}' | tr '\n' ' ' | sed 's/ $//')
    printf 'file without the ddcnew marker line, sha256 %s, server_name %s, proxy_pass %s' "$(sha256 < "$p" | cut -c1-12)" "${names:-none}" "${ups:-none}"
  else printf 'not a file, link or directory'; fi
}
FOREIGN=()   # "kind name" of every entry at our names that this script did not write
scan_entries() { # <host...>
  local k n
  FOREIGN=()
  while read -r k n; do
    if [ "$(vhost_state "$k" "$n")" = foreign ]; then FOREIGN+=("$k $n"); fi
  done < <(entries_of "$@")
}
# The entries of <host...> that this script wrote (computed before anything is removed: an enabled link is ours only
# while the file it points at is).
OURS=()
scan_ours() { # <host...>
  local k n
  OURS=()
  while read -r k n; do
    if [ "$(vhost_state "$k" "$n")" = ours ]; then OURS+=("$k $n"); fi
  done < <(entries_of "$@")
}
remove_entries() { # <host...> ; removes OURS (links first)
  local e p
  [ "${#OURS[@]}" -gt 0 ] || return 0
  for e in "${OURS[@]}"; do
    p=$(entry_path "${e% *}" "${e#* }"); guard_entry_path "$p" "$@"; rm -f -- "$p"; say "removed $p"
  done
}

# ---------------------------------------------------------------------------
# Take-over backup and restore
# ---------------------------------------------------------------------------
# Only the other party's rehearsal vhost of exactly <host> may be taken over: its only server_name is <host>, it has at
# least one proxy_pass, and every proxy_pass goes to a local host port that a ddc-mainnet-* container binds (common.sh
# mainnet_ports, running or stopped). A static site (no proxy_pass: docs.datadance.ai, say), a vhost of another stack,
# one that also serves other names, or a link that leads nowhere stays refused even with TAKE_OVER_VHOSTS=yes; so no
# name the file serves can leave the before/after check of the other hosts. A link counts by the file it leads to.
TAKEOVER_WHY=""; MAINNET_PORTS=""
takeover_ok() { # <path> <host>
  local f names ups u port
  if [ -L "$1" ]; then f=$(resolve_path "$1"); [ -e "$f" ] || { TAKEOVER_WHY="it is a link that leads nowhere"; return 1; }; else f="$1"; fi
  [ -f "$f" ] || { TAKEOVER_WHY="it is not a file"; return 1; }
  names=$(server_names_in "$f" | LC_ALL=C sort -u | tr '\n' ' ')
  [ "$names" = "$2 " ] || { TAKEOVER_WHY="it declares server_name ${names:-(none) }instead of only $2"; return 1; }
  ups=$(sed -e 's/#.*//' -- "$f" | grep -oE 'proxy_pass[[:space:]]+[^;[:space:]]+' | awk '{print $2}' || true)
  [ -n "$ups" ] || { TAKEOVER_WHY="it proxies to nothing (a static site, not a rehearsal stack)"; return 1; }
  [ -n "$MAINNET_PORTS" ] || { TAKEOVER_WHY="no ${MAINNET_CTR_PREFIX}* container binds a host port, so its upstream cannot be shown to be the other party's rehearsal"; return 1; }
  for u in $ups; do
    port=$(printf '%s' "$u" | sed -nE 's#^https?://(localhost|127\.0\.0\.1):([0-9]+)(/.*)?$#\2#p')
    [ -n "$port" ] || { TAKEOVER_WHY="it proxies to $u, not to a local port"; return 1; }
    case " $MAINNET_PORTS " in *" $port "*) ;; *) TAKEOVER_WHY="it proxies to port $port, which no ${MAINNET_CTR_PREFIX}* container binds (they bind: $MAINNET_PORTS)"; return 1;; esac
  done
}
TAKEOVER_DIR=""
# The backup is written to MANIFEST.part and renamed to MANIFEST only once every entry is in it: restore, undo and
# 99-teardown.sh only ever see complete backups (a directory without MANIFEST is an interrupted backup, and nothing was
# taken over from it; apply removes it when it fails).
takeover_backup() { # FOREIGN -> $TAKEOVER_DIR: copies of the files, the targets of the links, MANIFEST
  local e k n p h tgt
  TAKEOVER_DIR="$TAKEOVER_ROOT/$(date +%Y%m%d-%H%M%S)-$$"
  guard_write_path "$TAKEOVER_DIR"
  ( umask 077; install -d -m 700 "$TAKEOVER_ROOT" "$TAKEOVER_DIR" "$TAKEOVER_DIR/avail" "$TAKEOVER_DIR/enabled" ) || die "cannot create $TAKEOVER_DIR"
  ( umask 077; : > "$TAKEOVER_DIR/MANIFEST.part" ) || die "cannot create $TAKEOVER_DIR/MANIFEST.part"
  for e in "${FOREIGN[@]}"; do
    k=${e% *}; n=${e#* }; p=$(entry_path "$k" "$n")
    if [ -L "$p" ]; then
      tgt=$(readlink -- "$p")
      case "$tgt" in ''|*[[:space:]]*) die "cannot back up $p: its link target is empty or contains a blank";; esac
      printf 'link %s %s %s\n' "$k" "$n" "$tgt" >> "$TAKEOVER_DIR/MANIFEST.part"
    elif [ -f "$p" ]; then
      cp -p -- "$p" "$TAKEOVER_DIR/$k/$n" || die "cannot copy $p into the backup"
      h=$(sha256 < "$p")
      [ "$(sha256 < "$TAKEOVER_DIR/$k/$n")" = "$h" ] || die "the backup copy of $p differs from it"
      printf 'file %s %s %s\n' "$k" "$n" "$h" >> "$TAKEOVER_DIR/MANIFEST.part"
    else die "cannot take over $p: $(describe "$p") (only a file or a symlink)"; fi
  done
  [ "$(grep -c . "$TAKEOVER_DIR/MANIFEST.part")" = "${#FOREIGN[@]}" ] || die "the backup lists $(grep -c . "$TAKEOVER_DIR/MANIFEST.part") of ${#FOREIGN[@]} entries"
  mv -f -- "$TAKEOVER_DIR/MANIFEST.part" "$TAKEOVER_DIR/MANIFEST" || die "cannot complete the backup's MANIFEST"
  say "take-over backup: $TAKEOVER_DIR ($(grep -c . "$TAKEOVER_DIR/MANIFEST") entries; MANIFEST with sha256 and link targets)"
}
MANIFEST_HOSTS=""
manifest_check() { # <backup dir>: every line well-formed, every copy matches its sha256; sets MANIFEST_HOSTS
  local d="$1" t k n x seen=" " h
  [ -f "$d/MANIFEST" ] || die "no MANIFEST in $d"
  MANIFEST_HOSTS=""
  while read -r t k n x; do
    case "$t:$k" in file:avail|file:enabled|link:avail|link:enabled) ;; *) die "MANIFEST of $d: unexpected line '$t $k $n'";; esac
    h="${n%.new}"
    [[ "$h" =~ $re_host ]] || die "MANIFEST of $d: '$n' is not a rehearsal host name"
    case "$seen" in *" $k/$n "*) die "MANIFEST of $d: $k/$n listed twice";; esac
    seen="$seen$k/$n "
    if [ "$t" = file ]; then
      [[ "$x" =~ ^[0-9a-f]{64}$ ]] || die "MANIFEST of $d: no sha256 for $k/$n"
      [ -f "$d/$k/$n" ] && [ "$(sha256 < "$d/$k/$n")" = "$x" ] || die "the backup copy $d/$k/$n is missing or differs from its MANIFEST sha256"
    else
      case "$x" in ''|*[[:space:]]*) die "MANIFEST of $d: bad link target for $k/$n";; esac
    fi
    case " $MANIFEST_HOSTS " in *" $h "*) ;; *) MANIFEST_HOSTS="${MANIFEST_HOSTS:+$MANIFEST_HOSTS }$h";; esac
  done < "$d/MANIFEST"
  [ -n "$MANIFEST_HOSTS" ] || die "MANIFEST of $d is empty"
}
RESTORED=()
put_back() { # <backup dir>: the MANIFEST entries back in place. An entry that is still there exactly as backed up is
  # left as it is (a take-over that stopped half way); anything else at the path stops it.
  local d="$1" t k n x p
  RESTORED=()
  while read -r t k n x; do
    p=$(entry_path "$k" "$n")
    # shellcheck disable=SC2086  # MANIFEST_HOSTS is a list of validated host names
    guard_entry_path "$p" $MANIFEST_HOSTS
    if [ -e "$p" ] || [ -L "$p" ]; then
      if [ "$t" = file ] && [ -f "$p" ] && [ ! -L "$p" ] && [ "$(sha256 < "$p")" = "$x" ]; then say "still in place: $p"; continue; fi
      if [ "$t" = link ] && [ -L "$p" ] && [ "$(readlink -- "$p")" = "$x" ]; then say "still in place: $p"; continue; fi
      die "put back: $p exists and is not the backed-up entry"
    fi
    if [ "$t" = file ]; then
      cp -p -- "$d/$k/$n" "$p" || die "cannot put $p back"
      [ "$(sha256 < "$p")" = "$x" ] || die "$p differs from the backup after putting it back"
    else ln -s -- "$x" "$p" || die "cannot put the link $p back"; fi
    RESTORED+=("$p"); say "put back $p ($t)"
  done < "$d/MANIFEST"
}
# The complete backups (a MANIFEST), newest last.
latest_backup() { local d; for d in "$TAKEOVER_ROOT"/*/; do if [ -f "$d/MANIFEST" ]; then basename "$d"; fi; done 2>/dev/null | { grep -E '^[0-9]{8}-[0-9]{6}-[0-9]+$' || true; } | LC_ALL=C sort | tail -n 1; }
unrestored_backups() { local d; for d in "$TAKEOVER_ROOT"/*/; do if [ -f "$d/MANIFEST" ] && [ ! -e "$d/RESTORED" ]; then basename "$d"; fi; done; }

# ---------------------------------------------------------------------------
# The rendered copies
# ---------------------------------------------------------------------------
# The partner info page (50-partner-page.sh), served by the host nginx from /srv/ddcnew/partner-info/ (www-data cannot
# traverse /root). ^~ keeps any regex location of the copied vhost away from these files. Both paths end in a slash, so
# the alias cannot be walked out of. The page needs only itself: inline CSS and JS, ./secret.json, no other origin, no
# form submission (form-action 'none') and no <base> (base-uri 'none').
PARTNER_LOCATION='location ^~ /partner-info/ {
    alias /srv/ddcnew/partner-info/;
    index index.html;
    add_header Cache-Control "no-store" always;
    add_header X-Robots-Tag "noindex, nofollow" always;
    add_header Referrer-Policy "no-referrer" always;
    add_header X-Frame-Options "DENY" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Content-Security-Policy "default-src '"'self'"'; script-src '"'self' 'unsafe-inline'"'; style-src '"'self' 'unsafe-inline'"'; connect-src '"'self'"'; img-src '"'self'"' data:; frame-ancestors '"'none'"'; form-action '"'none'"'; base-uri '"'none'"'" always;
}'
# stdin -> stdout: the block inserted once, right after the line `server_name <APP_HOST>;`, with that line's indent.
add_partner_location() {
  PARTNER_LOC="$PARTNER_LOCATION" awk -v want="server_name $APP_HOST;" '
    { print }
    !done && index($0, want) > 0 {
      match($0, /^[ \t]*/); ind = substr($0, 1, RLENGTH)
      print ""
      n = split(ENVIRON["PARTNER_LOC"], L, "\n")
      for (i = 1; i <= n; i++) print ind L[i]
      done = 1
    }'
}

# render <api-src> <app-src> <api-out> <app-out>: build both copies and check them (no nginx calls).
render() {
    [ "$(cnt '^[[:space:]]*server_name api\.datadance\.ai;' "$1")" = 1 ] || die "api vhost: expected exactly one 'server_name api.datadance.ai;'"
    [ "$(cnt 'localhost:10000;' "$1")" = 1 ] || die "api vhost: expected exactly one upstream localhost:10000"
    [ "$(cnt '^[[:space:]]*server_name app\.datadance\.ai;' "$2")" = 1 ] || die "app vhost: expected exactly one 'server_name app.datadance.ai;'"
    [ "$(cnt 'localhost:9001;' "$2")" = 1 ] || die "app vhost: expected exactly one upstream localhost:9001"
    hard=$(cnt "Access-Control-Allow-Origin[\"']?[[:space:]]+[\"']?https?://" "$1")
    [ "$hard" = 0 ] || die "api vhost now hard-codes $hard CORS origin(s): add https://$APP_HOST to the api copy by hand, then re-run"
    say "api vhost CORS: lines with \$http_origin=$(cnt 'Access-Control-Allow-Origin.*\$http_origin' "$1"), hard-coded origins=0 -> no CORS change needed"

    { printf '%s\n# %s: copy of api.datadance.co for the rehearsal, host name and upstream port (%s) changed.\n' "$VHOST_MARKER" "$API_HOST" "$API_PORT"
      sed -e "s#server_name api\.datadance\.ai;#server_name $API_HOST;#" -e "s#localhost:10000;#localhost:$API_PORT;#" "$1"; } > "$3"
    { printf '%s\n# %s: copy of app.datadance.co for the rehearsal, host name and upstream port (%s) changed.\n' "$VHOST_MARKER" "$APP_HOST" "$WEB_PORT"
      sed -e "s#server_name app\.datadance\.ai;#server_name $APP_HOST;#" -e "s#localhost:9001;#localhost:$WEB_PORT;#" "$2" | add_partner_location; } > "$4"

    [ "$(head -n 1 "$3")" = "$VHOST_MARKER" ] && [ "$(head -n 1 "$4")" = "$VHOST_MARKER" ] || die "a copy lacks the ddcnew marker line"
    [ "$(cnt "server_name $API_HOST;" "$3")" = 1 ] && [ "$(cnt '^[[:space:]]*server_name[[:space:]]' "$3")" = 1 ] || die "api copy: server_name check failed"
    [ "$(cnt "localhost:$API_PORT;" "$3")" = 1 ] && [ "$(cnt 'localhost:10000;' "$3")" = 0 ] || die "api copy: upstream check failed"
    [ "$(cnt "server_name $APP_HOST;" "$4")" = 1 ] && [ "$(cnt '^[[:space:]]*server_name[[:space:]]' "$4")" = 1 ] || die "app copy: server_name check failed"
    [ "$(cnt "localhost:$WEB_PORT;" "$4")" = 1 ] && [ "$(cnt 'localhost:9001;' "$4")" = 0 ] || die "app copy: upstream check failed"
    [ "$(cnt '\$connection_upgrade' "$4")" -ge 1 ] || die "app copy lost the Connection header"
    [ "$(cnt 'location \^~ /downloads/' "$4")" = 1 ] && [ "$(cnt 'location \^~ /architecture/' "$4")" = 1 ] || die "app copy lost /downloads/ or /architecture/"
    [ "$(cnt 'partner-info' "$3")" = 0 ] || die "api copy: it must not serve /partner-info/"
    [ "$(cnt 'location \^~ /partner-info/ [{]' "$4")" = 1 ] && [ "$(cnt 'partner-info' "$4")" = 2 ] || die "app copy: expected exactly one /partner-info/ location"
    got=$(awk '!on && /location \^~ \/partner-info\/ [{]/ { on = 1; match($0, /^[ \t]*/); ind = RLENGTH }
               on { print substr($0, ind + 1); if ($0 ~ /^[ \t]*}[ \t]*$/) exit }' "$4")
    [ "$got" = "$PARTNER_LOCATION" ] || die "app copy: the /partner-info/ location is not exactly the block in 30-nginx.sh"
    say "app copy: /partner-info/ location added after its server_name line ($(printf '%s\n' "$PARTNER_LOCATION" | grep -c 'add_header') headers)"
    say "diff api.datadance.co -> $API_HOST:"; diff "$1" "$3" | grep '^[<>]' | redact || true
    say "diff app.datadance.co -> $APP_HOST:"; diff "$2" "$4" | grep '^[<>]' | redact || true
}

# The checks around a reload: the other hosts must answer as before (HOSTS is fixed before anything changes).
HOSTS=(); BEFORE=""
codes_before() { # <excluded host...>
  local h
  HOSTS=()
  while IFS= read -r h; do HOSTS+=("$h"); done < <(other_hosts "$@")
  BEFORE=$(host_codes "${HOSTS[@]}"); say "other hosts before: $BEFORE"
}
codes_after() { # <message when they changed>
  local after
  after=$(host_codes "${HOSTS[@]}"); say "other hosts after:  $after"
  if [ "$BEFORE" = "$after" ]; then pass "every other host answers exactly as before (${#HOSTS[@]} hosts)"; return 0; fi
  printf 'FAIL status codes of other hosts changed: before [%s] after [%s]\n' "$BEFORE" "$after" >&2
  ( old_snapshot_assert ) || true   # report containers and old files too, then stop
  die "$1"
}

# ---------------------------------------------------------------------------
# A take-over that does not complete puts the other party's entries back (E1): from the moment the first of them is
# removed until apply has passed every check, any exit that is not the successful end (a failing command, die, a
# signal) runs takeover_rollback. It removes this package's entries at the two names, puts the backup back (marking it
# RESTORED), runs nginx -t and reloads if apply had reloaded. If that fails, it says to run undo, then restore.
# ---------------------------------------------------------------------------
TAKEN=0; RELOADED=0
takeover_rollback() {
  local rc=$? ok=1
  trap - EXIT HUP INT TERM
  [ "$TAKEN" = 1 ] || exit "$rc"
  set +e
  printf 'FAIL the take-over did not complete: putting the taken-over entries back from %s\n' "$TAKEOVER_DIR" >&2
  scan_ours "$API_HOST" "$APP_HOST"
  ( remove_entries "$API_HOST" "$APP_HOST" ) || ok=0
  if [ "$ok" = 1 ] && ( manifest_check "$TAKEOVER_DIR" && put_back "$TAKEOVER_DIR" ); then
    ( umask 077; date '+restored %Y-%m-%d %H:%M:%S %Z by the rollback of a failed apply' > "$TAKEOVER_DIR/RESTORED" )
    if nginx -t 2>/dev/null; then
      if [ "$RELOADED" = 1 ]; then systemctl reload nginx && say "rolled back: the other party's entries are back and nginx is reloaded with them"
      else say "rolled back: the other party's entries are back; nginx was not reloaded, so it never served this package's"; fi
    else
      printf 'FAIL nginx -t fails even with the other party'"'"'s entries back: check nginx by hand now (nginx -t)\n' >&2
    fi
  else
    printf 'FAIL could not put the taken-over entries back: run ./30-nginx.sh undo, then ./30-nginx.sh restore %s\n' "$(basename "$TAKEOVER_DIR")" >&2
  fi
  exit "$rc"
}
# restore keeps this package's entries aside until the restored ones pass nginx -t and the reload (E3): if they do not,
# the restored entries go again and this package's come back, so the names never end up with neither.
HOLD=""; HELD=(); RESTORING=0
restore_rollback() {
  local rc=$? e k n
  trap - EXIT HUP INT TERM
  [ "$RESTORING" = 1 ] || exit "$rc"
  set +e
  printf 'FAIL the restore did not complete: removing the restored entries and putting this package'"'"'s back from %s\n' "$HOLD" >&2
  for e in ${RESTORED[@]+"${RESTORED[@]}"}; do rm -f -- "$e"; done
  for e in ${HELD[@]+"${HELD[@]}"}; do k=${e% *}; n=${e#* }; mv -f -- "$HOLD/$k/$n" "$(entry_path "$k" "$n")" && say "put back $(entry_path "$k" "$n") (this package's)"; done
  if nginx -t 2>/dev/null; then say "this package's entries are back; nginx was not reloaded, so it never served the restored ones"
  else printf 'FAIL nginx -t fails with this package'"'"'s entries back too: check nginx by hand now (nginx -t); the backup is unchanged\n' >&2; fi
  exit "$rc"
}

case "$cmd" in
  apply)
    nginx -t 2>/dev/null || die "nginx -t fails BEFORE any change; not touching nginx"
    old_snapshot_begin
    codes_before "$API_HOST" "$APP_HOST"
    for p in "$RENDER_DIR" "$RENDER_DIR/$API_HOST" "$RENDER_DIR/$APP_HOST"; do guard_write_path "$p"; done
    ( umask 077; install -d -m 700 "$RENDER_DIR" ) || die "cannot create $RENDER_DIR"
    render "$API_SRC" "$APP_SRC" "$RENDER_DIR/$API_HOST" "$RENDER_DIR/$APP_HOST"

    step "who wrote what sits at $API_HOST / $APP_HOST now"
    scan_entries "$API_HOST" "$APP_HOST"
    if [ "${#FOREIGN[@]}" -gt 0 ]; then
      for e in "${FOREIGN[@]}"; do p=$(entry_path "${e% *}" "${e#* }"); say "  not written by this package: $p ($(describe "$p"))"; done
      [ "$TAKE_OVER_VHOSTS" = yes ] || die "refusing: ${#FOREIGN[@]} vhost entry(s) at the names $API_HOST / $APP_HOST were not written by this package (listed above; on 10-05 Race's rehearsal vhosts have the default names), and this script never overwrites them. Either choose other names (API_HOST=... APP_HOST=..., with their DNS records), or, once Sloan and Race agree that this stack takes the names over, re-run with TAKE_OVER_VHOSTS=yes: the entries are backed up first, and ./30-nginx.sh restore puts them back"
      MAINNET_PORTS=$(mainnet_ports)
      say "host ports bound by ${MAINNET_CTR_PREFIX}* containers: ${MAINNET_PORTS:-none}"
      for e in "${FOREIGN[@]}"; do
        p=$(entry_path "${e% *}" "${e#* }"); h=${e#* }; h=${h%.new}
        takeover_ok "$p" "$h" || die "refusing to take over $p: $TAKEOVER_WHY. TAKE_OVER_VHOSTS takes over only the other party's rehearsal vhost of exactly that host: check API_HOST / APP_HOST"
      done
      pass "TAKE_OVER_VHOSTS=yes: each of the ${#FOREIGN[@]} entries is a rehearsal vhost of exactly its host whose every upstream is a ${MAINNET_CTR_PREFIX}* port ($MAINNET_PORTS)"
    else pass "nothing at these names that this package did not write"; fi
    c=$(for h in "$API_HOST" "$APP_HOST"; do server_name_users "$h" "$API_LNK" "$APP_LNK" | sed "s|^|$h declared by |"; done)
    [ -z "$c" ] || { printf '%s\n' "$c" | sed 's/^/  /'; die "refusing: another file that nginx loads declares $API_HOST or $APP_HOST as a server_name (listed above), so nginx would answer from only one of them. Its owner removes or renames it first (TAKE_OVER_VHOSTS covers only the entries at our names)"; }
    pass "no other loaded vhost declares $API_HOST or $APP_HOST"
    port_check "$API_PORT" api API_PORT; port_check "$WEB_PORT" web WEB_PORT
    pass "API_PORT $API_PORT and WEB_PORT $WEB_PORT are free or held by this stack's own containers"
    for p in "$API_DST" "$APP_DST" "$API_DST.new" "$APP_DST.new" "$API_LNK" "$APP_LNK"; do guard_entry_path "$p" "$API_HOST" "$APP_HOST"; done
    settings_record

    if [ "${#FOREIGN[@]}" -gt 0 ]; then
      # The other party's hosts are only ever pointed at a stack that has booted (40-up.sh first).
      stack_answers || die "refusing TAKE_OVER_VHOSTS=yes until this stack answers on its own ports: $STACK_WHY. Run 40-up.sh first (APPROVAL.md section 9, outcome A): the other party's hosts must never point at a stack that has not booted"
      pass "this stack answers: api 401 on 127.0.0.1:$API_PORT/partner/tge/me, web build marker for https://$API_HOST/api on 127.0.0.1:$WEB_PORT"
      step "take-over (TAKE_OVER_VHOSTS=yes): back up, then replace"
      trap 'rm -rf -- "$TAKEOVER_DIR"' EXIT   # an interrupted backup goes; nothing was taken over from it
      takeover_backup
      for e in "${FOREIGN[@]}"; do p=$(entry_path "${e% *}" "${e#* }"); old_files_forget "$p"; done
      trap takeover_rollback EXIT; trap 'exit 129' HUP; trap 'exit 130' INT; trap 'exit 143' TERM
      TAKEN=1
      for e in "${FOREIGN[@]}"; do p=$(entry_path "${e% *}" "${e#* }"); rm -f -- "$p"; say "taken over: $p (backed up)"; done
    fi
    step "install"
    for pair in "$API_HOST:$API_DST" "$APP_HOST:$APP_DST"; do
      h=${pair%%:*}; d=${pair#*:}
      rm -f -- "$d.new"   # ours or absent (checked above)
      cp "$RENDER_DIR/$h" "$d.new"; chmod 644 "$d.new"; mv -f "$d.new" "$d"
    done
    ln -sfn "$API_DST" "$API_LNK"; ln -sfn "$APP_DST" "$APP_LNK"
    [ "$(vhost_state avail "$API_HOST")$(vhost_state avail "$APP_HOST")$(vhost_state enabled "$API_HOST")$(vhost_state enabled "$APP_HOST")" = oursoursoursours ] \
      || die "after the install the four entries are not this script's own files and links"
    install -d -m 700 "$NEW_DIR/logs"
    if [ "$TAKEN" = 1 ]; then UNDO_MSG="the take-over is rolled back now, the other party's entries go back from the backup (if that fails: ./30-nginx.sh undo, then ./30-nginx.sh restore)"
    else UNDO_MSG="run ./30-nginx.sh undo now"; fi
    if ! nginx -t 2>"$NEW_DIR/logs/nginx-t.out"; then
      tail -3 "$NEW_DIR/logs/nginx-t.out" | redact
      if [ "$TAKEN" = 0 ]; then
        scan_ours "$API_HOST" "$APP_HOST"; remove_entries "$API_HOST" "$APP_HOST"
        nginx -t 2>/dev/null && say "rolled back: the new files removed, nginx -t passes again (nothing was reloaded)"
      fi
      die "nginx -t failed with the new vhosts"
    fi
    pass "nginx -t ok"
    systemctl reload nginx; RELOADED=1; sleep 1
    pass "nginx reloaded"
    grep -nE 'server_name|listen|proxy_pass|alias' "$API_DST" "$APP_DST"
    codes_after "status codes of other hosts changed after the reload — $UNDO_MSG"
    # The Host-header checks need this stack running: always so after a take-over (checked before it), otherwise 40-up.sh
    # runs them when it starts the stack after this.
    if stack_answers; then
      step "Host-header checks through the host nginx"
      ( host_checks ) || die "the Host-header checks failed after the reload — $UNDO_MSG"
    else say "$API_HOST /partner/tge/me=$(host_code "$API_HOST" /partner/tge/me), $APP_HOST /=$(host_code "$APP_HOST" /): this stack does not answer yet ($STACK_WHY), so 40-up.sh runs the Host-header checks when it starts it"; fi
    old_snapshot_assert
    if [ "$TAKEN" = 1 ]; then TAKEN=0; trap - EXIT HUP INT TERM; pass "take-over complete: $API_HOST and $APP_HOST now serve this stack (./30-nginx.sh undo, then ./30-nginx.sh restore, puts the other party's back)"; fi
    ;;
  undo)
    old_snapshot_begin
    codes_before "$API_HOST" "$APP_HOST"
    scan_ours "$API_HOST" "$APP_HOST"; scan_entries "$API_HOST" "$APP_HOST"
    if [ "${#FOREIGN[@]}" -gt 0 ]; then
      for e in "${FOREIGN[@]}"; do p=$(entry_path "${e% *}" "${e#* }"); say "left in place, not written by this package: $p ($(describe "$p"))"; done
    fi
    if [ "${#OURS[@]}" = 0 ]; then
      pass "nothing of this package's at $API_HOST / $APP_HOST: nothing removed, nginx not reloaded"
    else
      remove_entries "$API_HOST" "$APP_HOST"
      nginx -t 2>/dev/null || die "nginx -t fails after removing this package's vhosts - check by hand"
      systemctl reload nginx; sleep 1
      pass "this package's vhosts for $API_HOST / $APP_HOST removed, nginx reloaded"
      codes_after "status codes of other hosts changed after the reload — this package's vhosts are already removed: check the old stack now (nginx -t, docker ps, the other vhosts)"
    fi
    b=$(unrestored_backups | tail -n 1); [ -z "$b" ] || say "take-over backup not restored yet: $TAKEOVER_ROOT/$b (./30-nginx.sh restore puts its entries back)"
    old_snapshot_assert
    ;;
  restore)
    b="${2:-$(latest_backup)}"
    [[ "$b" =~ ^[0-9]{8}-[0-9]{6}-[0-9]+$ ]] || die "no take-over backup to restore (expected a name like 20261005-170000-1234 under $TAKEOVER_ROOT)"
    TAKEOVER_DIR="$TAKEOVER_ROOT/$b"
    [ -d "$TAKEOVER_DIR" ] && [ ! -L "$TAKEOVER_DIR" ] || die "$TAKEOVER_DIR is not a directory"
    [ ! -e "$TAKEOVER_DIR/RESTORED" ] || die "$TAKEOVER_DIR was already restored ($(head -n 1 "$TAKEOVER_DIR/RESTORED"))"
    manifest_check "$TAKEOVER_DIR"
    say "restoring $TAKEOVER_DIR: $(grep -c . "$TAKEOVER_DIR/MANIFEST") entries for $MANIFEST_HOSTS"
    old_snapshot_begin
    # shellcheck disable=SC2086  # validated host names
    codes_before $MANIFEST_HOSTS
    # shellcheck disable=SC2086
    scan_entries $MANIFEST_HOSTS
    if [ "${#FOREIGN[@]}" -gt 0 ]; then
      for e in "${FOREIGN[@]}"; do p=$(entry_path "${e% *}" "${e#* }"); say "  not written by this package: $p ($(describe "$p"))"; done
      die "refusing: something this package did not write sits at those names now (listed above): not overwriting it"
    fi
    # shellcheck disable=SC2086
    scan_ours $MANIFEST_HOSTS
    # This package's entries are set aside, not deleted, until the restored ones pass nginx -t and the reload.
    HOLD="$NEW_DIR/vhost-restore-hold/$(date +%Y%m%d-%H%M%S)-$$"
    guard_write_path "$HOLD"
    ( umask 077; install -d -m 700 "$NEW_DIR/vhost-restore-hold" "$HOLD" "$HOLD/avail" "$HOLD/enabled" ) || die "cannot create $HOLD"
    trap restore_rollback EXIT; trap 'exit 129' HUP; trap 'exit 130' INT; trap 'exit 143' TERM
    RESTORING=1
    for e in ${OURS[@]+"${OURS[@]}"}; do
      p=$(entry_path "${e% *}" "${e#* }")
      # shellcheck disable=SC2086  # validated host names
      guard_entry_path "$p" $MANIFEST_HOSTS
      mv -f -- "$p" "$HOLD/${e% *}/${e#* }" || die "cannot set $p aside"
      HELD+=("$e"); say "set aside $p (this package's, until the restore passes)"
    done
    put_back "$TAKEOVER_DIR"
    old_files_adopt ${RESTORED[@]+"${RESTORED[@]}"}
    nginx -t 2>/dev/null || die "nginx -t fails with the restored entries: they go again and this package's come back; nginx was not reloaded. Check the backup's entries by hand"
    systemctl reload nginx; sleep 1
    RESTORING=0; trap - EXIT HUP INT TERM
    rm -rf -- "$HOLD"
    ( umask 077; date '+restored %Y-%m-%d %H:%M:%S %Z' > "$TAKEOVER_DIR/RESTORED" ) || die "cannot mark $TAKEOVER_DIR as restored"
    pass "restored ${#RESTORED[@]} entries from $TAKEOVER_DIR (the backup stays, marked RESTORED), nginx reloaded"
    codes_after "status codes of other hosts changed after the reload — check the old stack now"
    old_snapshot_assert
    ;;
  render)  # local test only: ./30-nginx.sh render <api-src> <app-src> <out-dir>
    ddc_local_test || die "render is for the local test (DDC_LOCAL_TEST=1)"
    mkdir -p "$4"; render "$2" "$3" "$4/$API_HOST" "$4/$APP_HOST"; pass "rendered and checked both copies"
    ;;
  status)
    while read -r k n; do
      p=$(entry_path "$k" "$n"); s=$(vhost_state "$k" "$n")
      case "$s" in foreign) say "$p: NOT written by this package ($(describe "$p"))";; *) say "$p: $s";; esac
    done < <(entries_of "$API_HOST" "$APP_HOST")
    for f in "$API_DST" "$APP_DST"; do if vhost_file_ours "$f"; then grep -nE 'server_name|proxy_pass|partner-info' "$f" || true; fi; done
    for h in "$API_HOST" "$APP_HOST"; do
      u=$(server_name_users "$h" "$API_LNK" "$APP_LNK" | tr '\n' ' '); [ -z "$u" ] || say "ALSO declared as a server_name by: $u($h)"
    done
    for pp in "API_PORT $API_PORT" "WEB_PORT $WEB_PORT" "DB_PORT $DB_PORT"; do
      if port_in_use "${pp#* }"; then say "$pp: in use by $(port_publishers "${pp#* }" | tr '\n' ' ')"; else say "$pp: free"; fi
    done
    HOSTS=(); while IFS= read -r h; do HOSTS+=("$h"); done < <(other_hosts "$API_HOST" "$APP_HOST")
    say "other hosts: $(host_codes "${HOSTS[@]}")"
    say "take-over backups: $(latest_backup | sed 's/^$/none/'); not restored yet: $(unrestored_backups | tr '\n' ' ' | sed 's/^$/none/')"
    ;;
  *) die "usage: $0 apply | undo | restore [<backup name>] | status | render (local test)";;
esac
