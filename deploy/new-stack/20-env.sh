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
#   /root/ddcnew/settings.env          the hosts and ports (common.sh settings), if no earlier script recorded them
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
# HOSTS (settings API_HOST / APP_HOST, common.sh): PUBLIC_BASE_URL = API_BASE_URL = https://<API_HOST> (the issuer the
#   api announces) and APP_PUBLIC_URL = FRONTEND_URL = https://<APP_HOST> (the consent origin). The written file is
#   checked for exactly these values before it is installed.
# OLD APP BUILDS (backend PR #38, read once it merges; inert before): WEB3AUTH_RETIRED_CLIENT_IDS = the old env's
#   WEB3AUTH_CLIENT_ID (the Sapphire Devnet id being retired; it must look like a Web3Auth client id and differ from the
#   mainnet id; only its first 8 characters are printed) and LOGIN_MISSING_IDTOKEN_MEANS_OLD_APP=on (PR #38 accepts only
#   on or off and stops the boot on anything else).
# OLD-STACK INTEGRITY: containers and old files are fingerprinted at start and end (common.sh old_snapshot_*).
#
# Prints: parse statistics, the variable-NAME diff against the old file, the names it set, the db_target line and
# sha256 comparisons (match/differ). Never a secret value (the client id and the invoice seller's account id are not
# secrets and are printed). Multi-line quoted values, comments, blank lines, duplicate
# names and `export` prefixes in the old file are handled; values that are kept are copied byte for byte.
#
# REQUIRED, no default: REHEARSAL_CLIENT_ID=<the partner's client id>, written as SSO_TGE_CLIENT_ID. Since backend fd2d4e9
#   the api refuses tge and tge-rehearsal at boot, and any id that is not [A-Za-z0-9._-]{1,64} (common.sh
#   client_id_check applies the same rule). A run that passes records it in settings.env; later runs reuse it, and an
#   override that differs from the record stops (99-teardown.sh removes the record).
# THE PARTNER'S LIVE SETTINGS ARE KEPT (2026-10-14: the partner signs in through this stack). The previous env is
#   $NEW_DIR/.env.api (what the running api was created with) and $NEW_DIR/.env.rehearsal; a name both hold must have the
#   same value in both. Without an explicit override, a re-run keeps the previous SSO_TGE_REDIRECT_URIS,
#   SSO_TGE_INITIATE_LOGIN_URI and SSO_DEVELOPER_ALLOWED_EMAILS, takes SSO_TGE_CLIENT_ID from it when settings.env has
#   none, and stops when the client id or the issuer and consent origin (PUBLIC_BASE_URL = API_BASE_URL = https://<API_HOST>,
#   APP_PUBLIC_URL = FRONTEND_URL = https://<APP_HOST>) would differ from it; only REHEARSAL_CLIENT_ID= or API_HOST= /
#   APP_HOST= given on this call may change those. No placeholder is ever filled in: a redirect or start-login URI on a
#   .invalid host is accepted only as an explicit override (WARN), never kept.
# Overrides (an explicit value, even an empty one, replaces the kept value; defaults in brackets, used only when the
# previous env has no value):
#   REHEARSAL_DB [ddc_rehearsal]
#   REHEARSAL_REDIRECT_URIS [none: required when the previous env has none]  the partner's callback(s), comma-separated
#   REHEARSAL_INITIATE_LOGIN_URI [empty -> /api/sso/* answer client_disabled]
#   REHEARSAL_DEVELOPER_ALLOWED_EMAILS [empty = nobody may register] -> SSO_DEVELOPER_ALLOWED_EMAILS, comma-separated
#       e-mail addresses (never printed: a count only). remote.sh cannot pass an '@', so the argument
#       --developer-emails-stdin reads the list from the first line of stdin instead (remote.sh run forwards stdin).
#   OAUTH_PUBLIC_REGISTRATION [false]  (runbook 5.2: recommended, Sloan to confirm)
#   W3A_GOOGLE / W3A_EMAIL / W3A_APPLE / W3A_X  Sapphire Mainnet built-in login names
#       [web3auth-google-sapphire, web3auth-auth0-email-passwordless-sapphire, web3auth-auth0-apple-sapphire,
#        web3auth-auth0-twitter-sapphire]: no "-mainnet" suffix (the devnet names end in "-sapphire-devnet"; a real
#       Mainnet e-mail login carried web3auth-auth0-email-passwordless-sapphire on 2026-10-14). Override one only
#       when a real Mainnet token names it differently.
#   INVOICE_SELLER_USER_ID [none]  the account that receives payments for orders without a merchant and for wallet
#       top-ups; until it is set those requests are refused. A User id, so a lower-case canonical UUID (common.sh
#       invoice_seller_id_check; remote.sh applies it before connecting); anything else, an empty value included, stops
#       the run before it writes. The operator reads it from the database; it is never written into the repository.
#       Without it on the call the previous env's value is kept (like the partner settings: .env.api and .env.rehearsal
#       must agree), else the old env's value is taken (checked the same way), else it is not set. The id is printed (it
#       is not a secret). When the source of the image named in $NEW_DIR/.env has src/constants/invoiceSeller.js: a WARN
#       while it is not set (not a failure), and an INFO when the old env gives INVOICE_SELLER_EMAIL, which is ignored
#       (copied unchanged, not printed).
# Fixed (Sloan, 2026-10-14): every partner field (SSO_TGE_STATUS_FIELDS = the backend's whole STATUS_FIELD_CATALOG), the
#   referral bind write on (SSO_TGE_REFERRAL_BIND=true), SSO_DEVELOPER_REGISTRATION=allowlist. A backend before PR #64
#   (main 66bf00f; the earlier release images among them) refuses to boot on allowlist, and one without a listed field
#   refuses that field: when $NEW_DIR/.env names the image 10-build.sh built, its source is checked for both first.
# Local test only (DDC_LOCAL_TEST=1): OLD_ENV, NEW_DIR, FE_ENV_TGE may point at synthetic files outside /root.
set -euo pipefail
HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
. "$HERE/common.sh"
require_server

