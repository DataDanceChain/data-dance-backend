#!/usr/bin/env bash
# 20-env.sh - build /root/ddcnew/.env.rehearsal and /root/ddcnew/.env.db from the old backend.env
# (runbook section 5: 5.0 rehearsal column, 5.1 Web3Auth, 5.2 TGE SSO, 5.3 web build is in 10-build.sh).
#
# CHANGES ON THE SERVER
#   /root/ddcnew/secrets/ (700) with 4 files (600), generated ONCE with openssl rand -hex 32 and reused on re-runs:
#     db_password, jwt_secret_rehearsal, sso_session_secret_rehearsal,
#     tge_rehearsal_client_secret  (plaintext of the rehearsal TGE client secret; only its sha256 goes into the env)
#   /root/ddcnew/.env.rehearsal (600)  regenerated from /root/ddc-backend/backend.env (read only) on every run;
#                                      a differing previous version is kept as .env.rehearsal.prev (600)
#   /root/ddcnew/.env.db (600)         POSTGRES_USER / POSTGRES_PASSWORD / POSTGRES_DB for the new Postgres
#   /root/ddcnew/.lock, /root/ddcnew/logs/<ts>-20-env-<pid>.log (600)   run lock and output copy (names and hashes only)
# UNDO
#   rm -f /root/ddcnew/.env.rehearsal /root/ddcnew/.env.rehearsal.prev /root/ddcnew/.env.db
#   rm -rf /root/ddcnew/secrets   (only before pgdata/ is initialised: the db password lives in pgdata afterwards)
#
# REHEARSAL CREDENTIAL POLICY (Sloan, 2026-10-04, financial-grade; backend origin/main 47e6f74 read for each one)
#   REMOVED  every name containing PRIVATE_KEY/PRIVATEKEY/PRIVKEY/MNEMONIC/SEED/SECRET_PHRASE/KEYSTORE or a PK token (BACKEND_WALLET_PRIVATE_KEY, CHAIN_SIGNER_PRIVATE_KEY,
#            BSC_PAYOUT_PRIVATE_KEY, GOOGLE_WALLET_PRIVATE_KEY, ...): the rehearsal cannot sign a chain transaction
#            with the production wallet or take a nonce from it. Commerce attestations stay `pending` (expected):
#            src/utils/commerceAttestChain.js returns pending when no wallet is configured; the boot only warns
#            (src/server.js warnIfChainSignerUnavailable).
#   BLANKED  third-party credentials that could send something real to real users or spend production quota:
#            SMTP_*, X_CLIENT_ID / X_CLIENT_SECRET / X_BEARER_TOKEN / X_OAUTH_ACCESS_TOKEN*, GOOGLE_WALLET_*,
#            GEMINI_API_KEY, MAPBOX/REACT_APP_MAPBOX tokens, SEESAW_DISBURSEMENT_API_KEY, DISBURSEMENT_PARTNER_KEYS.
#   KEPT     APNS_KEY_ID / APNS_TEAM_ID (the apn.Provider built at load throws without them, so the api would not
#            boot; 10-build.sh pairs them with a THROWAWAY apn_key.p8, so Apple rejects every push), PASS_TYPE_ID,
#            OPS_ADMIN_* (own-stack admin login; tokens are signed with the rehearsal's own JWT_SECRET).
#   FAIL-CLOSED  EVERY name that still has a value must be set by this script, in KEEP_W3A, in CRED_ALLOWED or in
#            KEPT_PLAIN (today's known non-secret names); any other name stops the script (name printed, never the
#            value). Every copied value is also refused if it carries user:password@ in a URL, a PEM key block or a
#            bare 32-byte hex key, whatever its name (round 2 review: HOT_WALLET_PRIVATEKEY, DEPLOYER_PK, APIKEY,
#            OSS_ACCESSKEYSECRET, REDIS_URL with a password, SENTRY_DSN, SLACK_WEBHOOK_URL used to slip through).
# OLD-STACK INTEGRITY: containers and old files are fingerprinted at start and end (common.sh old_snapshot_*).
#
# Prints: parse statistics, the variable-NAME diff against the old file, the names it set, the db_target line and
# sha256 comparisons (match/differ). Never a value. Multi-line quoted values, comments, blank lines, duplicate
# names and `export` prefixes in the old file are handled; values that are kept are copied byte for byte.
#
# Overridable for round 2 or once the partner sends its test site (defaults in brackets):
#   REHEARSAL_DB [ddc_rehearsal]
#   REHEARSAL_REDIRECT_URIS [https://tge-rehearsal.invalid/oauth/callback]  (.invalid never resolves: boot-valid placeholder)
#   REHEARSAL_INITIATE_LOGIN_URI [empty -> /api/sso/* answer client_disabled]
#   OAUTH_PUBLIC_REGISTRATION [false]  (runbook 5.2: recommended, Sloan to confirm)
#   W3A_GOOGLE / W3A_EMAIL / W3A_APPLE / W3A_X  mainnet connection names (only Google is documented; the
#                                              other three are confirmed from real tokens at rehearsal A step 6)
# Local test only (DDC_LOCAL_TEST=1): OLD_ENV, NEW_DIR, FE_ENV_TGE may point at synthetic files outside /root.
set -euo pipefail
HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
. "$HERE/common.sh"
require_server

