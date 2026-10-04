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
  if "$SSHPW_OP_BIN" read "$SSHPW_OP_REF" >/dev/null 2>&1; then return 0; fi
  echo "REFUSING TO CONNECT: 1Password did not return the server password (op read failed: locked, not approved, or timed out). No SSH connection was made, so no failed login reached the server. Approve 1Password, then re-run." >&2
  return 1
}

# The askpass script. The op binary and reference are fixed at write time. Its last line is the sentinel `exit 1`.
sshpw_askpass_text() {
  printf '#!/bin/sh\n'
  printf '# askpass for remote.sh / ro-ssh.sh (sshpw.sh). Never prints anything but the password, and only on success.\n'
  printf 'pw=$(%q read %q 2>/dev/null) && [ -n "$pw" ] && { printf "%%s\\n" "$pw"; exit 0; }\n' "$SSHPW_OP_BIN" "$SSHPW_OP_REF"
  printf 'echo "askpass: 1Password read failed: stopping ssh before it sends a password" >&2\n'
  printf 'case "$(ps -o comm= -p "$PPID" 2>/dev/null)" in\n'
  printf '  ssh|*/ssh) kill -TERM "$PPID" 2>/dev/null; sleep 1; kill -KILL "$PPID" 2>/dev/null;;\n'
  printf '  *) echo "askpass: parent process $PPID is not ssh: not killing it" >&2;;\n'
  printf 'esac\n'
  printf 'exit 1\n'
}

# sshpw_askpass_ok <file>: the file is executable, holds exactly the askpass text and ends with the sentinel.
sshpw_askpass_ok() {
  [ -n "${1:-}" ] && [ -f "$1" ] && [ -x "$1" ] || return 1
  [ "$(tail -n 1 "$1" 2>/dev/null)" = 'exit 1' ] || return 1
  [ "$(cat "$1" 2>/dev/null)" = "$(sshpw_askpass_text)" ] || return 1
}

# sshpw_make_askpass <file>: writes the askpass script (700). Returns non-zero, and the caller must NOT start ssh,
# when no reference is loaded, the name is empty, the write fails (disk full, read-only, missing directory) or the
# result is incomplete.
sshpw_make_askpass() {
  [ -n "$SSHPW_OP_REF" ] || return 1
  [ -n "${1:-}" ] || return 1
  { sshpw_askpass_text; } > "$1" || return 1
  chmod 700 "$1" || return 1
  sshpw_askpass_ok "$1" || return 1
}