FE_ENV_TGE="${FE_ENV_TGE:-$NEW_DIR/src/frontend-current/.env.tge}"
REHEARSAL_DB="${REHEARSAL_DB:-ddc_rehearsal}"
# REHEARSAL_REDIRECT_URIS, REHEARSAL_INITIATE_LOGIN_URI, REHEARSAL_DEVELOPER_ALLOWED_EMAILS: see "the partner's live
# settings" below (an explicit value, else the previous env's).
OAUTH_PUBLIC_REGISTRATION="${OAUTH_PUBLIC_REGISTRATION:-false}"
W3A_GOOGLE="${W3A_GOOGLE:-web3auth-google-sapphire}"
W3A_EMAIL="${W3A_EMAIL:-web3auth-auth0-email-passwordless-sapphire}"
W3A_APPLE="${W3A_APPLE:-web3auth-auth0-apple-sapphire}"
W3A_X="${W3A_X:-web3auth-auth0-twitter-sapphire}"
DB_USER=ddcnew
OUT="$NEW_DIR/.env.rehearsal"
OUT_DB="$NEW_DIR/.env.db"
SEC="$NEW_DIR/secrets"
DEV_EMAILS_STDIN=0
for a in "$@"; do
  case "$a" in --developer-emails-stdin) DEV_EMAILS_STDIN=1;; *) die "unknown argument '$a' (the only one is --developer-emails-stdin)";; esac
done