FE_ENV_TGE="${FE_ENV_TGE:-$NEW_DIR/src/frontend-current/.env.tge}"
REHEARSAL_DB="${REHEARSAL_DB:-ddc_rehearsal}"
REHEARSAL_REDIRECT_URIS="${REHEARSAL_REDIRECT_URIS:-https://tge-rehearsal.invalid/oauth/callback}"
REHEARSAL_INITIATE_LOGIN_URI="${REHEARSAL_INITIATE_LOGIN_URI:-}"
OAUTH_PUBLIC_REGISTRATION="${OAUTH_PUBLIC_REGISTRATION:-false}"
W3A_GOOGLE="${W3A_GOOGLE:-web3auth-google-sapphire-mainnet}"
W3A_EMAIL="${W3A_EMAIL:-web3auth-auth0-email-passwordless-sapphire-mainnet}"
W3A_APPLE="${W3A_APPLE:-web3auth-auth0-apple-sapphire-mainnet}"
W3A_X="${W3A_X:-web3auth-auth0-twitter-sapphire-mainnet}"
DB_USER=ddcnew
OUT="$NEW_DIR/.env.rehearsal"
OUT_DB="$NEW_DIR/.env.db"
SEC="$NEW_DIR/secrets"

guard_db_name "$REHEARSAL_DB"
case "$REHEARSAL_DB" in ddc_rehearsal|ddc_rehearsal2) ;; *) die "REHEARSAL_DB must be ddc_rehearsal or ddc_rehearsal2";; esac
for p in "$OUT" "$OUT_DB" "$SEC"; do guard_write_path "$p"; done
run_begin 20-env "$@"
[ -r "$OLD_ENV" ] || die "old env file $OLD_ENV not readable"
[ -r "$FE_ENV_TGE" ] || die "frontend .env.tge not found at $FE_ENV_TGE (10-build.sh unpacks it)"
old_snapshot_begin

