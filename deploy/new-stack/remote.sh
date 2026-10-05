#!/usr/bin/env bash
# remote.sh - LOCAL runner (Mac) for the new-stack package. One SSH login per call; the login password is read
# from 1Password at login (SSH_ASKPASS) and never printed. Every call is logged to deploy/new-stack/logs/ (gitignored).
#   ./remote.sh preflight [API_HOST=.. APP_HOST=.. API_PORT=.. WEB_PORT=.. DB_PORT=..]
#                                             read-only: pipes 00-preflight.sh through survey/ro-ssh.sh, with the
#                                             settings (common.sh defaults or these overrides) prepended
#   ./remote.sh pack-web <frontend-sha>       local only: git archive of the pinned frontend commit -> out/ (gitignored)
#   DDC_APPROVED=yes ./remote.sh upload       creates /root/ddcnew/deploy (700); copies the scripts, compose.yaml, partner-info/
#   DDC_APPROVED=yes ./remote.sh upload-web <frontend-sha>   copies out/ddc-frontend-<sha>.tar.gz(+.sha256) to /root/ddcnew/src/
#   DDC_APPROVED=yes ./remote.sh run <script> [args...]      runs /root/ddcnew/deploy/<script> on the server
#   ./remote.sh run p2-disk.sh preview | run p2-disk.sh expand-check | run p1-backup.sh status | run 30-nginx.sh status
#               | run 50-partner-page.sh status   (read-only, no flag needed)
#   op read "op://<vault>/<item>/password" | DDC_APPROVED=yes ./remote.sh run 50-partner-page.sh apply PARTNER_ALLOWED_IP=<ip>
#                                             the page password: piped, forwarded on ssh's stdin, never typed or printed
# The server login (DDC_SSH_TARGET) and the 1Password reference (DDC_OP_SECRET_REF) come from local.env (untracked;
# copy local.env.example). Without a usable local.env nothing connects and 1Password is not asked.
#
# Login safety (sshpw.sh): local.env and `op read` are checked BEFORE ssh starts and nothing connects if either fails;
# nothing connects either when the askpass file cannot be created completely (mktemp or write failure); the askpass
# kills ssh instead of letting it send an empty password; password method only; NumberOfPasswordPrompts=1.
# NAME=value arguments to `run` are environment overrides, accepted only from an allowlist (SERVER_ENV_ALLOWED). The
# rehearsal hosts and ports are among them (API_HOST, APP_HOST, API_PORT, WEB_PORT, DB_PORT; common.sh), and so is
# TAKE_OVER_VHOSTS=yes (30-nginx.sh apply; only after Sloan and Race agree, APPROVAL.md section 9).
# No tty is allocated: Ctrl-C or a dropped connection stops only the LOCAL ssh. The script keeps running on the
# server to its end; its output continues in /root/ddcnew/logs/<ts>-<script>-<pid>.log (write runs; APPROVAL.md section 5).
# stdin: `run` forwards this script's stdin, untouched, to the remote script on ssh's stdin (1Password never reads it:
# sshpw.sh gives op /dev/null). Nothing here prints it; logs/ gets the remote output only. For 50-partner-page.sh apply
# and verify, a terminal on stdin is refused before anything connects: the page password must be piped, not typed.
# CHANGES ON THE SERVER: only what the called script changes (upload/upload-web: the files named above).
# UNDO: upload -> rm -rf /root/ddcnew/deploy ; upload-web -> rm /root/ddcnew/src/ddc-frontend-<sha>.tar.gz*
set -euo pipefail
PKG="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=sshpw.sh
. "$PKG/sshpw.sh"
# The frontend clone: by default next to the backend clone that holds this package (override with FE_REPO=<path>).
FE_REPO="${FE_REPO:-$PKG/../../../data-dance-frontend}"
RO_HELPER="$PKG/survey/ro-ssh.sh"
mkdir -p "$PKG/logs" "$PKG/out"
cmd="${1:-}"; shift || true
TS=$(date +%Y%m%d-%H%M%S)