guard_db_name "$REHEARSAL_DB"
case "$REHEARSAL_DB" in ddc_rehearsal|ddc_rehearsal2) ;; *) die "REHEARSAL_DB must be ddc_rehearsal or ddc_rehearsal2";; esac

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
# INVOICE_SELLER_*: the invoice seller's account id, its billing address, e-mail and tax id (invoice data; none is a
# credential), listed so an old env that carries them passes the classification. INVOICE_SELLER_USER_ID with a value is
# written by this script; INVOICE_SELLER_EMAIL is copied unchanged and ignored (an INFO says so; header).
KEPT_PLAIN="APNS_TEAM_ID DDC_CHAIN_ID DDC_CHAIN_RPC_URL DISABLE_REFERRAL_REWARDS_FEATURES GEMINI_DEFAULT_MODEL
  INVOICE_SELLER_ADDRESS INVOICE_SELLER_EMAIL INVOICE_SELLER_TAX_ID INVOICE_SELLER_USER_ID JWT_EXPIRES_IN
  METADATA_BASE_URL NODE_ENV OPS_ADMIN_USERNAME PORT TEST_USER_EMAIL
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
# The partner's live settings (header). Resolved from the previous env before anything is written, so a refusal leaves
# nothing behind (this part also runs in the parent, before run_begin runs the script again with its log).
# ---------------------------------------------------------------------------
PREV_FILES=()
for f in "$NEW_DIR/.env.api" "$OUT"; do if [ -f "$f" ]; then PREV_FILES+=("$f"); fi; done
prev_names() { local f s=""; for f in ${PREV_FILES[@]+"${PREV_FILES[@]}"}; do s="$s $(basename "$f")"; done; printf '%s' "${s# }"; }
# prevv NAME: PREV_SET=1 and PREV_VAL=<value> when a previous env file assigns NAME, else PREV_SET=0. Stops when
# .env.api and .env.rehearsal both assign it with different values (names only, never the values).
prevv() {
  local f v
  PREV_SET=0; PREV_VAL=""
  for f in ${PREV_FILES[@]+"${PREV_FILES[@]}"}; do
    grep -qxF -- "$1" <<< "$(envparse names "$f")" || continue
    v=$(getv "$f" "$1")
    [ "$PREV_SET" = 0 ] || [ "$v" = "$PREV_VAL" ] \
      || die "$1 differs between $(prev_names) (the previous env; values not printed): make the two files agree first (the running api was created with .env.api), or give the value on this call where the header allows it"
    PREV_SET=1; PREV_VAL="$v"
  done
}
is_set() { eval "[ -n \"\${$1+x}\" ]"; }   # whether variable $1 is set, even to an empty value (bash 3.2 has no \${!v+x})
# kept <override variable> <env name> <default, or - for none>: KV = the value, KS = where it came from. An explicit
# override (even empty) wins and names <env name> in EXPLICIT_NAMES; else the previous env's value; else the default.
EXPLICIT_NAMES=""
kept() {
  if is_set "$1"; then KV="${!1}"; KS="override $1"; EXPLICIT_NAMES="$EXPLICIT_NAMES $2"; return 0; fi
  prevv "$2"
  if [ "$PREV_SET" = 1 ]; then KV="$PREV_VAL"; KS="kept from the previous env"
  elif [ "$3" != - ]; then KV="$3"; KS="default"
  else die "$1=<value> is required: the previous env ($([ "${#PREV_FILES[@]}" = 0 ] && echo none || prev_names)) has no $2, and no placeholder is filled in"; fi
}
# A .invalid host (RFC 2606) never resolves: such a URI is a placeholder no partner can sign in with.
uris_on_invalid_host() { # <comma-separated URIs>
  local u h
  while IFS= read -r u; do
    h="${u#*://}"; h="${h%%/*}"; h="${h%%\?*}"; h="${h##*@}"; h="${h%%:*}"; h=$(printf '%s' "$h" | tr 'A-Z' 'a-z')
    case "$h" in invalid|*.invalid|*.invalid.) return 0;; esac
  done < <(csv_items "$1")
  return 1
}
PLACEHOLDERS=""
placeholder_check() { # <env name> <override variable> <source> <value>
  uris_on_invalid_host "$4" || return 0
  case "$3" in override*) PLACEHOLDERS="$PLACEHOLDERS $1";; *) die "$1 in the previous env names a .invalid host (a placeholder: no partner can sign in with it): pass the partner's real value as $2=";; esac
}
kept REHEARSAL_REDIRECT_URIS SSO_TGE_REDIRECT_URIS -; REHEARSAL_REDIRECT_URIS="$KV"; REDIRECT_SRC="$KS"
[ -n "$REHEARSAL_REDIRECT_URIS" ] || die "SSO_TGE_REDIRECT_URIS would be empty ($REDIRECT_SRC): the api needs the partner's callback; pass REHEARSAL_REDIRECT_URIS=<the partner's callback URI(s)>"
placeholder_check SSO_TGE_REDIRECT_URIS REHEARSAL_REDIRECT_URIS "$REDIRECT_SRC" "$REHEARSAL_REDIRECT_URIS"
kept REHEARSAL_INITIATE_LOGIN_URI SSO_TGE_INITIATE_LOGIN_URI ""; REHEARSAL_INITIATE_LOGIN_URI="$KV"; INITIATE_SRC="$KS"
placeholder_check SSO_TGE_INITIATE_LOGIN_URI REHEARSAL_INITIATE_LOGIN_URI "$INITIATE_SRC" "$REHEARSAL_INITIATE_LOGIN_URI"
# The client id: the override, the record, or (neither given) the previous env's; it must equal the previous env's
# unless REHEARSAL_CLIENT_ID is given on this call.
prevv SSO_TGE_CLIENT_ID; PREV_CID_SET=$PREV_SET; PREV_CID="$PREV_VAL"; CID_KEPT=0
if [ -z "$OVR_REHEARSAL_CLIENT_ID" ] && [ -z "$(settings_recorded REHEARSAL_CLIENT_ID)" ] && [ -n "$PREV_CID" ]; then OVR_REHEARSAL_CLIENT_ID="$PREV_CID"; CID_KEPT=1; fi
client_id_resolve   # REHEARSAL_CLIENT_ID: the override, the record or the previous env's; required, no default
if [ "$CID_KEPT" = 1 ]; then CLIENT_ID_SOURCE="kept from the previous env"; elif [ "$CLIENT_ID_SOURCE" = override ]; then EXPLICIT_NAMES="$EXPLICIT_NAMES SSO_TGE_CLIENT_ID"; fi
[ "$PREV_CID_SET" = 0 ] || [ "$PREV_CID" = "$REHEARSAL_CLIENT_ID" ] || [ "$CLIENT_ID_SOURCE" = override ] \
  || die "SSO_TGE_CLIENT_ID=$REHEARSAL_CLIENT_ID ($CLIENT_ID_SOURCE) differs from the previous env's SSO_TGE_CLIENT_ID, which the partner signs in with: pass REHEARSAL_CLIENT_ID= on this call to change it on purpose"