# ---------------------------------------------------------------------------
# One parser for every read and the rewrite (mawk, gawk and BSD awk compatible).
#   mode=stats    counts only            mode=names   one name per entry
#   mode=get      raw value of `want` (last occurrence; may span lines)
#   mode=rewrite  old file minus every name in $DDC_SKIP, `export ` dropped, then $DDC_SET appended
#                 as NAME="value" with the value from $DDCV_<NAME> (environment, never argv)
# ---------------------------------------------------------------------------
read -r -d '' AWK_PROG <<'AWK' || true
function closes(s, q,   i, c, bs) {
  bs = 0
  for (i = 1; i <= length(s); i++) {
    c = substr(s, i, 1)
    if (q == "\"" && c == "\\") { bs = !bs; continue }
    if (c == q && !bs) return 1
    bs = 0
  }
  return 0
}
function flush() {
  if (cur == "") return
  if (mode == "names") print cur
  else if (mode == "get" && cur == want) { got = val; have = 1 }
  else if (mode == "rewrite" && !(cur in skip)) printf "%s", buf
  cur = ""; buf = ""; val = ""
}
BEGIN {
  inq = ""; nk = split(ENVIRON["DDC_SKIP"], a, " "); for (i = 1; i <= nk; i++) skip[a[i]] = 1
}
{
  if (inq != "") {
    buf = buf $0 "\n"; val = val "\n" $0; cont++
    if (closes($0, inq)) { inq = ""; flush() }
    next
  }
  if ($0 ~ /^[ \t\r]*$/) { blank++; if (mode == "rewrite") print; next }
  if ($0 ~ /^[ \t]*#/)   { comments++; if (mode == "rewrite") print; next }
  line = $0
  if (line ~ /^[ \t]*export[ \t]+/) { sub(/^[ \t]*export[ \t]+/, "", line); exports++ }
  if (match(line, /^[ \t]*[A-Za-z_][A-Za-z0-9_]*[ \t]*=/)) {
    name = substr(line, RSTART, RLENGTH - 1); gsub(/[ \t]/, "", name)
    v = substr(line, RSTART + RLENGTH); sub(/^[ \t]+/, "", v)
    entries++; seen[name]++
    cur = name; buf = name "=" v "\n"; val = v
    q = substr(v, 1, 1)
    if (q == "\"" || q == sq) {
      quoted++
      if (!closes(substr(v, 2), q)) { inq = q; multiline++; ml = ml " " name; next }
    }
    flush(); next
  }
  unparsed++
}
END {
  if (inq != "") { unterminated = 1; cur = "" }
  flush()
  if (mode == "rewrite") {
    print ""
    print "# ---- ddcnew rehearsal values (written by 20-env.sh; runbook 5.0 / 5.1 / 5.2) ----"
    ns = split(ENVIRON["DDC_SET"], s, " ")
    for (i = 1; i <= ns; i++) printf "%s=\"%s\"\n", s[i], ENVIRON["DDCV_" s[i]]
  }
  if (mode == "get" && have) printf "%s", got
  if (mode == "stats") {
    dups = ""; for (k in seen) if (seen[k] > 1) dups = dups " " k "(" seen[k] ")"
    printf "entries=%d comments=%d blank=%d export_prefixed=%d quoted=%d multiline=%d continuation_lines=%d unparsed=%d unterminated=%d\n", entries, comments, blank, exports, quoted, multiline, cont, unparsed, unterminated
    printf "multiline_names:%s\nduplicate_names:%s\n", ml, dups
  }
}
AWK
envparse() { awk -v mode="$1" -v want="${3:-}" -v sq="'" "$AWK_PROG" "$2"; }
unq() { local v="$1"; case "$v" in \"*\") v="${v#\"}"; v="${v%\"}";; \'*\') v="${v#\'}"; v="${v%\'}";; esac; printf '%s' "$v"; }
getv() { unq "$(envparse get "$1" "$2")"; }
inlist() { case " $2 " in *" $1 "*) return 0;; esac; return 1; }
# Names that hold a private key or a wallet secret: removed from the rehearsal env entirely. Substring match (not
# whole _-tokens), so HOT_WALLET_PRIVATEKEY, SIGNERPRIVKEY or WALLETSEEDPHRASE are caught too; plus a PK token
# (DEPLOYER_PK, PK_HOT).
is_signing_key() {
  [[ "$1" =~ (PRIVATE_?KEY|PRIV_?KEY|MNEMONIC|SEED|SECRET_?PHRASE|KEYSTORE) ]] || [[ "$1" =~ (^|_)PK(_|$) ]]
}
# Every name left in the rehearsal env WITH A VALUE must be in exactly one of these classes, or 20-env.sh stops
# (names only, never values):
#   set by this script (SET_NAMES, includes the BLANKED ones), KEEP_W3A (below), CRED_ALLOWED, KEPT_PLAIN.
# CRED_ALLOWED: credentials the rehearsal keeps on purpose (APPROVAL §2). APNS_KEY_ID / PASS_TYPE_ID are identifiers
# that the boot needs; OPS_ADMIN_* is item J.
CRED_ALLOWED="JWT_SECRET SSO_SESSION_SECRET SSO_TGE_CLIENT_SECRET_SHA256 APNS_KEY_ID PASS_TYPE_ID OPS_ADMIN_PASSWORD OPS_ADMIN_TOKEN_EXPIRES"
# KEPT_PLAIN: the known non-secret names of the old backend.env, copied unchanged.
# A new name in backend.env must be added here (or to a list above) with a reason before the rehearsal is built.
KEPT_PLAIN="APNS_TEAM_ID DDC_CHAIN_ID DDC_CHAIN_RPC_URL DISABLE_REFERRAL_REWARDS_FEATURES GEMINI_DEFAULT_MODEL
  INVOICE_SELLER_ADDRESS JWT_EXPIRES_IN METADATA_BASE_URL NODE_ENV OPS_ADMIN_USERNAME PORT TEST_USER_EMAIL
  X_API_URL X_MAX_REQUESTS_PER_WINDOW X_OAUTH_CALLBACK_URL X_RATE_LIMIT_WINDOW"
KEPT_PLAIN=$(printf '%s' "$KEPT_PLAIN" | tr -s ' \n' '  ')
# A copied value must not carry a credential whatever its name: user:password@ in a URL, a PEM private key, or a
# bare 32-byte hex key (0x optional). Returns the reason (no value) when it does.
value_carries_credential() {
  local v="$1" re_url='://[^/@[:space:]]*@' re_pem='-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----|-----BEGIN [A-Z0-9 ]*KEY-----' \
        re_hex='^[[:space:]]*(0[xX])?[0-9a-fA-F]{64}[[:space:]]*$' re_hex0x='(^|[^0-9A-Za-z])0[xX][0-9a-fA-F]{64}([^0-9a-fA-F]|$)'
  if [[ "$v" =~ $re_url ]]; then printf 'credentials in a URL (user:password@)'
  elif [[ "$v" =~ $re_pem ]]; then printf 'a PEM key block'
  elif [[ "$v" =~ $re_hex ]] || [[ "$v" =~ $re_hex0x ]]; then printf 'a 32-byte hex key'
  else return 1; fi
}

# ---------------------------------------------------------------------------
step "old env file: $OLD_ENV"
stats=$(envparse stats "$OLD_ENV"); say "$stats"
case "$stats" in *"unparsed=0 unterminated=0"*) pass "old file parses cleanly";; *) die "old file has unparsed lines or an unterminated quote; fix by hand first";; esac
OLD_NAMES=$(envparse names "$OLD_ENV" | sort -u | tr '\n' ' ')

