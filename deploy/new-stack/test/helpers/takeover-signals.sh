#!/usr/bin/env bash
# takeover-signals.sh <package dir> <new scratch dir>   (local test helper for run-local-tests.sh section 12c; it touches
# no server and opens no connection)
# 30-nginx.sh apply with TAKE_OVER_VHOSTS=yes in a stub world (stub nginx, systemctl, ss and docker; curl is
# test/helpers/stub-curl.py), where a signal arrives right after the other party's entries were removed, while the new
# vhost file is being chmod-ed: TERM to the script alone (the documented stop, kill <pid>), and TERM, HUP and INT to its
# whole process group (what Ctrl-C or the hangup of an interactive session sends: the run_begin wrapper and the log's tee
# get it too). Every time, the rollback must put the other party's four entries back exactly, mark the backup RESTORED,
# and its lines must reach the server-side log. Prints PASS/FAIL lines and exits with the number of FAILs. It runs under
# whatever bash runs it (bash 3.2 on the Mac, bash 5.1 in ubuntu:jammy), and 30-nginx.sh then runs under the same bash.
set -u
PKG="$1"; S="$2"
[ ! -e "$S" ] || { echo "FAIL takeover-signals: scratch dir $S exists"; exit 1; }
mkdir -p "$S/stubs"
V="bash ${BASH_VERSION%%(*}"
fails=0; ok() { echo "PASS $V: $*"; }; bad() { echo "FAIL $V: $*"; fails=$((fails + 1)); }
A=api-rehearsal.datadance.ai; P=app-rehearsal.datadance.ai
sum() { if command -v sha256sum >/dev/null 2>&1; then sha256sum | cut -c1-16; else shasum -a 256 | cut -c1-16; fi; }
REAL_CHMOD=$(command -v chmod)
ST="$S/stubs"
printf '#!/bin/sh\nexit 0\n' > "$ST/nginx"
printf '#!/bin/sh\n[ "$1 $2" = "reload nginx" ] && { touch "$STUB_DIR/reloaded"; echo reload >> "$STUB_DIR/reloads"; }\nexit 0\n' > "$ST/systemctl"
printf '#!/bin/sh\nexit 0\n' > "$ST/ss"
cp "$PKG/test/helpers/stub-curl.py" "$ST/curl"
cat > "$ST/docker" <<'EOF'
#!/bin/sh
case "$1" in
  ps) case "$*" in *"{{.Names}} {{.Ports}}"*) ;; *"{{.Names}}"*) printf '%s\n' ddc-mainnet-api ddc-mainnet-app;; esac;;
  inspect) for c; do :; done
           case "$*" in
             *PortBindings*) case "$c" in ddc-mainnet-api) echo "10010 ";; ddc-mainnet-app) echo "9011 ";; esac;;
             *"{{.Name}}|{{.Id}}"*) echo "/$c|id-$c|running|2026-10-05T04:00:00Z|0|unless-stopped";;
           esac;;