# The issuer and the consent origin follow the settings' hosts; they must equal the previous env's unless API_HOST= /
# APP_HOST= is given on this call (a default or a recorded host never replaces what the partner sees).
for nv in "PUBLIC_BASE_URL API_HOST" "API_BASE_URL API_HOST" "APP_PUBLIC_URL APP_HOST" "FRONTEND_URL APP_HOST"; do
  n="${nv% *}"; hv="${nv#* }"; ov="OVR_$hv"
  if [ -n "${!ov}" ]; then EXPLICIT_NAMES="$EXPLICIT_NAMES $n"; continue; fi
  prevv "$n"
  [ "$PREV_SET" = 0 ] || [ "$PREV_VAL" = "https://${!hv}" ] \
    || die "$n would change from the previous env's $PREV_VAL to https://${!hv} ($hv: $SETTINGS_SOURCE): the partner checks the issuer and the consent origin; pass $hv= on this call to change it on purpose"
done
# The invoice seller (header): given on this call, else kept from the previous env; the old env's value is looked at
# later (it is read after run_begin), only when neither has one. SELLER_SRC says where the value came from.
kept INVOICE_SELLER_USER_ID INVOICE_SELLER_USER_ID ""; SELLER_ID="$KV"
case "$KS" in
  override*) SELLER_SRC="given on this call";;
  *) if [ -n "$SELLER_ID" ]; then SELLER_SRC="kept from the previous env"; else SELLER_SRC="not set"; fi;;
esac
[ "$SELLER_SRC" = "not set" ] || invoice_seller_id_check "$SELLER_ID" "$SELLER_SRC"
if [ "$DEV_EMAILS_STDIN" = 1 ] && is_set REHEARSAL_DEVELOPER_ALLOWED_EMAILS; then
  die "--developer-emails-stdin and REHEARSAL_DEVELOPER_ALLOWED_EMAILS both given: give the list once"
fi
for p in "$OUT" "$OUT_DB" "$SEC"; do guard_write_path "$p"; done
run_begin 20-env "$@"
settings_say
say "rehearsal client id: $REHEARSAL_CLIENT_ID ($CLIENT_ID_SOURCE)"
[ -r "$OLD_ENV" ] || die "old env file $OLD_ENV not readable"
[ -r "$FE_ENV_TGE" ] || die "frontend .env.tge not found at $FE_ENV_TGE (10-build.sh unpacks it)"
# The developer allow-list: read here, in the run with the log (run_begin starts the script again; stdin goes to it).
if [ "$DEV_EMAILS_STDIN" = 1 ]; then
  v=""; IFS= read -r -t 30 v || [ -n "$v" ] || die "--developer-emails-stdin: no line on stdin within 30 s (pipe it: printf '%s\\n' '<address>,<address>' | ...)"
  # shellcheck disable=SC2034  # read by name in kept() below
  REHEARSAL_DEVELOPER_ALLOWED_EMAILS="$v"; unset v