# ---------------------------------------------------------------------------
step "secrets (generated on this host, reused on re-runs, never printed)"
install -d -m 700 "$SEC"; umask 077
gen() { if [ ! -s "$SEC/$1" ]; then openssl rand -hex 32 | tr -d '\n' > "$SEC/$1"; say "generated $1"; else say "reused $1"; fi; chmod 600 "$SEC/$1"; }
if [ ! -s "$SEC/db_password" ] && [ -d "$NEW_DIR/pgdata" ] && [ -n "$(ls -A "$NEW_DIR/pgdata" 2>/dev/null)" ]; then
  die "pgdata/ is initialised but secrets/db_password is missing: the database password cannot be regenerated"
fi
for s in db_password jwt_secret_rehearsal sso_session_secret_rehearsal tge_rehearsal_client_secret; do gen "$s"; done
DB_PW=$(cat "$SEC/db_password")
TGE_SECRET_SHA=$(printf '%s' "$(cat "$SEC/tge_rehearsal_client_secret")" | sha256)

W3A_ID=$(getv "$FE_ENV_TGE" VITE_WEB3AUTH_CLIENT_ID)
[[ "$W3A_ID" =~ ^BBpkxUTUr[A-Za-z0-9_-]{20,}$ ]] || die "VITE_WEB3AUTH_CLIENT_ID in $FE_ENV_TGE is not the mainnet id (BBpkxUTUr...)"
[ "$(getv "$FE_ENV_TGE" VITE_WEB3AUTH_NETWORK)" = mainnet ] || die "$FE_ENV_TGE is not a mainnet build file"