need_approval() { [ "${DDC_APPROVED:-}" = yes ] || { echo "refusing: this call changes the server; Sloan's approval -> DDC_APPROVED=yes"; exit 2; }; }
rssh() { # rssh <remote command> ; stdin is forwarded
  local a="" rc
  sshpw_precheck || return 3
  a=$(mktemp "${TMPDIR:-/tmp}/askpass.XXXXXX") && sshpw_make_askpass "$a" || { rm -f "$a"; echo "REFUSING TO CONNECT: the askpass file could not be created (TMPDIR=${TMPDIR:-/tmp}); not connected" >&2; return 3; }
  rc=0
  SSH_ASKPASS="$a" SSH_ASKPASS_REQUIRE=force DISPLAY=none \
    ssh "${SSHPW_OPTS[@]}" -o ServerAliveInterval=30 "$SSHPW_TARGET" "$1" || rc=$?
  rm -f "$a"; return $rc
}
# Environment overrides that may reach the server (everything else is refused, including PATH, BASH_ENV, LD_*).
SERVER_ENV_ALLOWED="REHEARSAL_DB REHEARSAL_REDIRECT_URIS REHEARSAL_INITIATE_LOGIN_URI OAUTH_PUBLIC_REGISTRATION W3A_GOOGLE W3A_EMAIL W3A_APPLE W3A_X JWKS_NEW_PINS_VERIFIED BUILD_MEM_FLOOR_MB P1_USERS_MIN PARTNER_ALLOWED_IP API_HOST APP_HOST API_PORT WEB_PORT DB_PORT TAKE_OVER_VHOSTS"
valid_sha() { [[ "$1" =~ ^[0-9a-f]{40}$ ]] || { echo "need a full 40-hex commit id"; exit 2; }; }