fi
kept REHEARSAL_DEVELOPER_ALLOWED_EMAILS SSO_DEVELOPER_ALLOWED_EMAILS ""; DEV_EMAILS_SRC="$KS"
[ "$DEV_EMAILS_STDIN" = 0 ] || DEV_EMAILS_SRC="override --developer-emails-stdin"
# The backend's own shape (an address it would refuse stops its boot), within setv's characters. Positions, never values.
DEV_EMAILS=""; DEV_EMAILS_N=0; re_mail='^[A-Za-z0-9._+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$'
while IFS= read -r e; do
  DEV_EMAILS_N=$((DEV_EMAILS_N + 1))
  [ "${#e}" -le 254 ] && [[ "$e" =~ $re_mail ]] || die "SSO_DEVELOPER_ALLOWED_EMAILS entry #$DEV_EMAILS_N ($DEV_EMAILS_SRC) is not an e-mail address (the backend would refuse to boot; the value is not printed)"
  DEV_EMAILS="${DEV_EMAILS:+$DEV_EMAILS,}$e"
done < <(csv_items "$KV")
unset e KV
say "partner settings: SSO_TGE_REDIRECT_URIS $REDIRECT_SRC ($(csv_items "$REHEARSAL_REDIRECT_URIS" | grep -c . || true) URI); SSO_TGE_INITIATE_LOGIN_URI $INITIATE_SRC ($([ -n "$REHEARSAL_INITIATE_LOGIN_URI" ] && echo set || echo empty)); SSO_DEVELOPER_ALLOWED_EMAILS $DEV_EMAILS_SRC ($DEV_EMAILS_N address(es), not printed); previous env: $([ "${#PREV_FILES[@]}" = 0 ] && echo none || prev_names)"
[ -z "$PLACEHOLDERS" ] || warn "$(printf '%s' "${PLACEHOLDERS# }" | tr ' ' ',') names a .invalid host (explicit override): no partner can complete a sign-in with it"
old_snapshot_begin
settings_record

# ---------------------------------------------------------------------------
step "old env file: $OLD_ENV"
stats=$(envparse stats "$OLD_ENV"); say "$stats"
case "$stats" in *"unparsed=0 unterminated=0"*) pass "old file parses cleanly";; *) die "old file has unparsed lines or an unterminated quote; fix by hand first";; esac
OLD_NAMES=$(envparse names "$OLD_ENV" | sort -u | tr '\n' ' ')
# The invoice seller, when neither this call nor the previous env gives one: the old env's value.
if [ "$SELLER_SRC" = "not set" ] && inlist INVOICE_SELLER_USER_ID "$OLD_NAMES"; then
  SELLER_ID=$(getv "$OLD_ENV" INVOICE_SELLER_USER_ID)
  if [ -n "$SELLER_ID" ]; then SELLER_SRC="copied from the old env"; invoice_seller_id_check "$SELLER_ID" "$SELLER_SRC"; fi