# ---------------------------------------------------------------------------
# Values (rehearsal column). Order = output order.
# ---------------------------------------------------------------------------
SET_NAMES=""
setv() { # name value
  local re='^[A-Za-z0-9._,:/@?=&|+ -]*$'
  [[ "$2" =~ $re ]] || die "refusing a value with unsafe characters for $1"
  export "DDCV_$1=$2"; SET_NAMES="$SET_NAMES $1"
}
setv DATABASE_URL "postgresql://$DB_USER:$DB_PW@db:5432/$REHEARSAL_DB?schema=public"
setv PUBLIC_BASE_URL https://tge-api.datadance.ai
setv APP_PUBLIC_URL https://tge-app.datadance.ai
setv FRONTEND_URL https://tge-app.datadance.ai
setv API_BASE_URL https://tge-api.datadance.ai
setv JWT_SECRET "$(cat "$SEC/jwt_secret_rehearsal")"
# 5.1 Web3Auth
setv WEB3AUTH_CLIENT_ID "$W3A_ID"
setv WEB3AUTH_ALLOWED_VERIFIERS "$W3A_GOOGLE,$W3A_EMAIL,$W3A_APPLE,$W3A_X,external-wallet"
setv WEB3AUTH_LEGACY_VERIFIERS ""
setv WEB3AUTH_EXTERNAL_AUDIENCE ""
setv WEB3AUTH_VERIFY_MODE enforce
setv WEB3AUTH_ALLOW_LEGACY_FALLBACK false
setv WEB3AUTH_WALLET_MATCH public_key
setv WEB3AUTH_JWKS_PIN_MODE enforce
setv WEB3AUTH_NETWORK_REBIND on
setv WEB3AUTH_REBIND_VERIFIERS "$W3A_GOOGLE,$W3A_EMAIL,$W3A_APPLE,$W3A_X"
setv WEB3AUTH_EMAIL_TRUSTED_VERIFIERS "$W3A_GOOGLE,$W3A_EMAIL,$W3A_APPLE"
# 5.2 TGE SSO (rehearsal client)
setv SSO_TGE_ENABLED true
setv SSO_ENVIRONMENT prod
setv SSO_TGE_CLIENT_ID tge-rehearsal
setv SSO_TGE_CLIENT_NAME "DDC TGE"
setv SSO_TGE_CLIENT_SECRET_SHA256 "$TGE_SECRET_SHA"
setv SSO_TGE_REDIRECT_URIS "$REHEARSAL_REDIRECT_URIS"
setv SSO_TGE_INITIATE_LOGIN_URI "$REHEARSAL_INITIATE_LOGIN_URI"
setv SSO_SESSION_SECRET "$(cat "$SEC/sso_session_secret_rehearsal")"
setv SSO_TGE_AUTO_APPROVE app,web
setv SSO_TGE_REFERRAL_BIND true
setv SSO_TGE_APP_PRESENTATION webview
setv SSO_TGE_STATUS_FIELDS registered_at,wallet_bound,referral_network,referral
setv SSO_REQUIRE_VERIFIED_SESSION false
setv OAUTH_PUBLIC_REGISTRATION_ENABLED "$OAUTH_PUBLIC_REGISTRATION"
setv DISBURSEMENT_PAUSED true
# 5.0: SMTP_* emptied (no mail from the rehearsal), and every other third-party credential that could reach real
# users (X, Google Wallet) or spend production quota (Gemini, Mapbox) or authenticate a partner (disbursement keys).
BLANKED=""
for n in $OLD_NAMES; do
  case "$n" in
    SMTP_*|GOOGLE_WALLET_*|GEMINI_API_KEY|X_CLIENT_ID|X_CLIENT_SECRET|X_BEARER_TOKEN|X_OAUTH_ACCESS_TOKEN|X_OAUTH_ACCESS_TOKEN_SECRET|\
    MAPBOX_ACCESS_TOKEN|REACT_APP_MAPBOX_TOKEN|SEESAW_DISBURSEMENT_API_KEY|DISBURSEMENT_PARTNER_KEYS)
      is_signing_key "$n" && continue   # removed below instead
      setv "$n" ""; BLANKED="$BLANKED $n";;
  esac