case "$cmd" in
  preflight)
    # 00-preflight.sh reports whether the server's keys_fixed/apn_key.p8 is identical to the copy tracked in this
    # repository. The sha256 of that copy (HEAD of this checkout) is computed here on every run and prepended to the
    # piped script as GIT_APN_SHA=...; no hash is stored in the repository. Outside a git checkout it stays empty and
    # the preflight prints "not checked".
    # The settings it checks (free ports, our vhost names, DNS) come from common.sh: its defaults, or the overrides
    # given here (the five settings names only), validated there and prepended as NAME=value lines.
    sv=()
    for a in "$@"; do
      [[ "$a" =~ ^(API_HOST|APP_HOST|API_PORT|WEB_PORT|DB_PORT)=[A-Za-z0-9.-]+$ ]] || { echo "preflight takes only API_HOST=, APP_HOST=, API_PORT=, WEB_PORT=, DB_PORT= (got an unsafe or unknown argument)"; exit 2; }
      sv+=("$a")
    done
    settings=$(env -i PATH="$PATH" ${sv[@]+"${sv[@]}"} bash -c '. "$1/common.sh" && settings_env_lines' _ "$PKG" 2>&1) || { echo "preflight settings refused: $settings"; exit 2; }
    apn_sha=""
    if git -C "$PKG" cat-file -e HEAD:keys_fixed/apn_key.p8 2>/dev/null; then
      apn_sha=$(git -C "$PKG" show HEAD:keys_fixed/apn_key.p8 | shasum -a 256 | cut -c1-64)
    fi
    pf=$(mktemp "${TMPDIR:-/tmp}/ddc-preflight.XXXXXX") || { echo "cannot create a temporary file (TMPDIR=${TMPDIR:-/tmp}); not connected"; exit 3; }
    { printf 'GIT_APN_SHA=%s\n' "$apn_sha"; printf '%s\n' "$settings"; cat "$PKG/00-preflight.sh"; } > "$pf"
    rc=0; bash "$RO_HELPER" "$pf" "$PKG/logs/$TS-00-preflight.txt" || rc=$?
    rm -f "$pf"
    [ "$rc" = 0 ] || exit "$rc"
    cat "$PKG/logs/$TS-00-preflight.txt";;
  pack-web)
    sha="${1:-}"; valid_sha "$sha"
    git -C "$FE_REPO" rev-parse --git-dir >/dev/null 2>&1 || { echo "no frontend clone at $FE_REPO: set FE_REPO=<path to the data-dance-frontend clone>"; exit 2; }
    git -C "$FE_REPO" fetch -q origin
    git -C "$FE_REPO" cat-file -e "$sha^{commit}" || { echo "commit $sha not found in $FE_REPO"; exit 1; }
    echo "branches containing it: $(git -C "$FE_REPO" branch -r --contains "$sha" | tr -d ' ' | tr '\n' ' ')"
    f="$PKG/out/ddc-frontend-$sha.tar.gz"
    git -C "$FE_REPO" archive --format=tar.gz -o "$f" "$sha"
    (cd "$PKG/out" && shasum -a 256 "$(basename "$f")" > "$(basename "$f").sha256")
    echo "packed $(basename "$f") $(( $(stat -f %z "$f")/1024/1024 ))MB sha256=$(cut -c1-16 "$f.sha256")... commit-id=$(gzip -dc "$f" | git get-tar-commit-id)";;
  upload)
    need_approval
    COPYFILE_DISABLE=1 tar --no-mac-metadata --no-xattrs -C "$PKG" -czf - common.sh 00-preflight.sh p1-backup.sh p2-disk.sh 10-build.sh 20-env.sh 30-nginx.sh 40-up.sh 50-partner-page.sh 99-teardown.sh compose.yaml partner-info/index.html \
      | rssh 'install -d -m 700 /root/ddcnew /root/ddcnew/deploy && tar --no-same-owner -xzf - -C /root/ddcnew/deploy && chmod 700 /root/ddcnew/deploy/*.sh && ls -l /root/ddcnew/deploy | tail -n +2 | wc -l | sed "s/^/files=/"' \
      | tee "$PKG/logs/$TS-upload.txt";;
  upload-web)
    need_approval; sha="${1:-}"; valid_sha "$sha"
    f="$PKG/out/ddc-frontend-$sha.tar.gz"; [ -f "$f" ] && [ -f "$f.sha256" ] || { echo "run pack-web first"; exit 1; }
    rssh "install -d -m 700 /root/ddcnew/src && cat > /root/ddcnew/src/ddc-frontend-$sha.tar.gz" < "$f"
    rssh "cat > /root/ddcnew/src/ddc-frontend-$sha.tar.gz.sha256 && cd /root/ddcnew/src && sha256sum -c ddc-frontend-$sha.tar.gz.sha256" < "$f.sha256" | tee "$PKG/logs/$TS-upload-web.txt";;
  run)
    s="${1:-}"; shift || true
    [[ "$s" =~ ^(00-preflight|p1-backup|p2-disk|10-build|20-env|30-nginx|40-up|50-partner-page|99-teardown)\.sh$ ]] || { echo "unknown script $s"; exit 2; }
    case "$s ${1:-}" in "00-preflight.sh "*|"p2-disk.sh preview"|"p2-disk.sh expand-check"|"p1-backup.sh status"|"30-nginx.sh status"|"50-partner-page.sh status") ;; *) need_approval;; esac
    # Read-only modes run without the run lock; an override there only changes what they look at.
    case "$s ${1:-}" in
      "50-partner-page.sh apply"|"50-partner-page.sh verify")
        [ ! -t 0 ] || { echo "refusing: the page password is piped, never typed (a terminal would echo it): op read \"op://<vault>/<item>/password\" | DDC_APPROVED=yes ./remote.sh run $s ${1:-} ..."; exit 2; };;
    esac
    # NAME=value arguments become environment overrides (e.g. REHEARSAL_DB=ddc_rehearsal2), the rest are arguments.
    envs=""; args=""
    for a in "$@"; do
      [[ "$a" =~ ^[A-Za-z0-9._/=:,-]+$ ]] || { echo "unsafe argument"; exit 2; }
      if [[ "$a" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]]; then
        case " $SERVER_ENV_ALLOWED " in *" ${a%%=*} "*) envs="$envs $a";; *) echo "override ${a%%=*} is not allowed on the server (allowed: $SERVER_ENV_ALLOWED)"; exit 2;; esac
      else args="$args $a"; fi
    done
    rssh "cd /root/ddcnew/deploy && env$envs ./$s$args" 2>&1 | tee "$PKG/logs/$TS-${s%.sh}.txt";;
  *) sed -n '2,14p' "$0"; exit 2;;
esac