fi
say "invoice seller: INVOICE_SELLER_USER_ID $SELLER_SRC${SELLER_ID:+ ($SELLER_ID)}"

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
# The id the old App builds use: the old env's WEB3AUTH_CLIENT_ID (Sapphire Devnet). A Web3Auth client id is the
# base64url form of a 65-byte public key: 87 characters starting with B (both public ids measured 10-05).
RETIRED_ID=$(getv "$OLD_ENV" WEB3AUTH_CLIENT_ID)
[ -n "$RETIRED_ID" ] || die "WEB3AUTH_RETIRED_CLIENT_IDS: the old env's WEB3AUTH_CLIENT_ID is empty, so the retired (devnet) client id is unknown"
[ "$RETIRED_ID" != "$W3A_ID" ] || die "WEB3AUTH_RETIRED_CLIENT_IDS: the old env's WEB3AUTH_CLIENT_ID is the new mainnet id ($(printf '%s' "$RETIRED_ID" | cut -c1-8)...): retiring it would tell every current App to update"
[[ "$RETIRED_ID" =~ ^B[A-Za-z0-9_-]{86}$ ]] || die "WEB3AUTH_RETIRED_CLIENT_IDS: the old env's WEB3AUTH_CLIENT_ID does not look like a Web3Auth client id (87 base64url characters starting with B)"

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
setv PUBLIC_BASE_URL "https://$API_HOST"
setv APP_PUBLIC_URL "https://$APP_HOST"
setv FRONTEND_URL "https://$APP_HOST"
setv API_BASE_URL "https://$API_HOST"
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
# Only logins that verify the address themselves (Google, e-mail passwordless, Apple); never X.
setv WEB3AUTH_EMAIL_TRUSTED_VERIFIERS "$W3A_GOOGLE,$W3A_EMAIL,$W3A_APPLE"
# Old App builds after the mainnet switch get "please update" instead of a failed login (backend PR #38).
setv WEB3AUTH_RETIRED_CLIENT_IDS "$RETIRED_ID"
setv LOGIN_MISSING_IDTOKEN_MEANS_OLD_APP on
# 5.2 TGE SSO (rehearsal client)
setv SSO_TGE_ENABLED true
setv SSO_ENVIRONMENT prod
setv SSO_TGE_CLIENT_ID "$REHEARSAL_CLIENT_ID"
setv SSO_TGE_CLIENT_NAME "DDC TGE"
setv SSO_TGE_CLIENT_SECRET_SHA256 "$TGE_SECRET_SHA"
setv SSO_TGE_REDIRECT_URIS "$REHEARSAL_REDIRECT_URIS"
setv SSO_TGE_INITIATE_LOGIN_URI "$REHEARSAL_INITIATE_LOGIN_URI"
setv SSO_SESSION_SECRET "$(cat "$SEC/sso_session_secret_rehearsal")"
setv SSO_TGE_AUTO_APPROVE app,web
# POST /partner/tge/referral/bind and its scope (src/constants/partnerClient.js referralBindEnabled reads this name).
setv SSO_TGE_REFERRAL_BIND true
setv SSO_TGE_APP_PRESENTATION webview
# The freeze list (docs/TGE_SSO.md section 14): every field of the backend's STATUS_FIELD_CATALOG (Sloan, 2026-10-14:
# everything the partner API offers today), each still behind the scope the user grants. points = the balance on
# /partner/tge/status, points_history = GET /partner/tge/points/history (section 7c), both under tge:points; listed only
# with a web build whose consent line for points reads "balance and history" (data-dance-frontend a077c74 and later).
STATUS_FIELDS=registered_at,wallet_bound,data_licence_granted,email_masked,avatar,email,wallet_address,points,referral,referral_network,points_history
setv SSO_TGE_STATUS_FIELDS "$STATUS_FIELDS"
setv SSO_REQUIRE_VERIFIED_SESSION false
# Self-serve SSO client registration (backend PR #64): only the listed accounts, from a verified login e-mail; an empty
# list admits nobody.
setv SSO_DEVELOPER_REGISTRATION allowlist
setv SSO_DEVELOPER_ALLOWED_EMAILS "$DEV_EMAILS"
setv OAUTH_PUBLIC_REGISTRATION_ENABLED "$OAUTH_PUBLIC_REGISTRATION"
setv DISBURSEMENT_PAUSED true
# The invoice seller (header): written here whenever it has a value (given, kept or copied from the old env), so a re-run
# that keeps it writes the same file; the old env's own line is then dropped.
if [ -n "$SELLER_ID" ]; then setv INVOICE_SELLER_USER_ID "$SELLER_ID"; fi
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
# The backend 40-up.sh will start (API_IMAGE in $NEW_DIR/.env, written by 10-build.sh, which unpacks its source to
# $NEW_DIR/src/backend-<sha12>/) must accept these values: one without a listed field, or before PR #64 (allowlist),
# refuses to boot, and 40-up.sh would see that only after it recreated the api. Checked before anything is written.
step "the backend that 40-up.sh will start accepts these values"
img=""; if [ -f "$NEW_DIR/.env" ]; then img=$(sed -n 's/^API_IMAGE=//p' "$NEW_DIR/.env" | tail -n 1); fi
if [ -z "$img" ]; then
  warn "no API_IMAGE in $NEW_DIR/.env (10-build.sh writes it): not checked here; 40-up.sh's boot check still applies"