done

# Unchanged (copied from the old file as they are): token verification endpoints, claim paths, JWKS pins.
KEEP_W3A="WEB3AUTH_JWKS_URL WEB3AUTH_ISSUERS WEB3AUTH_EXTERNAL_JWKS_URL WEB3AUTH_EXTERNAL_ISSUERS WEB3AUTH_VERIFIER_CLAIM WEB3AUTH_VERIFIER_ID_CLAIM WEB3AUTH_EMAIL_CLAIM WEB3AUTH_EMAIL_VERIFIED_CLAIM WEB3AUTH_WALLETS_CLAIM WEB3AUTH_JWKS_PINNED_THUMBPRINTS"
DEL_NAMES=""
for n in $OLD_NAMES; do
  inlist "$n" "$SET_NAMES" && continue
  if is_signing_key "$n"; then DEL_NAMES="$DEL_NAMES $n"; continue; fi
  case "$n" in
    SSO_*|WEB3AUTH_*) inlist "$n" "$KEEP_W3A" || DEL_NAMES="$DEL_NAMES $n";;
  esac
done
inlist WEB3AUTH_JWKS_PINNED_THUMBPRINTS "$OLD_NAMES" || warn "old file has no WEB3AUTH_JWKS_PINNED_THUMBPRINTS: 40-up.sh will refuse to start the api, because no configured pin can be matched against what Web3Auth serves"

# ---------------------------------------------------------------------------
step "write $OUT and $OUT_DB"
# The new file is written to $OUT.tmp and every check below runs on that file. Only when all of them pass is it
# installed as $OUT. On ANY failure the temporary file AND a previous $OUT are removed (fail closed: 40-up.sh then
# refuses to start, because a previous file built from the same old env may carry the same problem).
TMP="$OUT.tmp"; CHK="$TMP"; ENV_OK=0
# shellcheck disable=SC2064  # paths are fixed now
trap "if [ \"\$ENV_OK\" != 1 ]; then rm -f '$TMP'; if [ -f '$OUT' ]; then rm -f '$OUT'; printf 'FAIL removed %s: 40-up.sh will refuse to start until 20-env.sh passes\\n' '$OUT' >&2; fi; fi" EXIT
DDC_SKIP="$SET_NAMES $DEL_NAMES" DDC_SET="$SET_NAMES" envparse rewrite "$OLD_ENV" > "$TMP"
chmod 600 "$TMP"
# The values (DATABASE_URL with the db password, JWT/SSO secrets) were exported only for that awk: no later child
# process inherits them.
for n in $SET_NAMES; do unset "DDCV_$n"; done
printf 'POSTGRES_USER=%s\nPOSTGRES_PASSWORD=%s\nPOSTGRES_DB=%s\n' "$DB_USER" "$DB_PW" ddcnew > "$OUT_DB.tmp"
chmod 600 "$OUT_DB.tmp"; mv "$OUT_DB.tmp" "$OUT_DB"
say "modes: $(basename "$TMP")=$(stat -c %a "$TMP" 2>/dev/null || stat -f %Lp "$TMP") $(basename "$OUT_DB")=$(stat -c %a "$OUT_DB" 2>/dev/null || stat -f %Lp "$OUT_DB") secrets/=$(stat -c %a "$SEC" 2>/dev/null || stat -f %Lp "$SEC")"
say "env_file_sha256=$(sha256 < "$TMP" | cut -c1-16)  (same inputs -> same hash on a re-run)"

