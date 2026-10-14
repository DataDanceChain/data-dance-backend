# shellcheck shell=bash disable=SC2034
# sshpw.sh - LOCAL (Mac) helper for the password SSH logins of remote.sh and survey/ro-ssh.sh.
# Sourced, never uploaded. CHANGES ON THE SERVER: nothing by itself.
#
# Server login and secret: both come from local.env next to this file (untracked and gitignored; copy
# local.env.example). The repository names no host and no 1Password item.
#   DDC_SSH_TARGET     user@host of the server login
#   DDC_OP_SECRET_REF  the 1Password secret reference of that login's password (the password itself is never stored)
# sshpw_precheck refuses, before 1Password is asked and before anything connects, when local.env is missing, when a
# value is empty or still the CHANGE_ME placeholder, or when a value does not have the expected shape.
#
# Why the login is guarded: when the askpass program fails, OpenSSH sends an EMPTY password anyway (read_passphrase
# returns "" when the askpass fails), and a missing or truncated askpass FILE has the same effect. Every such attempt
# is a failed login on the target and counts toward its MaxAuthTries / fail2ban limits. Five layers:
#   1. sshpw_precheck: local.env as above, then `op read` with all output discarded BEFORE ssh starts; on failure
#      nothing connects.
#   2. sshpw_make_askpass fails (non-zero) unless a reference is loaded and the askpass file was written completely:
#      the callers then exit without starting ssh (remote.sh rssh, ro-ssh.sh: mktemp ... && sshpw_make_askpass ... ||
#      exit 3).
#   3. the askpass prints the password only when `op read` succeeded with a non-empty value; otherwise it kills its
#      parent (SIGTERM, then SIGKILL) BEFORE exiting, so ssh never reaches the point of sending a password. It
#      kills the parent only when that parent is ssh.
#   4. NumberOfPasswordPrompts=1 (SSHPW_OPTS): at most one attempt per connection.
#   5. PreferredAuthentications=password only: one method, so one prompt limit applies.
# The password only ever passes from `op` to ssh through the askpass's stdout; it is never printed or stored.
# Both `op read` calls take their stdin from /dev/null: remote.sh forwards its own stdin to the remote script (the
# partner page password, an upload's tarball), and the askpass inherits ssh's stdin, so op must never read it.
#
# Shared connection (sshmux.sh, one 1Password approval per deploy): `sshmux.sh open` reads the password ONCE (its
# precheck), logs in once and leaves an OpenSSH master (ControlMaster) whose socket sits in a private directory
# (sshpw_mux_dir: 0700, this user's, not a link). While that master answers and its end time has not passed
# (sshpw_mux_alive), remote.sh and survey/ro-ssh.sh run every call through it: no `op read`, no askpass, no new login.
# Those calls use ControlMaster=no, ProxyCommand=false and BatchMode=yes (SSHPW_MUX_OPTS), so if the master is gone
# by the time ssh starts, ssh cannot fall back to a direct connection: it exits 255 without opening a TCP connection
# and without sending any password. When no master is usable the callers log in exactly as above (precheck + askpass);
# a master that stopped answering or expired is cleaned up and named on stderr first (sshpw_mux_note). A call that
# fails with 255 through the master is never retried (sshpw_mux_lost says what happened); the next call logs in again.
SSHPW_OP_BIN=/opt/homebrew/bin/op   # fixed; only the local test reassigns it (after sourcing, or in a scratch copy)
SSHPW_LOCAL_ENV="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/local.env"
SSHPW_TARGET=""; SSHPW_OP_REF=""    # set by sshpw_load_local_env, and only when both values pass every check
SSHPW_OPTS=(-o PreferredAuthentications=password -o PubkeyAuthentication=no
            -o StrictHostKeyChecking=yes -o ConnectTimeout=20 -o NumberOfPasswordPrompts=1)

