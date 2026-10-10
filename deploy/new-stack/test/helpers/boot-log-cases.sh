#!/usr/bin/env bash
# boot-log-cases.sh <package dir> - 40-up.sh step 5 on SYNTHETIC api logs (dummy values only), every call under
# set -euo pipefail as in 40-up.sh:
#   common.sh api_boot_check: an api that stopped before its 'Partner SSO enabled|disabled' line, or before the
#   money-path line, ends with a FAIL line (never a silent exit) and a log tail without secret-looking values;
#   money_path_fields_check, old_app_line_check and server_name_users (the server-name clash check) on inputs larger than
#   a pipe buffer, with the wanted field early: a field that is there is always found (a `printf | grep -q` under pipefail
#   reported it missing).
# Prints one PASS or FAIL line per case and exits 1 on any FAIL. Writes only under its own mktemp directory.
set -euo pipefail
PKG="$1"
W=$(mktemp -d "${TMPDIR:-/tmp}/boot-log-cases.XXXXXX"); trap 'rm -rf "$W"' EXIT
fails=0; ok() { echo "PASS $*"; }; bad() { echo "FAIL $*"; fails=$((fails + 1)); }
API=api-boot.datadance.ai; APP=app-boot.datadance.ai
# <function> <args...>: runs it as 40-up.sh does (sourced common.sh, set -euo pipefail); output in $W/out, rc in RC.
run() { set +e; ( set -euo pipefail; API_HOST=$API; APP_HOST=$APP; . "$PKG/common.sh"; "$@"; echo "RETURNED API_MONEY_PATH_LINE=${API_MONEY_PATH_LINE:-}" ) > "$W/out" 2>&1; RC=$?; set -e; }

# Dummy secret-looking values: none of them may ever be printed.
SECRETS=(
  'postgresql://dummyuser:dummypass@db:5432/ddc_rehearsal'
  'https://dummyuser:dummypw@example.invalid/x'
  'dummy-password-hunter2'
  'Zm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFy'
  'dummy-session-secret-value'
  'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC'
)
CRASH="api-1  | /app/src/constants/partnerClient.js:120
api-1  |     throw new Error(problems.join('\\n'));
api-1  | Error: Partner (TGE) SSO configuration is invalid:
api-1  |  - SSO_TGE_CLIENT_SECRET_SHA256 must be the 64-hex sha256 of the client secret
api-1  |  - SSO_REDIRECT_URIS has 0 entries
api-1  |  - EXTRA_PASSWORD=${SECRETS[2]}
api-1  |     at assertPartnerConfig (/app/src/constants/partnerClient.js:120:11)
api-1  | DATABASE_URL=${SECRETS[0]}
api-1  | fetching ${SECRETS[1]} failed
api-1  | ADMIN_PASSWORD: ${SECRETS[2]}
api-1  | Authorization: Bearer ${SECRETS[3]}
api-1  | SSO_SESSION_SECRET=${SECRETS[4]}
api-1  | -----BEGIN PRIVATE KEY-----
api-1  | ${SECRETS[5]}
api-1  | -----END PRIVATE KEY-----
api-1  | opaque value ${SECRETS[3]} in a message
api-1  | Node.js v22.23.3"
leaked() { local s; for s in "${SECRETS[@]}"; do if grep -qF -- "$s" "$W/out"; then echo "$s"; fi; done; }

# 1. The api stopped before 'Partner SSO enabled|disabled': FAIL with the filtered tail, no secret-looking value.
run api_boot_check "$CRASH"
if [ "$RC" = 1 ] && grep -q "^FAIL the api did not boot: its log has no 'Partner SSO enabled|disabled' line" "$W/out" \
   && grep -qF 'Error: Partner (TGE) SSO configuration is invalid:' "$W/out" \
   && grep -qxF ' - SSO_TGE_CLIENT_SECRET_SHA256 must be the 64-hex sha256 of the client secret' "$W/out" && grep -qxF ' - SSO_REDIRECT_URIS has 0 entries' "$W/out" \
   && grep -qF 'at assertPartnerConfig (/app/src/constants/partnerClient.js:120:11)' "$W/out" \
   && grep -qF 'opaque value <long value removed> in a message' "$W/out" && grep -qF 'Node.js v22.23.3' "$W/out" \
   && ! grep -q '^RETURNED' "$W/out" && [ -z "$(leaked)" ]; then
  ok "api_boot_check: an api that stopped before its 'Partner SSO enabled|disabled' line ends with a FAIL line and the log tail (error and stack lines and the backend's ' - SSO_...' problem list kept; no postgres URL, URL with credentials, password, bearer token, secret, PEM key or long value)"
