#!/usr/bin/env bash
# sshmux.sh - LOCAL (Mac): one 1Password approval per deploy. Shares ONE SSH login among every remote.sh and
# survey/ro-ssh.sh call until it closes. Never uploaded. CHANGES ON THE SERVER: nothing (one login session stays open).
#   ./sshmux.sh open [minutes]   reads the server password from 1Password once (the precheck: nothing connects if it
#                                fails), logs in once and leaves an OpenSSH master in the background; prints only
#                                "shared connection open until HH:MM". minutes: 1-240, default 180.
#   ./sshmux.sh status           "open until HH:MM" (exit 0) or "closed" (exit 1); never asks 1Password
#   ./sshmux.sh close            ends the master at once (`ssh -O exit`) and removes its directory
# Use: `./sshmux.sh open` before the first step, `./sshmux.sh close` after the last one; every step in between runs
# with the same TMPDIR (the master's socket is found under it) and asks 1Password nothing.
#
# How (sshpw.sh, "Shared connection"): the login and the 1Password reference come from local.env, as for every
# helper. `open` creates an askpass that prints the one line on its stdin (sshpw_askpass_text stdin), reads the
# password with `op read` once, pipes it to ssh's stdin (never an argument, the environment or a file) and starts
#   ssh <SSHPW_OPTS> -o ServerAliveInterval=30 -o ControlMaster=yes -o ControlPersist=<minutes>m
#       -o ControlPath=<private directory>/<socket> -f -N <target>
# which forks to the background once logged in; the askpass file is removed at once. The directory is
# ${TMPDIR:-/tmp}/ddc-sshmux-<uid>: created 0700, refused when it is not this user's, not 0700 or a link. The end
# time (now + minutes) is recorded next to the socket with the master's pid; ControlPersist also ends the master after
# that many minutes without a call. At the end time the master stops taking calls (`ssh -O stop`: a call still
# running finishes first): a background watchdog of this script does it, and remote.sh / ro-ssh.sh refuse to use an
# expired master too (sshpw_mux_alive). The same guards as every login: NumberOfPasswordPrompts=1, password method
# only; an empty or failed 1Password read stops before anything connects, and the askpass kills ssh when it gets no
# password. Only one `open` runs at a time (a lock file in the directory).
# If the master ends early (network, sleep, `close`): the call running through it fails with exit 255 and is not
# retried; later calls log in the usual way (1Password asked as without this script) and say so on stderr, until
# `open` runs again.
set -euo pipefail
PKG="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=sshpw.sh
. "$PKG/sshpw.sh"