# sshpw_local_value <NAME>: NAME's value in local.env (last assignment wins; surrounding blanks and one pair of
# quotes removed). The file is only read, never sourced or executed.
sshpw_local_value() {
  local line v
  line=$(grep -E "^[[:space:]]*(export[[:space:]]+)?$1[[:space:]]*=" "$SSHPW_LOCAL_ENV" 2>/dev/null | tail -n 1) || true
  v="${line#*=}"
  v="${v#"${v%%[![:space:]]*}"}"; v="${v%"${v##*[![:space:]]}"}"
  case "$v" in \"*\") v="${v#\"}"; v="${v%\"}";; \'*\') v="${v#\'}"; v="${v%\'}";; esac
  printf '%s' "$v"
}

# sshpw_load_local_env: sets SSHPW_TARGET and SSHPW_OP_REF from local.env, or prints why not (stderr; it never
# prints a value from the file) and returns 1. The target must be user@host (so it can never be read as an ssh
# option) and the reference a 1Password secret reference (so a pasted password is refused, not passed to `op`).
sshpw_load_local_env() {
  local t r why="" re_target='^[a-z_][a-z0-9_.-]*@[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$' re_ref='^op://[^/[:space:]]+/[^/[:space:]]+/[^[:space:]]+$'
  SSHPW_TARGET=""; SSHPW_OP_REF=""
  if [ ! -f "$SSHPW_LOCAL_ENV" ]; then
    why="$SSHPW_LOCAL_ENV does not exist (copy local.env.example to local.env and fill in both values from the private runbook)"
  else
    t=$(sshpw_local_value DDC_SSH_TARGET); r=$(sshpw_local_value DDC_OP_SECRET_REF)
    if [ -z "$t" ] || [ -z "$r" ]; then why="DDC_SSH_TARGET or DDC_OP_SECRET_REF is empty or missing in $SSHPW_LOCAL_ENV"
    elif [[ "$t$r" == *CHANGE_ME* ]]; then why="$SSHPW_LOCAL_ENV still has the CHANGE_ME placeholder values (fill in both from the private runbook)"
    elif ! [[ "$t" =~ $re_target ]]; then why="DDC_SSH_TARGET in $SSHPW_LOCAL_ENV is not of the form user@host"
    elif ! [[ "$r" =~ $re_ref ]]; then why="DDC_OP_SECRET_REF in $SSHPW_LOCAL_ENV is not a 1Password secret reference (op://<vault>/<item>/<field>)"
    fi
  fi
  if [ -n "$why" ]; then
    echo "REFUSING TO CONNECT: $why. 1Password was not asked and no SSH connection was made." >&2
    return 1
  fi
  SSHPW_TARGET="$t"; SSHPW_OP_REF="$r"
}

# Abort before connecting when local.env is not usable or 1Password does not answer now. Prints nothing secret.
sshpw_precheck() {
  sshpw_load_local_env || return 1
  if "$SSHPW_OP_BIN" read "$SSHPW_OP_REF" >/dev/null 2>&1 </dev/null; then return 0; fi
  echo "REFUSING TO CONNECT: 1Password did not return the server password (op read failed: locked, not approved, or timed out). No SSH connection was made, so no failed login reached the server. Approve 1Password, then re-run." >&2
  return 1
}

# The askpass script. The op binary and reference are fixed at write time. Its last line is the sentinel `exit 1`.
# sshpw_askpass_text [stdin]: with `stdin` (sshmux.sh open only) it does not call op: it prints the one line on its
# stdin, which is ssh's stdin, where sshmux.sh pipes the password its precheck read; same kill rule when that is empty.
sshpw_askpass_text() {
  printf '#!/bin/sh\n'
  if [ "${1:-}" = stdin ]; then
    printf '# askpass for sshmux.sh open (sshpw.sh). Never prints anything but the one line on its stdin, and only when it is not empty.\n'
    printf 'IFS= read -r pw && [ -n "$pw" ] && { printf "%%s\\n" "$pw"; exit 0; }\n'
    printf 'echo "askpass: no password on stdin: stopping ssh before it sends a password" >&2\n'
  else
    printf '# askpass for remote.sh / ro-ssh.sh (sshpw.sh). Never prints anything but the password, and only on success.\n'
    printf 'pw=$(%q read %q 2>/dev/null </dev/null) && [ -n "$pw" ] && { printf "%%s\\n" "$pw"; exit 0; }\n' "$SSHPW_OP_BIN" "$SSHPW_OP_REF"
    printf 'echo "askpass: 1Password read failed: stopping ssh before it sends a password" >&2\n'
  fi
  printf 'case "$(ps -o comm= -p "$PPID" 2>/dev/null)" in\n'
  printf '  ssh|*/ssh) kill -TERM "$PPID" 2>/dev/null; sleep 1; kill -KILL "$PPID" 2>/dev/null;;\n'
  printf '  *) echo "askpass: parent process $PPID is not ssh: not killing it" >&2;;\n'
  printf 'esac\n'
  printf 'exit 1\n'
}

# sshpw_askpass_ok <file> [stdin]: the file is executable, holds exactly the askpass text and ends with the sentinel.
sshpw_askpass_ok() {
  [ -n "${1:-}" ] && [ -f "$1" ] && [ -x "$1" ] || return 1
  [ "$(tail -n 1 "$1" 2>/dev/null)" = 'exit 1' ] || return 1
  [ "$(cat "$1" 2>/dev/null)" = "$(sshpw_askpass_text "${2:-}")" ] || return 1
}

# sshpw_make_askpass <file> [stdin]: writes the askpass script (700). Returns non-zero, and the caller must NOT start
# ssh, when no reference is loaded, the name is empty, the write fails (disk full, read-only, missing directory) or
# the result is incomplete.
sshpw_make_askpass() {
  [ -n "$SSHPW_OP_REF" ] || return 1
  [ -n "${1:-}" ] || return 1
  { sshpw_askpass_text "${2:-}"; } > "$1" || return 1
  chmod 700 "$1" || return 1
  sshpw_askpass_ok "$1" "${2:-}" || return 1
}

# ---- Shared connection (sshmux.sh; see the header) ----------------------------------------------------------------
SSHPW_MUX_OPTS=(); SSHPW_MUX_UNTIL=""   # set by sshpw_mux_alive, and only when it returns 0

# sshpw_mux_dir: ${TMPDIR:-/tmp}/ddc-sshmux-<uid>. sshmux.sh creates it 0700; nothing else is ever written there.
sshpw_mux_dir() { local t="${TMPDIR:-/tmp}"; printf '%s/ddc-sshmux-%s' "${t%/}" "$(id -u)"; }

# sshpw_mux_path: the master's socket for this login: 12 hex characters of sha256(target and SSHPW_OPTS), so a
# different login (another target, port or option set) never finds this socket.
sshpw_mux_path() {
  printf '%s/%s' "$(sshpw_mux_dir)" "$(printf '%s\n' "$SSHPW_TARGET" "${SSHPW_OPTS[@]}" | shasum -a 256 | cut -c1-12)"
}

# sshpw_mux_path_check: the socket path is safe for ssh: only [A-Za-z0-9/._-] (ssh expands % and ~ in a ControlPath,
# and a blank would split the option) and at most 86 characters (a Unix socket name has 103 on macOS, and ssh first
# binds <path>.<16 random characters>). Prints why not on stderr.
sshpw_mux_path_check() {
  local p; p=$(sshpw_mux_path)
  if ! [[ "$p" =~ ^/[A-Za-z0-9/._-]+$ ]]; then
    echo "REFUSING: the socket path $p has characters ssh would expand or split: set TMPDIR to a plain private directory" >&2; return 1
  fi
  if [ "${#p}" -gt 86 ]; then
    echo "REFUSING: the socket path $p is ${#p} characters, too long for a Unix socket (at most 86 here): set TMPDIR to a shorter private directory" >&2; return 1
  fi
}

# sshpw_mux_dir_ok: the directory is a real directory (not a link), owned by this user, mode 0700 and without an ACL.
sshpw_mux_dir_ok() {
  local d; d=$(sshpw_mux_dir)
  [ -d "$d" ] && [ ! -L "$d" ] && [ -O "$d" ] || return 1
  case "$(ls -ld "$d" 2>/dev/null)" in 'drwx------ '*|'drwx------@ '*) return 0;; esac
  return 1
}

# sshpw_mux_pid <socket>: the pid of the master answering on the socket (`ssh -O check`), or nothing.
sshpw_mux_pid() {
  { ssh -o ControlPath="$1" -O check "${SSHPW_TARGET:-ddc-sshmux}" 2>&1 || true; } | sed -n 's/^Master running (pid=\([0-9][0-9]*\)).*/\1/p'
}

# sshpw_mux_stop <socket>: the master stops taking new calls (`ssh -O stop`: a call running through it finishes, then
# it exits); its end-time record goes.
sshpw_mux_stop() { ssh -o ControlPath="$1" -O stop "${SSHPW_TARGET:-ddc-sshmux}" >/dev/null 2>&1 || true; rm -f "$1.until"; }

# sshpw_hhmm <epoch>: HH:MM local time.
sshpw_hhmm() { date -r "$1" +%H:%M 2>/dev/null || date -d "@$1" +%H:%M; }

# sshpw_mux_note <quiet|""> <why>: the fallback notice (stderr), unless quiet.
sshpw_mux_note() {
  [ "$1" = quiet ] && return 0
  echo "sshmux: $2; this call logs in the usual way (1Password is asked as without sshmux.sh); ./sshmux.sh open shares one login again" >&2
}

# sshpw_mux_alive [quiet]: 0, with SSHPW_MUX_OPTS and SSHPW_MUX_UNTIL set, when this login's master is usable now:
# local.env loads, the directory is private, the socket is this user's, a master answers on it, and the end-time
# record (<socket>.until: "<epoch> <master pid>", written by sshmux.sh open) names that master and lies ahead.
# Never asks 1Password. A master that no longer answers is cleaned up; one past its end time, or without a valid
# record, is stopped (`-O stop`); each with a notice on stderr (none with `quiet`). Nothing set up: 1, silently.
sshpw_mux_alive() {
  local q="${1:-}" d p u="" mp="" pid
  SSHPW_MUX_OPTS=(); SSHPW_MUX_UNTIL=""
  sshpw_load_local_env 2>/dev/null || return 1
  d=$(sshpw_mux_dir); p=$(sshpw_mux_path)
  [ -e "$d" ] || [ -L "$d" ] || return 1
  if ! sshpw_mux_dir_ok; then sshpw_mux_note "$q" "$d is not a private directory of this user (0700, not a link): not used"; return 1; fi
  if [ -f "$d/open.lock" ]; then   # an open still running: its master has no record yet; neither use nor stop it
    read -r mp < "$d/open.lock" || true
    if [[ "$mp" =~ ^[0-9]+$ ]] && kill -0 "$mp" 2>/dev/null; then sshpw_mux_note "$q" "./sshmux.sh open is still running"; return 1; fi
    mp=""
  fi
  [ -e "$p" ] || [ -e "$p.until" ] || return 1
  if [ -f "$p.until" ]; then read -r u mp < "$p.until" || true; fi
  pid=""; if [ -S "$p" ] && [ -O "$p" ]; then pid=$(sshpw_mux_pid "$p"); fi
  if [ -z "$pid" ]; then
    rm -f "$p" "$p.until"; sshpw_mux_note "$q" "the shared connection has ended (its master no longer answers)"; return 1
  fi
  if ! [[ "$u" =~ ^[0-9]+$ ]] || [ "$mp" != "$pid" ]; then
    sshpw_mux_stop "$p"; sshpw_mux_note "$q" "the shared connection has no valid end-time record: stopped"; return 1
  fi
  if [ "$(date +%s)" -ge "$u" ]; then
    sshpw_mux_stop "$p"; sshpw_mux_note "$q" "the shared connection reached its end time $(sshpw_hhmm "$u"): stopped"; return 1
  fi
  SSHPW_MUX_UNTIL="$u"
  SSHPW_MUX_OPTS=(-o ControlMaster=no -o "ControlPath=$p" -o ProxyCommand=false -o BatchMode=yes)
}

# sshpw_mux_lost: after ssh exited 255 on a call through the master. When the master no longer answers, says so:
# the call is not retried (a write script may have started; it runs on to its end on the server).
sshpw_mux_lost() {
  sshpw_mux_alive quiet && return 0   # the master still answers: the 255 is the remote command's own
  echo "sshmux: the shared connection ended during this call (ssh exit 255): the remote command may not have started, or its output was cut off; nothing was retried. A write script keeps running on the server and logs to /root/ddcnew/logs/. The next call logs in the usual way (1Password is asked again), or ./sshmux.sh open shares one login again." >&2
}
