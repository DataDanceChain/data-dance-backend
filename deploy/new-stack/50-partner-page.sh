#!/usr/bin/env bash
# 50-partner-page.sh - the password-protected info page for the TGE partner (test environment only), served by the host
# nginx at https://<APP_HOST>/partner-info/ (the app vhost that 30-nginx.sh writes aliases that path to
# /srv/ddcnew/partner-info/; APP_HOST and API_HOST are the settings in common.sh). The page shows what the partner needs
# to integrate DDC login with the test environment. client_secret is on it only as ciphertext, decrypted in the reader's
# browser with the page password. Without JavaScript the page shows no password field at all, and the field it shows
# with JavaScript has no name and sits in no form: a native submit cannot send it (the CSP adds form-action 'none').
#
# CHANGES ON THE SERVER
#   apply   /srv/ddcnew/ and /srv/ddcnew/partner-info/ (directories, chmod 755: nginx runs as www-data and cannot
#           traverse /root) holding two files that nginx reads (chmod 644 index.html secret.json; ciphertext only):
#             index.html   partner-info/index.html of this package, the non-secret values filled in and HTML-escaped
#             secret.json  {"v":1,"kdf":"PBKDF2-SHA256","iter":600000,"salt":"..","iv":"..","ct":".."} (base64): the
#                          rehearsal TGE client secret, AES-256-GCM-encrypted under a 256-bit key derived from the page
#                          password with PBKDF2-SHA256 (600000 iterations, random 16-byte salt); random 12-byte IV;
#                          the 16-byte tag is appended to ct. Every apply draws a new salt and IV.
#           The encryption runs in one throwaway container of the ddcnew backend image (node; docker run --rm -i
#           --network none --pull never, read-only, no capabilities, user nobody, no log driver, no core dumps). The
#           password and the secret reach it on stdin only. Before anything is installed, it decrypts its own output
#           with a second key derivation and compares.
#   verify  decrypts secret.json with the password from stdin in a throwaway container and compares the sha256 of the
#           result with the sha256 of the secret file: prints match=yes or match=no (exit 0 or 1). Writes only its log.
#   remove  deletes /srv/ddcnew/partner-info, and /srv/ddcnew when it is then empty.
#   status  read-only: the two files (mode, size, sha256), the app vhost's /partner-info/ location, and what the local
#           nginx answers for /partner-info/ and /partner-info/secret.json: the status code and whether the sha256 of
#           the served body equals the file's.
#   apply, verify and remove take the run lock and log to /root/ddcnew/logs/ (common.sh run_begin); apply and remove
#   fingerprint the old stack at start and end (common.sh old_snapshot_*).
# INPUTS
#   The page password: STDIN ONLY, one line, never an argument or an environment variable: exactly 32 letters and
#     digits, the shape of the 1Password generator (--generate-password='32,letters,digits'). It lives only in
#     1Password (APPROVAL.md section 8):
#       op read "op://<vault>/<item>/password" | DDC_APPROVED=yes ./remote.sh run 50-partner-page.sh apply PARTNER_ALLOWED_IP=<ip>
#     A terminal on stdin is refused (typing would echo it), and so is xtrace (bash -x would print it).
#   /root/ddcnew/secrets/tge_rehearsal_client_secret (20-env.sh): the secret. Its sha256 must equal
#     SSO_TGE_CLIENT_SECRET_SHA256 in /root/ddcnew/.env.rehearsal, so the page never hands out a secret the api refuses.
#   /root/ddcnew/.env.rehearsal: PUBLIC_BASE_URL (the issuer; must be https://<API_HOST>), SSO_TGE_CLIENT_ID,
#     SSO_TGE_REDIRECT_URIS (refused while it is still the .invalid placeholder) and SSO_TGE_INITIATE_LOGIN_URI.
#   PARTNER_ALLOWED_IP (apply; an allowlisted remote.sh override): the partner address(es) that the Cloudflare rule lets
#     in, comma-separated IPv4 or IPv6. Partner-specific values never enter this repository.
#   API_IMAGE in /root/ddcnew/.env (10-build.sh): the ddcnew backend image, which runs node for the encryption.
# PRINTS: the two paths with their mode and sha256 (and the usual run-lock and old-stack lines). Never the secret, the
#   password or a value derived from them, except the sha256 of the published ciphertext file.
# UNDO: ./50-partner-page.sh remove. 99-teardown.sh removes the app vhost (the page is then no longer served) but not
#   these files. Rotate the client secret and the page password after the joint test (APPROVAL.md section 8).
# Local test only (DDC_LOCAL_TEST=1): NEW_DIR, SRV_DIR, NGINX_LOCAL_URL, PARTNER_CRYPT_IMAGE (for example
#   node:22-alpine) and DDC_TEST_RUN_ID (appended to the throwaway container's name and set as its label
#   ddcnew-localtest=<id>, so the test finds and counts only its own containers).
set -euo pipefail
case "$-" in *x*) printf 'FAIL refusing to run with xtrace (set -x / bash -x): it would print the page password\n' >&2; exit 1;; esac
HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
. "$HERE/common.sh"
require_server

