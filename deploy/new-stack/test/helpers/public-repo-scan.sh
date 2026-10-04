#!/usr/bin/env bash
# public-repo-scan.sh <package dir>   (local test helper; reads files only, writes nothing)
# This package lives in a PUBLIC repository. The scan covers every file that is or could be committed: with git, the
# tracked files plus the untracked files that are not ignored (local.env, logs/ and out/ are ignored); without git,
# every file except those. It FAILS when a file contains:
#   ip       an IPv4 address other than loopback (127.x.x.x), 0.0.0.0 or the documentation ranges 192.0.2.x,
#            198.51.100.x and 203.0.113.x (backslashes are removed first, so an escaped regex form counts too)
#   op-ref   a 1Password secret reference with a real vault name (op:// followed by a letter or digit; the tests use
#            the vault name test-vault only)
#   hex64    a run of 64 or more hex digits with 4 or more distinct digits (a hash or a key; obvious test values such
#            as 000...001 have fewer)
#   op-id    a 26-character lowercase token with letters and digits (the shape of a 1Password vault or item id)
#   phrase   a statement about a server's current security state (PHRASES below, case-insensitive; a generic
#            vocabulary of login, file-mode, TLS, CORS, firewall and backup statements, not a list of findings):
#            findings about a real server belong in the private runbook, never in this repository
#   mode     the file mode 644 anywhere but in a chmod command or on the cron.d entry's line
#   local:*  when local.env exists (the operator's Mac): its target, the target's host (for an IPv4 host also its
#            first two and three octets), its 1Password reference, and that reference's vault and item names
# Prints file:line and the rule of every hit, never the matching text (a hit is not copied into any log), then PASS
# or FAIL; exit 1 on FAIL. This file holds the phrase list and the mode rule, so it skips those two rules for itself.
set -u
PKG="$1"
SELF="test/helpers/public-repo-scan.sh"
cd "$PKG" || { echo "FAIL public-repo-scan: no directory $PKG"; exit 1; }
PHRASES='password login
PasswordAuthentication yes
PermitRootLogin yes
root login
default password
world-readable
world readable
world-writable
Flexible
TLS 1.0
reflect
open to everyone
open to all
open to the world
unpatched
no backup
not backed up'

LIST=()
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  how='git'
  while IFS= read -r -d '' f; do [ -f "$f" ] && LIST+=("$f"); done < <(git ls-files -z --cached --others --exclude-standard -- .)
else
  how='find'
  while IFS= read -r -d '' f; do LIST+=("${f#./}"); done < <(find . -type f ! -path './logs/*' ! -path './out/*' ! -name local.env \
    ! \( -name 'local.env.*' ! -name local.env.example \) ! -name .DS_Store -print0)
fi
[ "${#LIST[@]}" -gt 0 ] || { echo "FAIL public-repo-scan: no files found in $PKG"; exit 1; }

# Literal values from local.env (never printed). Read like sshpw.sh reads them: the file is not executed.
LOCAL_VALS=(); LOCAL_KIND=()
addlocal() { [ -n "$2" ] && [ "$2" != CHANGE_ME ] && { LOCAL_KIND+=("$1"); LOCAL_VALS+=("$2"); }; return 0; }
if [ -f local.env ]; then
  # shellcheck source=../../sshpw.sh
  . ./sshpw.sh
  t=$(sshpw_local_value DDC_SSH_TARGET); r=$(sshpw_local_value DDC_OP_SECRET_REF)
  addlocal target "$t"
  case "$t" in *@*)
    h="${t#*@}"; addlocal host "$h"
    if [[ "$h" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      addlocal ipv4-prefix "${h%.*.*}."; addlocal ipv4-prefix "${h%.*}."
    fi;;
  esac
  addlocal op-ref "$r"
  case "$r" in op://*/*/*)
    v="${r#op://}"; vault="${v%%/*}"; rest="${v#*/}"; item="${rest%%/*}"
    case "$vault" in Private|Personal|Shared|Employee) ;; *) [ "${#vault}" -lt 4 ] || addlocal vault "$vault";; esac
    [ "${#item}" -lt 4 ] || addlocal item "$item";;
  esac
fi

hits=0
hit() { echo "FAIL public-repo-scan: $1:$2 [$3]"; hits=$((hits + 1)); }   # <file> <line> <rule>
for f in "${LIST[@]}"; do
  while IFS=: read -r ln ip; do
    case "$ip" in 127.*|0.0.0.0|192.0.2.*|198.51.100.*|203.0.113.*) ;; *) hit "$f" "$ln" ip;; esac
  done < <(sed 's/\\//g' "$f" | grep -noE '([0-9]{1,3}\.){3}[0-9]{1,3}' || true)
  while IFS=: read -r ln _; do hit "$f" "$ln" op-ref; done < <(sed 's#op://test-vault/##g' "$f" | grep -nE 'op://[A-Za-z0-9]' || true)
  while IFS=: read -r ln hx; do
    [ "$(printf '%s' "$hx" | fold -w1 | sort -u | wc -l | tr -d ' ')" -ge 4 ] && hit "$f" "$ln" hex64
  done < <(grep -noE '[0-9a-fA-F]{64,}' "$f" || true)
  while IFS=: read -r ln m; do
    tok=$(printf '%s' "$m" | tr -cd 'a-z0-9')
    case "$tok" in *[0-9]*) case "$tok" in *[a-z]*) hit "$f" "$ln" op-id;; esac;; esac
  done < <(grep -noE '(^|[^A-Za-z0-9])[a-z0-9]{26}([^A-Za-z0-9]|$)' "$f" || true)
  if [ "$f" != "$SELF" ]; then
    while IFS= read -r p; do
      [ -n "$p" ] || continue
      while IFS=: read -r ln _; do hit "$f" "$ln" "phrase: $p"; done < <(grep -niF -- "$p" "$f" || true)
    done <<EOF
$PHRASES
EOF
    while IFS=: read -r ln _; do hit "$f" "$ln" mode; done < <(grep -nE '(^|[^0-9])644([^0-9]|$)' "$f" | grep -vE 'chmod 644 |cron\.d/ddc-pgdump \(644\)' || true)
  fi
  i=0
  while [ "$i" -lt "${#LOCAL_VALS[@]}" ]; do
    case "${LOCAL_KIND[$i]}" in vault|item) gopt=-nwF;; *) gopt=-nF;; esac   # names as whole words, the rest as text
    while IFS=: read -r ln _; do hit "$f" "$ln" "local:${LOCAL_KIND[$i]}"; done < <(grep "$gopt" -- "${LOCAL_VALS[$i]}" "$f" || true)
    i=$((i + 1))
  done
done
if [ "$hits" = 0 ]; then
  echo "PASS public-repo-scan: ${#LIST[@]} files ($how), rules ip, op-ref, hex64, op-id, phrase, mode$([ "${#LOCAL_VALS[@]}" = 0 ] && echo ' (no local.env: no local values)' || echo ", local (${#LOCAL_VALS[@]} values from local.env, not printed)"): no hits"
else
  echo "FAIL public-repo-scan: $hits hit(s) in ${#LIST[@]} files ($how)"
fi
[ "$hits" = 0 ]