# ---------------------------------------------------------------------------
step "checks on the new file (still $(basename "$TMP"); installed only if every check passes)"
nstats=$(envparse stats "$CHK"); say "$nstats"
case "$nstats" in *"unparsed=0 unterminated=0"*) pass "new file parses cleanly";; *) die "new file does not parse";; esac
NEW_NAMES=$(envparse names "$CHK" | sort -u | tr '\n' ' ')
say "removed names: $(comm -23 <(printf '%s\n' $OLD_NAMES) <(printf '%s\n' $NEW_NAMES) | tr '\n' ' ')"
say "added names:   $(comm -13 <(printf '%s\n' $OLD_NAMES) <(printf '%s\n' $NEW_NAMES) | tr '\n' ' ')"
say "set names:    $SET_NAMES"
kept=0; same=0
for n in $NEW_NAMES; do
  inlist "$n" "$SET_NAMES" && continue
  kept=$((kept+1))
  [ "$(envparse get "$OLD_ENV" "$n" | sha256)" = "$(envparse get "$CHK" "$n" | sha256)" ] && same=$((same+1))
done
[ "$kept" = "$same" ] && pass "kept names: $kept, values byte-identical to the old file: $same" || die "kept values differ: $same of $kept identical"

U=$(getv "$CHK" DATABASE_URL); hp="${U#*@}"; hp="${hp%%\?*}"; schema="${U##*schema=}"
say "db_target=${hp} schema=${schema}"
[ "db_target=${hp} schema=${schema}" = "db_target=db:5432/$REHEARSAL_DB schema=public" ] && pass "db_target is the new stack's db" || die "db_target is wrong"
upw="${U#postgresql://*:}"; upw="${upw%%@*}"
[ "$(printf '%s' "$upw" | sha256)" = "$(printf '%s' "$(getv "$OUT_DB" POSTGRES_PASSWORD)" | sha256)" ] && pass "sha256(DATABASE_URL password) = sha256(.env.db POSTGRES_PASSWORD)" || die "db password mismatch"
[ "$(getv "$OLD_ENV" JWT_SECRET | sha256)" != "$(getv "$CHK" JWT_SECRET | sha256)" ] && pass "sha256(JWT_SECRET) differs from the old stack (rehearsal must not mint production-valid tokens)" || die "JWT_SECRET equals the old one"
[ "$(getv "$CHK" SSO_SESSION_SECRET | sha256)" != "$(getv "$CHK" JWT_SECRET | sha256)" ] && pass "sha256(SSO_SESSION_SECRET) differs from sha256(JWT_SECRET)" || die "SSO_SESSION_SECRET equals JWT_SECRET"
[ "$(getv "$CHK" SSO_TGE_CLIENT_SECRET_SHA256)" = "$(printf '%s' "$(cat "$SEC/tge_rehearsal_client_secret")" | sha256)" ] && pass "SSO_TGE_CLIENT_SECRET_SHA256 = sha256(secrets/tge_rehearsal_client_secret)" || die "TGE secret hash mismatch"
[ "$(getv "$CHK" WEB3AUTH_CLIENT_ID | sha256)" = "$(printf '%s' "$W3A_ID" | sha256)" ] && pass "WEB3AUTH_CLIENT_ID = frontend .env.tge VITE_WEB3AUTH_CLIENT_ID (prefix $(getv "$CHK" WEB3AUTH_CLIENT_ID | cut -c1-9))" || die "client id mismatch"
say "old WEB3AUTH_CLIENT_ID prefix: $(getv "$OLD_ENV" WEB3AUTH_CLIENT_ID | cut -c1-9)"
c1=$(grep -c '^DISBURSEMENT_PAUSED="true"$' "$CHK" || true); c2=$(grep -cE '^BSC_PAYOUT_PRIVATE_KEY=' "$CHK" || true)
[ "$c1" = 1 ] && [ "$c2" = 0 ] && pass "payouts off: DISBURSEMENT_PAUSED=true count=$c1, BSC_PAYOUT_PRIVATE_KEY count=$c2" || die "payout check failed ($c1/$c2)"
step "rehearsal credential policy (names only)"
left=""; for n in $NEW_NAMES; do is_signing_key "$n" && left="$left $n"; done
[ -z "$left" ] && pass "no private-key / mnemonic name left (removed:$(for n in $DEL_NAMES; do is_signing_key "$n" && printf ' %s' "$n"; done))" || die "signing-key names left in the rehearsal env:$left"
for n in BACKEND_WALLET_PRIVATE_KEY CHAIN_SIGNER_PRIVATE_KEY; do
  [ "$(grep -cE "^[[:space:]]*(export[[:space:]]+)?${n}[[:space:]]*=" "$CHK" || true)" = 0 ] || die "$n is still in $OUT"