else
  be="${img#ddcnew/backend:}"; be="${be%-infra}"
  [[ "$be" =~ ^[0-9a-f]{12}$ ]] || die "API_IMAGE=$img in $NEW_DIR/.env is not ddcnew/backend:<12 hex>[-infra]"
  bc="$NEW_DIR/src/backend-$be/src/constants"
  [ -f "$bc/partnerClient.js" ] && [ -f "$bc/developerRegistration.js" ] \
    || die "the source of $img is not in $NEW_DIR/src/backend-$be (10-build.sh unpacks it there): cannot check that it accepts these values"
  catalog=$(awk '/^const STATUS_FIELD_CATALOG = Object\.freeze\(\{/ { f = 1; next } f && /^\}\);/ { exit } f && match($0, /^  [a-z_]+: [{]/) { print substr($0, 3, RLENGTH - 5) }' "$bc/partnerClient.js")
  missing=""; while IFS= read -r f; do grep -qxF -- "$f" <<< "$catalog" || missing="$missing $f"; done < <(csv_items "$STATUS_FIELDS")
  [ -z "$missing" ] || die "$img does not know SSO_TGE_STATUS_FIELDS:$missing (its STATUS_FIELD_CATALOG: $(printf '%s' "$catalog" | tr '\n' ',')): it would refuse to boot"
  grep -qE "Object\.freeze\(\[[^]]*'allowlist'" "$bc/developerRegistration.js" \
    || die "$img predates backend PR #64 (main 66bf00f): it refuses to boot on SSO_DEVELOPER_REGISTRATION=allowlist; build a release that contains it"
  pass "$img (source $NEW_DIR/src/backend-$be) knows every SSO_TGE_STATUS_FIELDS name ($(csv_items "$STATUS_FIELDS" | grep -c . || true) of $(printf '%s\n' "$catalog" | grep -c . || true) in its catalog) and SSO_DEVELOPER_REGISTRATION=allowlist"
  # The invoice seller (header), for a source with src/constants/invoiceSeller.js: a WARN while INVOICE_SELLER_USER_ID
  # is not set; an INFO when the old env gives INVOICE_SELLER_EMAIL (its value is not printed).
  if [ ! -f "$bc/invoiceSeller.js" ]; then say "$img has no src/constants/invoiceSeller.js: no invoice seller check"
  else
    if [ "$SELLER_SRC" = "not set" ]; then
      warn "INVOICE_SELLER_USER_ID is not set: set it to the account that receives payments for orders without a merchant and for wallet top-ups; until it is set those requests are refused. Give INVOICE_SELLER_USER_ID=<uuid> on a 20-env.sh call, then run 40-up.sh"
    else pass "INVOICE_SELLER_USER_ID for $img: $SELLER_ID ($SELLER_SRC)"; fi
    if inlist INVOICE_SELLER_EMAIL "$OLD_NAMES" && [ -n "$(getv "$OLD_ENV" INVOICE_SELLER_EMAIL)" ]; then
      say "INFO INVOICE_SELLER_EMAIL (old env) is ignored: copied unchanged; INVOICE_SELLER_USER_ID sets the account"
    fi
  fi
fi

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
[ "$(getv "$CHK" WEB3AUTH_RETIRED_CLIENT_IDS | sha256)" = "$(getv "$OLD_ENV" WEB3AUTH_CLIENT_ID | sha256)" ] && [ "$(getv "$CHK" WEB3AUTH_RETIRED_CLIENT_IDS)" != "$(getv "$CHK" WEB3AUTH_CLIENT_ID)" ] \
  && pass "WEB3AUTH_RETIRED_CLIENT_IDS = the old WEB3AUTH_CLIENT_ID ($(getv "$CHK" WEB3AUTH_RETIRED_CLIENT_IDS | cut -c1-8)..., the devnet id being retired), not the mainnet id" || die "WEB3AUTH_RETIRED_CLIENT_IDS check failed"
# PR #38's boot checks (common.sh old_app_env_check), so that a bad value stops here, before the api would refuse to boot.
old_app_env_check "$(getv "$CHK" WEB3AUTH_RETIRED_CLIENT_IDS)" "$(getv "$CHK" WEB3AUTH_CLIENT_ID)" "$(getv "$CHK" WEB3AUTH_EXTERNAL_AUDIENCE)" "$(getv "$CHK" LOGIN_MISSING_IDTOKEN_MEANS_OLD_APP)"
[ "$OLD_APP_RETIRED_COUNT" = 1 ] || die "WEB3AUTH_RETIRED_CLIENT_IDS should hold exactly one id (the old WEB3AUTH_CLIENT_ID), it holds $OLD_APP_RETIRED_COUNT"
pass "LOGIN_MISSING_IDTOKEN_MEANS_OLD_APP=$(getv "$CHK" LOGIN_MISSING_IDTOKEN_MEANS_OLD_APP); WEB3AUTH_RETIRED_CLIENT_IDS: 1 entry, equal to neither WEB3AUTH_CLIENT_ID nor a WEB3AUTH_EXTERNAL_AUDIENCE entry (backend PR #38's boot checks; read once it merges)"
# The issuer (PUBLIC_BASE_URL) and the consent origin (APP_PUBLIC_URL) the api announces: the settings' hosts, never production.
for nv in "PUBLIC_BASE_URL https://$API_HOST" "API_BASE_URL https://$API_HOST" "APP_PUBLIC_URL https://$APP_HOST" "FRONTEND_URL https://$APP_HOST"; do
  [ "$(getv "$CHK" "${nv% *}")" = "${nv#* }" ] || die "${nv% *} in the new file is not ${nv#* }"
