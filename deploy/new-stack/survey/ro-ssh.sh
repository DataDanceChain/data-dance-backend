#!/usr/bin/env bash
# Run a READ-ONLY script on the production server and save its output.
# Usage: ro-ssh.sh <local-script.sh> <output-file>
# The server login (DDC_SSH_TARGET) and the 1Password reference (DDC_OP_SECRET_REF) come from deploy/new-stack/local.env
# (untracked; copy local.env.example). The password is read from 1Password at login and never printed. The script you
# pass must be read-only.
set -u
[ $# -eq 2 ] || { echo "usage: $0 <local-script.sh> <output-file>"; exit 2; }
# Login safety (deploy/new-stack/sshpw.sh): local.env and 1Password are checked BEFORE ssh starts and nothing connects
# if either fails; nothing connects either when the askpass file cannot be created completely; the askpass kills ssh
# instead of letting it send an empty password; password method only; NumberOfPasswordPrompts=1.
# shellcheck source=../sshpw.sh
. "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/../sshpw.sh"
sshpw_precheck || { echo "ro-ssh exit=3 (not connected)"; exit 3; }
A=$(mktemp "${TMPDIR:-/tmp}/askpass.XXXXXX") && sshpw_make_askpass "$A" || { rm -f "${A:-}"; echo "ro-ssh exit=3 (askpass not created; not connected)"; exit 3; }
SSH_ASKPASS="$A" SSH_ASKPASS_REQUIRE=force DISPLAY=none timeout "${RO_SSH_TIMEOUT:-300}" \
  ssh "${SSHPW_OPTS[@]}" "$SSHPW_TARGET" 'bash -s' < "$1" > "$2" 2>&1
rc=$?; rm -f "$A"; echo "ro-ssh exit=$rc"; exit $rc