done
pass "BACKEND_WALLET_PRIVATE_KEY and CHAIN_SIGNER_PRIVATE_KEY absent: no chain signing, no nonce use by the rehearsal (attestations stay pending)"
say "blanked third-party credentials:${BLANKED:- (none present)}"
# Classify EVERY name with a value (not only credential-looking ones); then check every copied value's shape.
unclassified=""; carrying=""; n_set=0; n_w3a=0; n_cred=0; n_plain=0; n_empty=0
for n in $NEW_NAMES; do
  if inlist "$n" "$SET_NAMES"; then n_set=$((n_set + 1)); continue; fi   # written by this script, not copied
  v=$(getv "$CHK" "$n")
  if [ -z "$v" ]; then n_empty=$((n_empty + 1)); continue; fi
  if inlist "$n" "$KEEP_W3A"; then n_w3a=$((n_w3a + 1))
  elif inlist "$n" "$CRED_ALLOWED"; then n_cred=$((n_cred + 1))
  elif inlist "$n" "$KEPT_PLAIN"; then n_plain=$((n_plain + 1))
  else unclassified="$unclassified $n"; continue; fi
  # OPS_ADMIN_PASSWORD is a declared credential (item J): its shape is not a signal.
  [ "$n" = OPS_ADMIN_PASSWORD ] && continue
  if why=$(value_carries_credential "$v"); then carrying="$carrying $n($why)"; fi
done
unset v
[ -z "$unclassified" ] || die "name(s) with a value that the rehearsal policy does not classify:$unclassified - add each to KEPT_PLAIN (not a secret), CRED_ALLOWED (needed credential, with an APPROVAL item), the BLANKED list or the REMOVED rule in 20-env.sh, then re-run"
pass "every name with a value is classified: set by this script=$n_set, Web3Auth unchanged=$n_w3a, kept credentials=$n_cred ($(for n in $NEW_NAMES; do inlist "$n" "$CRED_ALLOWED" && ! inlist "$n" "$SET_NAMES" && printf '%s ' "$n"; done; true)), kept plain=$n_plain, empty=$n_empty"
[ -z "$carrying" ] || die "copied value(s) that carry a credential:$carrying - blank or remove them in 20-env.sh, then re-run"
pass "no copied value carries a URL credential, a PEM key block or a 32-byte hex key"
for n in $NEW_NAMES; do case "$n" in SSO_*|WEB3AUTH_*) inlist "$n" "$SET_NAMES $KEEP_W3A" || die "unexpected $n left";; esac; done
pass "every SSO_* / WEB3AUTH_* name is either set by the runbook tables or in the unchanged list"
say "SMTP_* names emptied: $(printf '%s\n' $SET_NAMES | grep -c '^SMTP_' || true)"
say "kept and needed: APNS_KEY_ID/APNS_TEAM_ID (boot requires them; key file is a throwaway), PASS_TYPE_ID, OPS_ADMIN_* (own stack)"
say "rehearsal TGE client: id=tge-rehearsal, plaintext secret only in $SEC/tge_rehearsal_client_secret (hand over out of band)"
old_snapshot_assert
step "install"
if [ -f "$OUT" ] && ! cmp -s "$OUT" "$TMP"; then cp -p "$OUT" "$OUT.prev"; chmod 600 "$OUT.prev"; say "previous version kept as $(basename "$OUT").prev"; fi
mv "$TMP" "$OUT"; ENV_OK=1
pass "$OUT installed (mode $(stat -c %a "$OUT" 2>/dev/null || stat -f %Lp "$OUT")) after every check passed"