else cat "$W/out"; bad "api_boot_check on a crash log (rc=$RC, leaked: $(leaked | tr '\n' ' '))"; fi

# 2. An empty log (nothing at all since the start): still a FAIL line, not a silent exit.
run api_boot_check ""
if [ "$RC" = 1 ] && grep -q "^FAIL the api did not boot" "$W/out"; then ok "api_boot_check: an empty api log ends with the same FAIL line"
else cat "$W/out"; bad "api_boot_check on an empty log (rc=$RC)"; fi

# 3. 'Partner SSO enabled' but no money-path line, no error line and no ' - NAME' line (each diagnostic grep finds
#    nothing): FAIL line, not a silent exit (before: errexit ended the script inside the diagnostics).
run api_boot_check "api-1  | Partner SSO enabled [tge] client=lt-partner-client redirectUris=1
api-1  | listening on 3000"
if [ "$RC" = 1 ] && grep -q '^FAIL no money-path assertion line in the api log' "$W/out" && grep -q '^Partner SSO enabled \[tge\]' "$W/out"; then
  ok "api_boot_check: 'Partner SSO enabled' without the money-path line (and no error or env-name line to show) ends with its FAIL line"
else cat "$W/out"; bad "api_boot_check without a money-path line (rc=$RC)"; fi

# 4. A good boot: both lines printed, API_MONEY_PATH_LINE set, and its fields pass.
MP="Partner SSO money-path assertions OK: nodeEnv=production web3authVerify=enforce legacyFallback=false allowedVerifiers=5 jwksPinMode=enforce jwksPins=2 sessionSecretSeparate=true issuer=https://$API consentOrigin=https://$APP publicClientRegistration=closed developerRegistration=closed"
run api_boot_check "api-1  | Partner SSO enabled [tge] client=lt-partner-client
api-1  | $MP"
if [ "$RC" = 0 ] && grep -qxF "RETURNED API_MONEY_PATH_LINE=$MP" "$W/out" && grep -q "^PASS startup log has 'Partner SSO money-path assertions OK'" "$W/out"; then
  run money_path_fields_check "$MP" 2
  [ "$RC" = 0 ] && [ "$(grep -c '^PASS log: ' "$W/out")" = 10 ] && ok "api_boot_check on a good boot: sets API_MONEY_PATH_LINE, whose fields pass money_path_fields_check" \
    || { cat "$W/out"; bad "money_path_fields_check on the good line (rc=$RC)"; }
else cat "$W/out"; bad "api_boot_check on a good boot (rc=$RC)"; fi

# 5. The field checks on inputs larger than a pipe buffer (64 KiB), the wanted fields first: every field is found.
FILLER=$(awk 'BEGIN { for (i = 0; i < 30000; i++) printf " filler%d=x", i }')
run money_path_fields_check "$MP$FILLER" 2
r5="money_path:$RC"
OLDAPP="api-1  | Old App update answer (426 APP_UPDATE_REQUIRED): WEB3AUTH_RETIRED_CLIENT_IDS count=1 first8=abcdefgh LOGIN_MISSING_IDTOKEN_MEANS_OLD_APP=on$FILLER"
run old_app_line_check "$OLDAPP" abcdefgh 1
r5="$r5 old_app:$RC"
mkdir -p "$W/enabled" "$W/avail" "$W/confd"
{ printf 'server {\n    server_name %s' "$API"; awk 'BEGIN { for (i = 0; i < 30000; i++) printf " filler%d.example.invalid", i }'; printf ';\n}\n'; } > "$W/enabled/other"
users=$( ( set -euo pipefail; NGINX_ENABLED="$W/enabled"; NGINX_AVAIL="$W/avail"; NGINX_CONFD="$W/confd"; . "$PKG/common.sh"; server_name_users "$API" ) 2>&1 || true)
r5="$r5 server_name_users:[$(basename "${users:-none}")]"
if [ "$r5" = "money_path:0 old_app:0 server_name_users:[other]" ]; then
  ok "money_path_fields_check, old_app_line_check and the server-name clash check find a field that is there in inputs larger than a pipe buffer (here-strings, no printf | grep -q under pipefail)"
else bad "a field that is there was reported missing: $r5"; fi

echo "boot-log cases: fails=$fails ($(uname -s), bash $BASH_VERSION)"
[ "$fails" = 0 ]
