#!/usr/bin/env bash
# env-api-cases.sh <package dir> - 40-up.sh step 1b's api env writer and check (common.sh env_api_write,
# env_api_matches_rehearsal) on SYNTHETIC rehearsal files (dummy names and values). The suite runs it on macOS (BSD sed,
# bash 3.2) and in ubuntu:jammy (GNU sed and grep, mawk, bash 5.1), the server's tools. Prints one PASS or FAIL line per
# case and exits 1 on any FAIL. Writes only under its own mktemp directory.
set -euo pipefail
PKG="$1"
W=$(mktemp -d "${TMPDIR:-/tmp}/env-api-cases.XXXXXX"); trap 'rm -rf "$W"' EXIT
fails=0; ok() { echo "PASS $*"; }; bad() { echo "FAIL $*"; fails=$((fails + 1)); }
PINS="$(printf 'A%.0s' $(seq 1 43)),$(printf 'b%.0s' $(seq 1 43))"
write() { ( . "$PKG/common.sh"; env_api_write "$1" "$2" "ddcnew/backend:localtest" "$PINS" ) > "$W/write.out" 2>&1; }
check() { ( . "$PKG/common.sh"; env_api_matches_rehearsal "$1" "$2" ) > /dev/null 2>&1; }

# A rehearsal file of the shape 20-env.sh writes: comments, blank lines, quoted values, an export prefix, the pins line.
cat > "$W/rehearsal" <<'EOF'
# rehearsal env (synthetic)
NODE_ENV=production
export DUMMY_EXPORTED=1
QUOTED_VALUE="a b c"

WEB3AUTH_JWKS_PINNED_THUMBPRINTS="old-pin-1,old-pin-2"
LAST_NAME=last
EOF

# 1. The writer's own output passes the check (the pins line replaced, one comment and one pins line appended).
if write "$W/rehearsal" "$W/api" && check "$W/api" "$W/rehearsal" \
   && [ "$(grep -c '^WEB3AUTH_JWKS_PINNED_THUMBPRINTS=' "$W/api")" = 1 ] && grep -qF "WEB3AUTH_JWKS_PINNED_THUMBPRINTS=\"$PINS\"" "$W/api" \
   && ! grep -q 'old-pin' "$W/api"; then
  ok "env_api_write's output passes env_api_matches_rehearsal: the configured pins line replaced by the new one, nothing else changed"
else cat "$W/write.out"; bad "writer output refused, or its pins line is not the new one"; fi

# 2. A missing, empty, comment-only or pins-only rehearsal file: the writer stops (FAIL, nothing written) and the check
#    refuses (before the fix: the writer wrote only the comment and pins lines and the check accepted that).
: > "$W/empty"
printf '# only a comment\n\n   \n' > "$W/comments"
printf 'WEB3AUTH_JWKS_PINNED_THUMBPRINTS="x"\n' > "$W/pinsonly"
printf '\n# 40-up.sh: Web3Auth JWKS pins computed in ddcnew/backend:localtest (runbook 5.0)\nWEB3AUTH_JWKS_PINNED_THUMBPRINTS="%s"\n' "$PINS" > "$W/pinsonly-api"
r=""
for c in missing empty comments pinsonly; do
  rm -f "$W/out-$c"
  if write "$W/$c" "$W/out-$c"; then r="$r $c:written"
  elif ! grep -q '^FAIL .* is missing, unreadable, empty or has no NAME=value line besides the pins' "$W/write.out"; then r="$r $c:no-FAIL-line"
  elif [ -e "$W/out-$c" ]; then r="$r $c:output-left"; fi
  # the check, given the writer's output for the good file as API and this file as REHEARSAL
  if check "$W/api" "$W/$c"; then r="$r $c:check-accepted"; fi
  # the check, given what the writer used to write from such a file (only its comment and pins lines) as API
  if check "$W/pinsonly-api" "$W/$c"; then r="$r $c:pins-only-api-accepted"; fi
  # the check, given this file as API (only when it exists) against the good rehearsal
  if [ -e "$W/$c" ] && check "$W/$c" "$W/rehearsal"; then r="$r $c:accepted-as-api"; fi
done
if [ -z "$r" ]; then ok "a missing, empty, comment-only or pins-only .env.rehearsal: env_api_write stops with a FAIL and writes nothing; env_api_matches_rehearsal refuses it"
else bad "missing/empty rehearsal cases:$r"; fi

# 3. A missing or empty API file is refused.
: > "$W/api-empty"
if ! check "$W/api-missing" "$W/rehearsal" && ! check "$W/api-empty" "$W/rehearsal"; then ok "a missing or empty .env.api.new is refused"
else bad "a missing or empty .env.api.new was accepted"; fi

# 4. An unreadable rehearsal file (only as a non-root user: root reads it anyway).
if [ "$(id -u)" != 0 ]; then
  cp "$W/rehearsal" "$W/noread"; chmod 000 "$W/noread"
  if ! write "$W/noread" "$W/out-noread" && [ ! -e "$W/out-noread" ] && ! check "$W/api" "$W/noread"; then ok "an unreadable .env.rehearsal: the writer stops, the check refuses"
  else bad "an unreadable .env.rehearsal was used"; fi
  chmod 600 "$W/noread"
fi

# 5. Any other difference is refused: a missing line, an extra name, a changed value, a whitespace-only line, a CRLF line.
r=""
grep -v '^LAST_NAME=' "$W/api" > "$W/d-missing"
{ cat "$W/api"; echo 'EXTRA_NAME=1'; } > "$W/d-extra"
sed 's/^NODE_ENV=production$/NODE_ENV=development/' "$W/api" > "$W/d-changed"
{ cat "$W/api"; printf '   \n'; } > "$W/d-blankish"
awk '{ if ($0 == "LAST_NAME=last") printf "%s\r\n", $0; else print }' "$W/api" > "$W/d-crlf"
for c in missing extra changed blankish crlf; do
  if check "$W/d-$c" "$W/rehearsal"; then r="$r $c"; fi
done
[ "$(grep -c $'\r' "$W/d-crlf")" = 1 ] || r="$r crlf-fixture"
if [ -z "$r" ]; then ok "a missing line, an extra name, a changed value, a whitespace-only line and a CRLF line are each refused"
else bad "accepted although different:$r"; fi

echo "env-api cases: fails=$fails ($(uname -s), $(sed --version 2>/dev/null | head -n 1 || echo 'BSD sed'), bash $BASH_VERSION)"
[ "$fails" = 0 ]