cmd="${1:-status}"
[ $# -le 1 ] || die "usage: $0 apply | verify | remove | status (PARTNER_ALLOWED_IP=... is an environment override, not an argument)"
case "$cmd" in apply|verify|remove|status) ;; *) die "usage: $0 apply | verify | remove | status";; esac

PAGE_DIR="$SRV_DIR/partner-info"
TEMPLATE="$HERE/partner-info/index.html"
SEC_FILE="$NEW_DIR/secrets/tge_rehearsal_client_secret"
ENV_FILE="$NEW_DIR/.env.rehearsal"
ITER=600000
CRYPT_NAME="ddcnew-partner-crypt-$$"
CRYPT_LABEL=()
if ddc_local_test; then
  if [ -n "${DDC_TEST_RUN_ID:-}" ]; then
    [[ "$DDC_TEST_RUN_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || die "DDC_TEST_RUN_ID must be 1 to 64 letters, digits, dots, dashes or underscores"
    CRYPT_NAME="$CRYPT_NAME-$DDC_TEST_RUN_ID"; CRYPT_LABEL=(--label "ddcnew-localtest=$DDC_TEST_RUN_ID")
  fi
else
  [ -z "${PARTNER_CRYPT_IMAGE:-}" ] || die "PARTNER_CRYPT_IMAGE override is only allowed with DDC_LOCAL_TEST=1"
  [ -z "${DDC_TEST_RUN_ID:-}" ] || die "DDC_TEST_RUN_ID is only allowed with DDC_LOCAL_TEST=1"
fi
re_url='^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~%/=:@?&+-]*)?$'
re_v4='^[0-9]{1,3}[.][0-9]{1,3}[.][0-9]{1,3}[.][0-9]{1,3}$'
re_v6='^[0-9A-Fa-f:]{2,39}$'
re_img='^ddcnew/backend:[0-9a-f]{12}(-infra)?$'
re_client='^[A-Za-z0-9._-]{1,64}$'
fmode() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1"; }
html() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g' -e "s/'/\&#39;/g"; }
# One value per line, without glob expansion (the unquoted $1 is split on commas on purpose).
# shellcheck disable=SC2086
split_commas() { ( set -f; IFS=,; printf '%s\n' $1 ) }

# ---------------------------------------------------------------------------
# Checks that need no secret (before the run lock)
# ---------------------------------------------------------------------------
# The page directory: never under /root (nginx cannot traverse it) or in the old stack, never through a symlink; on the
# server exactly /srv/ddcnew/partner-info.
page_dir_check() {
  local r
  r=$(resolve_path "$PAGE_DIR")
  case "$r/" in /root/*|/opt/ddc/*) die "refusing $r: the page must not live under /root (nginx cannot read it there) or in the old stack";; esac
  [ ! -L "$SRV_DIR" ] && [ ! -L "$PAGE_DIR" ] || die "refusing: $SRV_DIR or $PAGE_DIR is a symbolic link"
  ddc_local_test || [ "$r" = /srv/ddcnew/partner-info ] || die "refusing $r: the page lives at /srv/ddcnew/partner-info exactly"
}
valid_ipv4() {
  local o
  [[ "$1" =~ $re_v4 ]] || return 1
  for o in $(split_commas "${1//./,}"); do
    case "$o" in 0|[1-9]|[1-9][0-9]|1[0-9][0-9]|2[0-4][0-9]|25[0-5]) ;; *) return 1;; esac
  done
}
valid_ipv6() { [[ "$1" =~ $re_v6 ]] && [[ "$1" == *:*:* ]]; }
ALLOWED_IPS=()
parse_ips() {
  local ip
  [ -n "${PARTNER_ALLOWED_IP:-}" ] || die "PARTNER_ALLOWED_IP=<the partner server's address> is required: ./remote.sh run 50-partner-page.sh apply PARTNER_ALLOWED_IP=..."
  while IFS= read -r ip; do
    valid_ipv4 "$ip" || valid_ipv6 "$ip" || die "PARTNER_ALLOWED_IP: '$ip' is not an IPv4 or IPv6 address"
    ALLOWED_IPS+=("$ip")
  done < <(split_commas "$PARTNER_ALLOWED_IP")
  [ "${#ALLOWED_IPS[@]}" -ge 1 ] && [ "${#ALLOWED_IPS[@]}" -le 8 ] || die "PARTNER_ALLOWED_IP: give 1 to 8 comma-separated addresses"
}

# ---------------------------------------------------------------------------
# Inputs read after the run lock
# ---------------------------------------------------------------------------
PW=""; SECRET=""
# One line from stdin, then stdin is closed for everything after it. The value is kept in a shell variable only (not
# exported), so no child process gets it in its arguments or environment.
read_password() {
  local line="" rc=0 re_pw='^[A-Za-z0-9]{32}$'
  IFS= read -r -t 120 line || rc=$?
  exec </dev/null
  [ "$rc" -le 128 ] || die "timed out waiting for the page password on stdin"
  [ -n "$line" ] || die "no page password on stdin: pipe it from 1Password (APPROVAL.md section 8)"
  # The shape of the 1Password generator's output (32 letters and digits, about 190 bits): the offline guessing cost of
  # secret.json rests on it. Neither the length nor any character is printed.
  [[ "$line" =~ $re_pw ]] || die "the page password must be exactly 32 letters and digits, as the 1Password generator makes it (--generate-password='32,letters,digits'); no blank, symbol or line ending inside"
  PW="$line"
}
read_secret() {
  local s re_sec='^[[:graph:]]+$'   # (no {16,1024}: the BSD regex library stops at 255 repetitions)
  [ -f "$SEC_FILE" ] || die "$SEC_FILE missing: run 20-env.sh first"
  s=$(<"$SEC_FILE")   # trailing newlines dropped, exactly as 20-env.sh hashes it
  [[ "$s" =~ $re_sec ]] && [ "${#s}" -ge 16 ] && [ "${#s}" -le 1024 ] || die "$SEC_FILE does not hold one value of 16 to 1024 printable characters"
  SECRET="$s"
}
secret_matches_env() {
  local want re_sha='^[0-9a-f]{64}$'
  want=$(env_get_simple SSO_TGE_CLIENT_SECRET_SHA256 "$ENV_FILE")
  [[ "$want" =~ $re_sha ]] || die "SSO_TGE_CLIENT_SECRET_SHA256 is missing in $ENV_FILE: run 20-env.sh first"
  [ "$(printf '%s' "$SECRET" | sha256)" = "$want" ] || die "sha256 of $SEC_FILE differs from SSO_TGE_CLIENT_SECRET_SHA256 in $ENV_FILE: the api would refuse the secret this page shows (re-run 20-env.sh, then 40-up.sh)"
  pass "sha256(secrets/tge_rehearsal_client_secret) = SSO_TGE_CLIENT_SECRET_SHA256 in $(basename "$ENV_FILE")"
}
ISSUER=""; CLIENT_ID=""; REDIRECTS=(); INITIATE=""
check_url() { # <name> <url>
  local h
  [[ "$2" =~ $re_url ]] || die "$1 in $ENV_FILE holds a value that is not an https URL of the expected shape"
  h="${2#https://}"; h="${h%%/*}"; h="${h%%:*}"
  case "$h" in *.invalid|*.invalid.) die "$1 in $ENV_FILE is still the .invalid placeholder: re-run 20-env.sh with REHEARSAL_REDIRECT_URIS (and REHEARSAL_INITIATE_LOGIN_URI) set to the partner's addresses, then 40-up.sh";; esac
}
read_env() {
  local raw u
  [ -f "$ENV_FILE" ] || die "$ENV_FILE missing: run 20-env.sh first"
  ISSUER=$(env_get_simple PUBLIC_BASE_URL "$ENV_FILE")
  [ "$ISSUER" = "https://$API_HOST" ] || die "PUBLIC_BASE_URL in $ENV_FILE is not https://$API_HOST (API_HOST): this page is for the rehearsal stack's test environment only"
  CLIENT_ID=$(env_get_simple SSO_TGE_CLIENT_ID "$ENV_FILE")
  [[ "$CLIENT_ID" =~ $re_client ]] || die "SSO_TGE_CLIENT_ID in $ENV_FILE is missing or not [A-Za-z0-9._-]{1,64}"
  raw=$(env_get_simple SSO_TGE_REDIRECT_URIS "$ENV_FILE")
  while IFS= read -r u; do
    u="${u#"${u%%[![:space:]]*}"}"; u="${u%"${u##*[![:space:]]}"}"   # trimmed, as the api reads the list
    [ -n "$u" ] || continue
    check_url SSO_TGE_REDIRECT_URIS "$u"
    REDIRECTS+=("$u")
  done < <(split_commas "$raw")
  [ "${#REDIRECTS[@]}" -ge 1 ] || die "SSO_TGE_REDIRECT_URIS in $ENV_FILE is empty"
  INITIATE=$(env_get_simple SSO_TGE_INITIATE_LOGIN_URI "$ENV_FILE")
  if [ -n "$INITIATE" ]; then check_url SSO_TGE_INITIATE_LOGIN_URI "$INITIATE"
  else warn "SSO_TGE_INITIATE_LOGIN_URI is empty: the page shows it as not registered (the browser flow works; the App hand-off answers client_disabled)"; fi
  say "values: issuer, client_id, ${#REDIRECTS[@]} redirect URI(s), initiate-login URI $([ -n "$INITIATE" ] && echo set || echo empty), ${#ALLOWED_IPS[@]} allowed address(es)"
}
IMG=""
pick_image() {
  if ddc_local_test && [ -n "${PARTNER_CRYPT_IMAGE:-}" ]; then IMG="$PARTNER_CRYPT_IMAGE"
  else
    [ -f "$NEW_DIR/.env" ] || die "$NEW_DIR/.env missing: run 10-build.sh first (its backend image runs the encryption)"
    IMG=$(env_get_simple API_IMAGE "$NEW_DIR/.env")
    [[ "$IMG" =~ $re_img ]] || die "API_IMAGE in $NEW_DIR/.env is not a ddcnew/backend:<sha12> tag"
  fi
  docker image inspect "$IMG" >/dev/null 2>&1 || die "image $IMG is not on this host (the encryption never pulls an image)"
  say "throwaway container $CRYPT_NAME from $IMG: --rm -i --network none --pull never --read-only --cap-drop ALL --user 65534:65534 --ulimit core=0"
}

# ---------------------------------------------------------------------------
# The crypt helper (node, inside the throwaway container). Arguments: encrypt <iterations> | verify. stdin, as lines:
#   encrypt: <password> <secret>                        -> stdout: the secret.json line
#   verify:  <password> <secret.json> <sha256 of secret>  -> stdout: match=yes | match=no
# It prints nothing else. Failures are fixed codes on stderr (never an input value, never an exception message).
# ---------------------------------------------------------------------------
read -r -d '' CRYPT_JS <<'JS' || true
'use strict';
const c = require('crypto');
const mode = process.argv[1];
const fail = (code) => { process.stderr.write('crypt: ' + code + '\n'); process.exit(3); };
const parts = [];
process.stdin.on('data', (d) => parts.push(d));
process.stdin.on('error', () => fail('stdin'));
process.stdin.on('end', () => {
  const buf = Buffer.concat(parts);
  parts.length = 0;
  const lines = [];
  let at = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] === 10) { lines.push(buf.subarray(at, i)); at = i + 1; }
  if (at < buf.length) lines.push(buf.subarray(at));
  try {
    if (mode === 'encrypt') encrypt(lines, Number(process.argv[2]));
    else if (mode === 'verify') verify(lines);
    else fail('mode');
  } catch (e) {
    fail('error');
  } finally {
    buf.fill(0);
  }
});
function gcmDecrypt(key, iv, ct) {
  const d = c.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  d.setAuthTag(ct.subarray(ct.length - 16));
  return Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
}
function encrypt(lines, iter) {
  if (lines.length !== 2 || lines[0].length !== 32 || lines[1].length < 16) fail('input');
  if (!Number.isInteger(iter) || iter < 600000) fail('iterations');
  const pw = lines[0], pt = lines[1];
  const salt = c.randomBytes(16), iv = c.randomBytes(12);
  const key = c.pbkdf2Sync(pw, salt, iter, 32, 'sha256');
  const e = c.createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  const ct = Buffer.concat([e.update(pt), e.final(), e.getAuthTag()]);
  key.fill(0);
  const key2 = c.pbkdf2Sync(pw, salt, iter, 32, 'sha256');
  const back = gcmDecrypt(key2, iv, ct);
  key2.fill(0);
  const same = back.equals(pt);
  back.fill(0);
  if (!same) fail('roundtrip');
  process.stdout.write(JSON.stringify({ v: 1, kdf: 'PBKDF2-SHA256', iter: iter, salt: salt.toString('base64'),
    iv: iv.toString('base64'), ct: ct.toString('base64') }) + '\n');
}
function verify(lines) {
  if (lines.length !== 3) fail('input');
  const pw = lines[0], want = lines[2].toString('latin1');
  let o = null;
  try { o = JSON.parse(lines[1].toString('utf8')); } catch (e) { fail('format'); }
  if (!o || o.v !== 1 || o.kdf !== 'PBKDF2-SHA256' || !Number.isInteger(o.iter) || o.iter < 600000 || o.iter > 10000000 ||
      typeof o.salt !== 'string' || typeof o.iv !== 'string' || typeof o.ct !== 'string') fail('format');
  const salt = Buffer.from(o.salt, 'base64'), iv = Buffer.from(o.iv, 'base64'), ct = Buffer.from(o.ct, 'base64');
  if (salt.length !== 16 || iv.length !== 12 || ct.length <= 16) fail('format');
  if (!/^[0-9a-f]{64}$/.test(want)) fail('input');
  const key = c.pbkdf2Sync(pw, salt, o.iter, 32, 'sha256');
  let pt = null;
  try { pt = gcmDecrypt(key, iv, ct); } catch (e) { pt = null; }
  key.fill(0);
  const got = pt ? c.createHash('sha256').update(pt).digest('hex') : '';
  if (pt) pt.fill(0);
  process.stdout.write(got === want ? 'match=yes\n' : 'match=no\n');
}
JS
crypt() { # <encrypt <iterations> | verify>; stdin -> stdout. Nothing secret in the arguments or the environment.
  # --ulimit core=0: a crash of node never writes the password or the secret into a core file.
  docker run --rm -i --network none --pull never --name "$CRYPT_NAME" ${CRYPT_LABEL[@]+"${CRYPT_LABEL[@]}"} --read-only --cap-drop ALL \
    --security-opt no-new-privileges --user 65534:65534 --memory 256m --pids-limit 64 --ulimit core=0 --log-driver none \
    --entrypoint node "$IMG" -e "$CRYPT_JS" "$@"
}

# ---------------------------------------------------------------------------
# The page
# ---------------------------------------------------------------------------
vals_html() { local v; for v in "$@"; do printf '<span class="val">%s</span>' "$(html "$v")"; done; }
fill_template() { # -> stdout: the template with every {{NAME}} replaced by its literal (already escaped) value
  local k keys="ISSUER CLIENT_ID REDIRECT_URI REDIRECT_URIS_HTML INITIATE_LOGIN_HTML ALLOWED_IPS_HTML GENERATED_AT API_HOST APP_HOST" init
  for k in $keys; do grep -qF "{{$k}}" "$TEMPLATE" || die "the template lacks {{$k}}"; done
  if [ -n "$INITIATE" ]; then init=$(vals_html "$INITIATE")
  else init='<span class="val none">未登记：从 DataDance App 发起的登录暂不可用；浏览器里直接登录不受影响</span>'; fi
  PP_KEYS="$keys" PP_ISSUER="$(html "$ISSUER")" PP_CLIENT_ID="$(html "$CLIENT_ID")" PP_REDIRECT_URI="$(html "${REDIRECTS[0]}")" \
  PP_REDIRECT_URIS_HTML="$(vals_html "${REDIRECTS[@]}")" PP_INITIATE_LOGIN_HTML="$init" PP_ALLOWED_IPS_HTML="$(vals_html "${ALLOWED_IPS[@]}")" \
  PP_API_HOST="$(html "$API_HOST")" PP_APP_HOST="$(html "$APP_HOST")" \
  PP_GENERATED_AT="$(TZ=UTC-8 date '+%Y-%m-%d %H:%M')（北京时间）" awk '
    function repl(s, from, to,    out, i) {
      out = ""
      while ((i = index(s, from)) > 0) { out = out substr(s, 1, i - 1) to; s = substr(s, i + length(from)) }
      return out s
    }
    BEGIN { n = split(ENVIRON["PP_KEYS"], K, " "); for (i = 1; i <= n; i++) V["{{" K[i] "}}"] = ENVIRON["PP_" K[i]] }
    { line = $0; if (index(line, "{{") > 0) for (k in V) line = repl(line, k, V[k]); print line }' "$TEMPLATE"
}
no_leak() { # <file>: neither the secret nor the password in it (compared inside bash: no process sees either value)
  local body
  body=$(<"$1")
  case "$body" in *"$SECRET"*|*"$PW"*) die "refusing to install: $(basename "$1") would carry the client secret or the page password";; esac
}

# ---------------------------------------------------------------------------
if [ "$cmd" = apply ]; then parse_ips; fi
page_dir_check
case "$cmd" in
  apply|verify) [ ! -t 0 ] || die "the page password is read from stdin only, and a terminal is refused (typing would echo it): pipe it, op read \"op://<vault>/<item>/password\" | DDC_APPROVED=yes ./remote.sh run 50-partner-page.sh $cmd ...";;
esac
case "$cmd" in
  apply|remove) for p in "$SRV_DIR" "$PAGE_DIR" "$PAGE_DIR/index.html" "$PAGE_DIR/secret.json" "$PAGE_DIR/.index.html.new" "$PAGE_DIR/.secret.json.new"; do guard_write_path "$p"; done;;
esac
case "$cmd" in apply|verify|remove) run_begin "50-partner-page-$cmd" "$@";; esac
settings_say
if [ "$cmd" = apply ]; then settings_record; fi

case "$cmd" in
  apply)
    read_password
    old_snapshot_begin
    step "inputs (values are checked, never printed)"
    read_env
    read_secret
    secret_matches_env
    case "$PW" in *"$SECRET"*) die "the page password must not contain the client secret";; esac
    case "$SECRET" in *"$PW"*) die "the client secret must not contain the page password";; esac
    pick_image
    step "encrypt: PBKDF2-SHA256 ($ITER iterations, 16-byte salt) + AES-256-GCM (12-byte IV), round trip checked"
    json=$( { printf '%s\n' "$PW"; printf '%s\n' "$SECRET"; } | crypt encrypt "$ITER" ) || die "the encryption container failed: nothing installed"
    re_json='^[{]"v":1,"kdf":"PBKDF2-SHA256","iter":'"$ITER"',"salt":"[A-Za-z0-9+/]{22}==","iv":"[A-Za-z0-9+/]{16}","ct":"[A-Za-z0-9+/]+={0,2}"[}]$'
    [[ "$json" =~ $re_json ]] || die "the encryption container returned an unexpected document: nothing installed"
    ct="${json##*\"ct\":\"}"; ct="${ct%\"\}}"
    [ "${#ct}" = $(( (${#SECRET} + 16 + 2) / 3 * 4 )) ] || die "the ciphertext length does not match the secret: nothing installed"
    pass "secret.json: v=1 kdf=PBKDF2-SHA256 iter=$ITER salt=16 bytes iv=12 bytes ct=$(( ${#SECRET} + 16 )) bytes (secret + 16-byte tag); decrypted again in the container before this line"
    step "write $PAGE_DIR"
    TMP_HTML="$PAGE_DIR/.index.html.new"; TMP_JSON="$PAGE_DIR/.secret.json.new"
    umask 022
    mkdir -p "$PAGE_DIR"
    chmod 755 "$SRV_DIR" "$PAGE_DIR"
    trap 'rm -f "$TMP_HTML" "$TMP_JSON"' EXIT
    fill_template > "$TMP_HTML"
    printf '%s\n' "$json" > "$TMP_JSON"
    chmod 644 "$TMP_HTML" "$TMP_JSON"
    ! grep -q '{{[A-Z_]*}}' "$TMP_HTML" || die "the filled page still has a {{placeholder}}: nothing installed"
    no_leak "$TMP_HTML"; no_leak "$TMP_JSON"
    mv -f "$TMP_JSON" "$PAGE_DIR/secret.json"
    mv -f "$TMP_HTML" "$PAGE_DIR/index.html"
    trap - EXIT
    PW=""; SECRET=""; json=""
    for f in index.html secret.json; do say "$PAGE_DIR/$f mode $(fmode "$PAGE_DIR/$f") sha256=$(sha256 < "$PAGE_DIR/$f")"; done
    say "directories: $SRV_DIR mode $(fmode "$SRV_DIR"), $PAGE_DIR mode $(fmode "$PAGE_DIR")"
    old_snapshot_assert
    say "served at https://$APP_HOST/partner-info/ once the app vhost has the /partner-info/ location (30-nginx.sh apply); check: ./remote.sh run 50-partner-page.sh status"
    ;;
  verify)
    read_password
    [ -f "$PAGE_DIR/secret.json" ] || die "$PAGE_DIR/secret.json missing: run apply first"
    read_secret
    pick_image
    doc=$(<"$PAGE_DIR/secret.json")
    want=$(printf '%s' "$SECRET" | sha256)
    res=$( { printf '%s\n' "$PW"; printf '%s\n' "$doc"; printf '%s\n' "$want"; } | crypt verify ) || die "the verify container failed (secret.json unreadable?)"
    PW=""; SECRET=""
    case "$res" in match=yes|match=no) say "$res";; *) die "unexpected answer from the verify container";; esac
    [ "$res" = match=yes ]
    ;;
  remove)
    old_snapshot_begin
    if [ -d "$PAGE_DIR" ]; then rm -rf -- "$PAGE_DIR"; say "removed $PAGE_DIR"; else say "$PAGE_DIR does not exist"; fi
    if [ -d "$SRV_DIR" ] && rmdir "$SRV_DIR" 2>/dev/null; then say "removed $SRV_DIR (it was empty)"; fi
    [ ! -e "$PAGE_DIR" ] && pass "partner info page removed" || die "$PAGE_DIR still exists"
    old_snapshot_assert
    ;;
  status)
    for f in index.html secret.json; do
      if [ -f "$PAGE_DIR/$f" ]; then say "$PAGE_DIR/$f mode $(fmode "$PAGE_DIR/$f") bytes $(wc -c < "$PAGE_DIR/$f" | tr -d ' ') sha256=$(sha256 < "$PAGE_DIR/$f")"
      else say "$PAGE_DIR/$f: absent"; fi
    done
    v="$NGINX_AVAIL/$APP_HOST"
    if [ -f "$v" ]; then say "$v: /partner-info/ location count=$(grep -c 'location \^~ /partner-info/' "$v" || true) (1 once 30-nginx.sh apply has run with this package)"
    else say "$v: absent (30-nginx.sh apply)"; fi
    # What the local nginx serves for each file, compared with the file itself (sha256 of the body; nothing printed but
    # the code and the verdict). Read-only: the bodies stay in this shell.
    for pair in "/partner-info/:index.html" "/partner-info/secret.json:secret.json"; do
      u=${pair%%:*}; f=${pair#*:}
      code=$(curl -s -o /dev/null -m 10 -w '%{http_code}' -H "Host: $APP_HOST" "$NGINX_LOCAL_URL$u" || true)
      served=$( { curl -s -m 10 -H "Host: $APP_HOST" "$NGINX_LOCAL_URL$u" || true; } | sha256)
      if [ -f "$PAGE_DIR/$f" ] && [ "$code" = 200 ] && [ "$served" = "$(sha256 < "$PAGE_DIR/$f")" ]; then
        pass "local nginx: $u -> 200, served body = $f (sha256 ${served:0:12})"
      else warn "local nginx: $u -> ${code:-none}, served body sha256 ${served:0:12} is not the sha256 of $PAGE_DIR/$f ($( [ -f "$PAGE_DIR/$f" ] && sha256 < "$PAGE_DIR/$f" | cut -c1-12 || echo absent))"; fi
    done
    ;;
esac