done
case " $(getv "$CHK" PUBLIC_BASE_URL) $(getv "$CHK" APP_PUBLIC_URL) " in *" https://api.datadance.ai "*|*" https://app.datadance.ai "*) die "the issuer or the consent origin is a production host";; esac
pass "issuer PUBLIC_BASE_URL = API_BASE_URL = https://$API_HOST; consent origin APP_PUBLIC_URL = FRONTEND_URL = https://$APP_HOST (API_HOST / APP_HOST)"
# The partner's live settings (header): the new file keeps the previous env's values; only a name an explicit override on
# this call covers may differ.
kept_n=0; given=""; fresh=""
for n in SSO_TGE_CLIENT_ID SSO_TGE_REDIRECT_URIS SSO_TGE_INITIATE_LOGIN_URI SSO_DEVELOPER_ALLOWED_EMAILS PUBLIC_BASE_URL API_BASE_URL APP_PUBLIC_URL FRONTEND_URL; do
  if inlist "$n" "$EXPLICIT_NAMES"; then given="$given $n"; continue; fi
  prevv "$n"
  if [ "$PREV_SET" = 0 ]; then fresh="$fresh $n"
  elif [ "$(getv "$CHK" "$n")" = "$PREV_VAL" ]; then kept_n=$((kept_n + 1))
  else die "$n differs from the previous env without an explicit override on this call"; fi
done
[ "$(getv "$CHK" SSO_DEVELOPER_REGISTRATION)" = allowlist ] && [ "$(getv "$CHK" SSO_TGE_STATUS_FIELDS)" = "$STATUS_FIELDS" ] && [ "$(getv "$CHK" SSO_TGE_REFERRAL_BIND)" = true ] \
  || die "SSO_DEVELOPER_REGISTRATION, SSO_TGE_STATUS_FIELDS or SSO_TGE_REFERRAL_BIND in the new file is not the value set above"
pass "partner settings kept from the previous env: $kept_n; given on this call:${given:- none}; no previous value:${fresh:- none}. SSO_TGE_STATUS_FIELDS: all $(csv_items "$STATUS_FIELDS" | grep -c . || true) fields, SSO_TGE_REFERRAL_BIND=true, SSO_DEVELOPER_REGISTRATION=allowlist ($DEV_EMAILS_N listed)"
# The invoice seller (header): the new file holds the value resolved above (a lower-case canonical UUID), or none.
sv=$(getv "$CHK" INVOICE_SELLER_USER_ID)
[ "$sv" = "$SELLER_ID" ] || die "INVOICE_SELLER_USER_ID in the new file is not the value resolved above ($SELLER_SRC)"
[ -z "$sv" ] || invoice_seller_id_check "$sv" "in the new file"
unset sv
pass "INVOICE_SELLER_USER_ID in the new file: ${SELLER_ID:-none} ($SELLER_SRC)"
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
v=$(getv "$CHK" SSO_TGE_CLIENT_ID)
[ "$v" = "$REHEARSAL_CLIENT_ID" ] || die "SSO_TGE_CLIENT_ID in the new file is not REHEARSAL_CLIENT_ID"
( client_id_check "$v" ) || die "SSO_TGE_CLIENT_ID in the new file would stop the api at boot (backend fd2d4e9)"
unset v
pass "SSO_TGE_CLIENT_ID=$REHEARSAL_CLIENT_ID: matches [A-Za-z0-9._-]{1,64} and is neither tge nor tge-rehearsal (the api's boot rule since backend fd2d4e9)"
say "rehearsal TGE client: id=$REHEARSAL_CLIENT_ID, plaintext secret only in $SEC/tge_rehearsal_client_secret (hand over out of band)"
old_snapshot_assert
step "install"
client_id_record   # only now, after every check passed: later runs reuse it
if [ -f "$OUT" ] && ! cmp -s "$OUT" "$TMP"; then cp -p "$OUT" "$OUT.prev"; chmod 600 "$OUT.prev"; say "previous version kept as $(basename "$OUT").prev"; fi
mv "$TMP" "$OUT"; ENV_OK=1
pass "$OUT installed (mode $(stat -c %a "$OUT" 2>/dev/null || stat -f %Lp "$OUT")) after every check passed"