usage() { sed -n '4,8p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }

# watchdog <socket> <master pid>: every 10 s until that master ends; stops it (`-O stop`) once its record is gone,
# names another master or reaches its end time, and only while that very master still answers on the socket.
watchdog() {
  set +e
  local u mp
  trap '' HUP INT
  while sleep 10; do
    kill -0 "$2" 2>/dev/null || exit 0
    u=""; mp=""; read -r u mp < "$1.until" 2>/dev/null
    if [ "$mp" != "$2" ] || ! [[ "$u" =~ ^[0-9]+$ ]] || [ "$(date +%s)" -ge "$u" ]; then
      if [ "$(sshpw_mux_pid "$1")" = "$2" ]; then sshpw_mux_stop "$1"; fi
      exit 0
    fi
  done
}

cmd="${1:-}"
case "$cmd" in
  open)
    m="${2:-180}"
    [[ "$m" =~ ^[0-9]{1,3}$ ]] && [ "$m" -ge 1 ] && [ "$m" -le 240 ] || { echo "refusing: minutes must be a whole number from 1 to 240 (default 180)" >&2; exit 2; }
    sshpw_load_local_env || exit 3
    sshpw_mux_path_check || exit 3
    if sshpw_mux_alive quiet; then
      echo "shared connection already open until $(sshpw_hhmm "$SSHPW_MUX_UNTIL") (./sshmux.sh close first for a new one)"; exit 0
    fi
    d=$(sshpw_mux_dir); p=$(sshpw_mux_path)
    if [ ! -e "$d" ] && [ ! -L "$d" ]; then mkdir -m 700 "$d" || { echo "REFUSING TO CONNECT: cannot create $d; not connected" >&2; exit 3; }; fi
    sshpw_mux_dir_ok || { echo "REFUSING TO CONNECT: $d is not a private directory of this user (0700, not a link); not connected" >&2; exit 3; }
    lk="$d/open.lock"; a=""
    if ! ( set -C; printf '%s\n' "$$" > "$lk" ) 2>/dev/null; then
      o=$(cat "$lk" 2>/dev/null || true)
      if [[ "$o" =~ ^[0-9]+$ ]] && kill -0 "$o" 2>/dev/null; then echo "refusing: another ./sshmux.sh open is running (pid $o)" >&2; exit 2; fi
      rm -f "$lk"; ( set -C; printf '%s\n' "$$" > "$lk" ) 2>/dev/null || { echo "refusing: cannot take the lock $lk" >&2; exit 2; }
    fi
    trap 'rm -f "$lk" ${a:+"$a"}' EXIT
    rm -f "$p" "$p.until"   # sshpw_mux_alive left no master answering on it
    a=$(mktemp "$d/askpass.XXXXXX") && sshpw_make_askpass "$a" stdin || { echo "REFUSING TO CONNECT: the askpass file could not be created in $d; not connected" >&2; exit 3; }
    # The precheck and the only 1Password read: nothing connects unless it returns a non-empty value.
    pw=$("$SSHPW_OP_BIN" read "$SSHPW_OP_REF" 2>/dev/null </dev/null) && [ -n "$pw" ] || {
      echo "REFUSING TO CONNECT: 1Password did not return the server password (op read failed: locked, not approved, or timed out). No SSH connection was made. Approve 1Password, then re-run." >&2; exit 3; }
    rc=0
    printf '%s\n' "$pw" | SSH_ASKPASS="$a" SSH_ASKPASS_REQUIRE=force DISPLAY=none \
      ssh "${SSHPW_OPTS[@]}" -o ServerAliveInterval=30 -o ControlMaster=yes -o ControlPersist="${m}m" -o ControlPath="$p" -f -N "$SSHPW_TARGET" || rc=$?
    pw=""
    rm -f "$a"; a=""
    [ "$rc" = 0 ] || { echo "FAILED: ssh did not log in (exit $rc); no shared connection is open (steps log in the usual way)" >&2; exit 1; }
    pid=$(sshpw_mux_pid "$p")
    [ -n "$pid" ] || { echo "FAILED: the master does not answer on $p; no shared connection is open (look for a leftover ssh process with ps)" >&2; exit 1; }
    u=$(( $(date +%s) + m * 60 ))
    ( umask 077; printf '%s %s\n' "$u" "$pid" > "$p.until" ) || { ssh -o ControlPath="$p" -O exit "$SSHPW_TARGET" >/dev/null 2>&1 || true; echo "FAILED: cannot record the end time; the master was closed" >&2; exit 1; }
    watchdog "$p" "$pid" </dev/null >/dev/null 2>&1 &
    echo "shared connection open until $(sshpw_hhmm "$u")";;
  status)
    sshpw_load_local_env || exit 3
    if sshpw_mux_alive quiet; then echo "open until $(sshpw_hhmm "$SSHPW_MUX_UNTIL")"; exit 0; fi
    echo "closed"; exit 1;;
  close)
    # Every master in the directory ends (normally one); the login from local.env only names ssh's destination.
    sshpw_load_local_env 2>/dev/null || true
    d=$(sshpw_mux_dir)
    if [ ! -e "$d" ] && [ ! -L "$d" ]; then echo "no shared connection open"; exit 0; fi
    sshpw_mux_dir_ok || { echo "refusing: $d is not a private directory of this user (0700, not a link): left alone" >&2; exit 3; }
    n=0
    for s in "$d"/*; do
      [ -S "$s" ] || continue
      if ssh -o ControlPath="$s" -O exit "${SSHPW_TARGET:-ddc-sshmux}" >/dev/null 2>&1; then n=$((n + 1)); fi
    done
    rm -rf -- "$d"
    if [ "$n" -gt 0 ]; then echo "shared connection closed"; else echo "no shared connection open (its directory removed)"; fi;;
  *) usage;;
esac