esac
exit 0
EOF
"$REAL_CHMOD" 755 "$ST"/*
snap() { (cd "$1" && find avail enabled -mindepth 1 \( -type f -o -type l \) | LC_ALL=C sort | while IFS= read -r f; do
  if [ -L "$f" ]; then echo "L $f -> $(readlink "$f")"; else echo "F $f $(sum < "$f")"; fi; done); }
world() { # <dir>: the two synthetic production vhosts, the other party's entries at our names (a link, and a regular file
  # in sites-enabled), this stack up, and a chmod that sends <signal> to the script or to its process group
  local w="$1" sig="$2" to="$3"
  mkdir -p "$w/avail" "$w/enabled" "$w/confd" "$w/ddcnew" "$w/bin"
  cp "$PKG/test/fixtures/api.datadance.co" "$PKG/test/fixtures/app.datadance.co" "$w/avail/"
  ln -s "$w/avail/api.datadance.co" "$w/enabled/api.datadance.co"; ln -s "$w/avail/app.datadance.co" "$w/enabled/app.datadance.co"
  printf 'server {\n    server_name %s;\n    location / { proxy_pass http://localhost:10010; }\n    listen 80;\n}\n' "$A" > "$w/avail/$A"
  printf 'server {\n    server_name %s;\n    location / { proxy_pass http://localhost:9011; }\n    listen 80;\n}\n' "$P" > "$w/avail/$P"
  ln -s "../avail/$A" "$w/enabled/$A"; cp -p "$w/avail/$P" "$w/enabled/$P"
  touch "$w/stack-up"; snap "$w" > "$w/orig.snap"
  cat > "$w/bin/chmod" <<EOF
#!/bin/bash
# the first chmod of a new vhost file (the other party's entries are gone by then): note the script's pid, signal it
# (bash, not sh: dash's kill does not take "--" before a negative process group id)
pgid_of() { if [ -r /proc/\$1/stat ]; then awk '{print \$5}' /proc/\$1/stat; else ps -o pgid= -p \$1 | tr -d ' '; fi; }
for a in "\$@"; do case "\$a" in *.new)
  if [ ! -e "$w/signalled" ]; then
    echo \$PPID > "$w/script.pid"; : > "$w/signalled"   # first: a group signal also ends this process
    if [ "$to" = group ]; then kill -$sig -- -\$(pgid_of \$PPID); else kill -$sig \$PPID; fi
  fi;; esac; done
exec "$REAL_CHMOD" "\$@"
EOF
  "$REAL_CHMOD" 755 "$w/bin/chmod"
}
apply_in_own_group() { # <dir>: 30-nginx.sh apply TAKE_OVER_VHOSTS=yes in a process group of its own
  # The script starts with the default dispositions of the signals sent here, whatever this helper inherited: nohup
  # ignores HUP, a background job ignores INT and QUIT, and a shell can never trap a signal ignored when it started.
  local w="$1"
  set -- python3 -c 'import os, signal, sys
for s in (signal.SIGHUP, signal.SIGINT, signal.SIGQUIT, signal.SIGTERM, signal.SIGPIPE): signal.signal(s, signal.SIG_DFL)
os.execvp(sys.argv[1], sys.argv[1:])' env PATH="$w/bin:$ST:$PATH" STUB_DIR="$w" OUR_HOSTS="$A $P" STUB_API_HOST="$A" STUB_API_PORT=10020 STUB_WEB_PORT=9021 CHANGE_HOST=none \
    DDC_LOCAL_TEST=1 NEW_DIR="$w/ddcnew" NGINX_AVAIL="$w/avail" NGINX_ENABLED="$w/enabled" NGINX_CONFD="$w/confd" MAINNET_DIR="$w/mainnet" \
    TAKE_OVER_VHOSTS=yes "$BASH" "$PKG/30-nginx.sh" apply
  # (the braces' 2>/dev/null takes bash's own "Terminated"/"Hangup" notice about the wrapper that the signal ends)
  if command -v setsid >/dev/null 2>&1; then { setsid -w "$@" > "$w/out" 2>&1 < /dev/null; } 2>/dev/null
  else { set -m; "$@" > "$w/out" 2>&1 < /dev/null & wait $!; set +m; } 2>/dev/null; fi
  return 0
}
wait_script() { # <dir>: until the script itself has ended (a group signal also ends the wrapper that started it)
  local w="$1" pid end
  end=$(( $(date +%s) + 60 ))
  if command -v flock >/dev/null 2>&1 && [ -e "$w/ddcnew/.lock" ]; then flock -w 60 "$w/ddcnew/.lock" true; return 0; fi
  pid=$(cat "$w/script.pid" 2>/dev/null || true)
  [ -n "$pid" ] || return 0
  while kill -0 "$pid" 2>/dev/null && [ "$(date +%s)" -lt "$end" ]; do sleep 0.2; done
}
for c in "TERM script" "TERM group" "HUP group" "INT group"; do
  sig=${c% *}; to=${c#* }; w="$S/$sig-$to"
  world "$w" "$sig" "$to"
  apply_in_own_group "$w"
  wait_script "$w"
  log=$(ls "$w"/ddcnew/logs/*30-nginx-apply*.log 2>/dev/null | head -n 1)
  bk=$(ls -d "$w"/ddcnew/vhost-takeover/*/ 2>/dev/null | head -n 1)
  what="$sig to the $([ "$to" = group ] && echo 'whole process group' || echo 'script alone') right after the removal"
  if [ ! -e "$w/signalled" ]; then bad "$what: the take-over never reached the install, so no signal was sent: $(grep -m1 '^FAIL' "$w/out" 2>/dev/null)"
  elif grep -q '^PASS take-over complete' "$w/out" "$log" 2>/dev/null; then bad "$what: the signal had no effect (the take-over completed)"
  elif snap "$w" | cmp -s - "$w/orig.snap" && [ -n "$bk" ] && [ -f "$bk/RESTORED" ] && [ -n "$log" ] \
     && grep -q '^FAIL the take-over did not complete: putting the taken-over entries back' "$log" \
     && grep -q "^rolled back: the other party's entries are back" "$log"; then
    ok "$what: the other party's 4 entries are back exactly, the backup is marked RESTORED, and the rollback is in the server-side log"
  else
    n=$(grep -cE '^(FAIL the take-over did not complete|rolled back:)' "$log" 2>/dev/null) || true
    bad "$what: entries back exactly=$(snap "$w" | cmp -s - "$w/orig.snap" && echo yes || echo NO) RESTORED=$([ -n "$bk" ] && [ -f "$bk/RESTORED" ] && echo yes || echo no) rollback lines in the log=${n:-0}"
  fi
done
exit "$fails"
