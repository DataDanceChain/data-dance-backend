#!/usr/bin/env bash
# run-local-tests.sh - LOCAL validation of the new-stack package (runs on the Mac; touches no server).
#   1. bash -n and shellcheck on every script
#   2. docker compose config on compose.yaml (no daemon needed)
#   3. 20-env.sh against a SYNTHETIC old env file (multi-line quoted values, comments, export prefixes,
#      duplicates, inline comments) in a scratch directory; twice (idempotency); leak check on its output;
#      compose's own env_file parser compares old and new values (counts only); the rehearsal credential
#      policy (signing keys removed, third-party credentials blanked, unknown credential fails closed).
#   4. 30-nginx.sh render + nginx -t (1.18 and stable) on SYNTHETIC vhost fixtures (test/fixtures/).
#   5. old-stack integrity (common.sh old_files_*): fake old tree, changes detected, tge-* ignored, short hashes only.
#   6. memory watchdog (common.sh run_build_watched) with a FAKE meminfo on the local Docker Desktop:
#      normal build passes; a build stopped mid-RUN when MemAvailable drops below the floor; BuildKit step
#      processes found by their cgroup (the escalation path).
#   7. JWKS pin decision (common.sh jwks_pins_decide) on script-shaped fixtures.
#   8. 10-build.sh flag gate (--overlays-reconciled / --infra-only), refuse_if_infra_only, disk_expand_verdict.
#   9. expand_check (read-only) on a real ext4 partition.
#  10. round-2 review fixes: throwaway pass signer (common.sh rehearsal_pass_signer), money-path log fields
#      (money_path_fields_check), and the SSH login guard (sshpw.sh) against a throwaway Ubuntu 22.04 sshd: a failing
#      1Password never produces a failed login on the (test) server.
# Round 3 (review of 10-04 evening), helpers in test/helpers/:
#   3c. 20-env.sh on ubuntu:jammy (mawk): output identical to macOS.
#   6b. the watchdog after the SSH session ends (closed stdout), bash 3.2 and 5.1; the disk floor.
#   6c. the RUN-step selector on fake /proc trees for both cgroup drivers (never a listed container's process).
#   6d. the watchdog on a REAL dockerd 29.1.3 with the systemd cgroup driver (privileged throwaway container).
#   10c. an askpass that cannot be created: no TCP connection, 0 failed logins (remote.sh and ro-ssh.sh copies).
#   11. ROOT mode in ubuntu:22.04 without DDC_LOCAL_TEST: write guard (first run and re-run), run lock, server log.
#   12. pass criteria that stop: p1 verify, 30-nginx apply/undo, 40-up step 8; the 99-teardown label fallback.
# Public repository (this package lives in one):
#   10e. local.env: remote.sh and survey/ro-ssh.sh refuse to connect, and do not ask 1Password, without a usable
#        local.env (missing, placeholders, empty, wrong shape); the preflight passes the git-tree apn_key.p8 hash.
#   13. test/helpers/public-repo-scan.sh: no server address, 1Password reference or id, hash or key, statement about a
#       server's security state, or local.env value in any file that is or could be committed (+ a negative control).
# Partner info page (10-05):
#   14. 50-partner-page.sh on a 20-env.sh output with a dummy secret and dummy 32-character passwords: apply, verify
#       (match=yes, and match=no for a wrong password), the refusals; no secret or password in the files, the output,
#       the server-side logs or anything ps shows (arguments and environment) during the runs; then the page behind
#       nginx:stable with the 30-nginx.sh location, driven by headless Chromium (test/helpers/partner-browser.js).
#   The stdin path of remote.sh (10c real ssh, 10e stubs): the piped password reaches the remote script, 1Password
#   never reads it, and a terminal is refused (10d).
# Every SSH test uses scratch COPIES of the scripts with a test local.env (loopback only): the package's own local.env,
# if one exists, is never used to connect, and the real 1Password CLI is never called.
# Throwaway containers and images are named *-<suffix> (DDC_TEST_SUFFIX, 8 digits, default 20261005) and removed at
# the end (KEEP_TEST_IMAGES=1 keeps the images). Existing containers are never touched.
# Usage: [DDC_TEST_SUFFIX=yyyymmdd] test/run-local-tests.sh [new-scratch-dir]
set -euo pipefail
PKG="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
T="${1:-${TMPDIR:-/tmp}/ddcnew-localtest-$(date +%Y%m%d-%H%M%S)}"; T="${T%/}"
case "$T" in /*) ;; *) T="$PWD/$T";; esac   # docker -v needs an absolute path
case "$T" in /root*|/) echo "refusing scratch dir $T"; exit 1;; esac
[ ! -e "$T" ] || { echo "scratch dir $T exists; pass a new one"; exit 1; }
SFX="${DDC_TEST_SUFFIX:-20261005}"
[[ "$SFX" =~ ^[0-9]{8}$ ]] || { echo "DDC_TEST_SUFFIX must be 8 digits"; exit 1; }
mkdir -p "$T/ddcnew"
fails=0; ok() { echo "PASS $*"; }; bad() { echo "FAIL $*"; fails=$((fails+1)); }

echo "== 1. syntax and lint"
for f in "$PKG"/*.sh "$PKG"/test/*.sh "$PKG"/test/helpers/*.sh "$PKG"/survey/*.sh; do
  if bash -n "$f"; then ok "bash -n ${f#"$PKG"/}"; else bad "bash -n ${f#"$PKG"/}"; fi
done
if command -v shellcheck >/dev/null; then
  # survey/ from its own directory: ro-ssh.sh sources ../sshpw.sh
  if (cd "$PKG" && shellcheck -x -S warning ./*.sh test/*.sh test/helpers/*.sh) && (cd "$PKG/survey" && shellcheck -x -S warning ./*.sh); then
    ok "shellcheck -x -S warning: no findings in $(ls "$PKG"/*.sh "$PKG"/test/*.sh "$PKG"/test/helpers/*.sh "$PKG"/survey/*.sh | wc -l | tr -d ' ') scripts ($(shellcheck --version | awk '/^version/ {print $2}'))"
  else bad "shellcheck findings above"; fi
else bad "shellcheck not installed"; fi
for f in "$PKG"/test/helpers/*.js; do
  if node --check "$f"; then ok "node --check ${f#"$PKG"/}"; else bad "node --check ${f#"$PKG"/}"; fi
done

echo; echo "== 2. docker compose config"
mkdir -p "$T/compose"; cp "$PKG/compose.yaml" "$T/compose/"
printf 'API_IMAGE=ddcnew/backend:0123456789ab\nWEB_IMAGE=ddcnew/web:tge-0123456789ab\n' > "$T/compose/.env"
printf 'NODE_ENV=production\n' > "$T/compose/.env.api"; printf 'POSTGRES_USER=u\nPOSTGRES_PASSWORD=p\nPOSTGRES_DB=d\n' > "$T/compose/.env.db"
if (cd "$T/compose" && docker compose -f compose.yaml config -q); then ok "compose.yaml valid"; else bad "compose.yaml invalid"; fi
(cd "$T/compose" && docker compose -f compose.yaml config --format json) | python3 -c '
import json, sys
c = json.load(sys.stdin)
print("project=%s" % c["name"])
for n, s in sorted(c["services"].items()):
    ports = ["%s:%s->%s" % (p.get("host_ip"), p.get("published"), p.get("target")) for p in s.get("ports", [])]
    vols = ["%s:%s%s" % (v["source"].split("/compose/")[-1], v["target"], ":ro" if v.get("read_only") else "") for v in s.get("volumes", [])]
    print("service=%s image=%s restart=%s ports=%s volumes=%s depends_on=%s" % (n, s["image"], s.get("restart"), ports, vols, list(s.get("depends_on", {}).keys())))
bad = [p for s in c["services"].values() for p in s.get("ports", []) if p.get("host_ip") != "127.0.0.1" or str(p.get("published")) in ("10000","9000","9001","9002","9003","15432")]
sys.exit("FAIL ports: %s" % bad if bad else 0)
' && ok "ports loopback-only and disjoint from the old stack"
(cd "$T/compose" && docker compose -f compose.yaml config --format json) | python3 -c '
import json, sys
c = json.load(sys.stdin)["services"]
got = {n: (str(s.get("mem_limit")), s.get("oom_score_adj")) for n, s in c.items()}
want = {"api": ("1073741824", 500), "db": ("1073741824", 500), "web": ("134217728", 500)}
print("memory: %s" % sorted(got.items()))
sys.exit(0 if got == want else "FAIL memory settings %s" % got)
' && ok "mem_limit api 1g, db 1g, web 128m (2.1 GB in all) and oom_score_adj 500 on every ddcnew service" || bad "compose memory settings"

echo; echo "== 3. 20-env.sh on a synthetic old env file"
OLD="$T/backend.env"
# SYNTHETIC input. Names: the variable names the old env file uses, which the 20-env.sh policy classifies, plus edge
# cases. Values are test inputs chosen to exercise the rewrite (for example 'log' modes that 20-env.sh must switch to
# 'enforce'); they describe no server. Every secret-looking value contains DUMMYSECRET so a leak is easy to find.
cat > "$OLD" <<'EOF'
# synthetic backend.env for the local test - dummy values only
DATABASE_URL="postgresql://olduser:DUMMYSECRET-dbpw@ddc-backend-db:5432/ddc?schema=public"
JWT_SECRET="DUMMYSECRET-jwt"
JWT_EXPIRES_IN=7d
PORT=3000
NODE_ENV=production
export API_BASE_URL=https://api.datadance.ai
PASS_TYPE_ID=pass.ai.datadance.dummy
APNS_KEY_ID=DUMMYKEYID
APNS_TEAM_ID=DUMMYTEAM
GOOGLE_WALLET_ISSUER_ID=1234567890
GOOGLE_WALLET_SERVICE_ACCOUNT=svc@example.iam.gserviceaccount.com
# multi-line double-quoted value with an escaped quote and a '#' and '=' inside
GOOGLE_WALLET_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----
DUMMYSECRET-pk-line1 = not a \"name\" still inside
DUMMYSECRET-pk-line2 # not a comment
-----END PRIVATE KEY-----"
TEST_USER_EMAIL=test@example.com
INVOICE_SELLER_ADDRESS="DataDance Ltd \"HQ\"
1 Example Road # not a comment
Singapore"
X_CLIENT_ID=DUMMYSECRET-xid
X_CLIENT_SECRET='DUMMYSECRET-xsecret'
X_BEARER_TOKEN="DUMMYSECRET-bearer"   # inline comment after a quoted value
X_OAUTH_CALLBACK_URL=https://api.datadance.ai/api/x/callback
X_API_URL=https://api.x.com/2
X_RATE_LIMIT_WINDOW=900000
X_MAX_REQUESTS_PER_WINDOW=300
BACKEND_WALLET_PRIVATE_KEY=0xDUMMYSECRETbackendwallet
DDC_CHAIN_RPC_URL=https://rpc.example.invalid
DDC_CHAIN_ID=44508
METADATA_BASE_URL=https://api.datadance.ai/metadata
FRONTEND_URL="https://app.datadance.ai,https://business.datadance.ai"
DISABLE_REFERRAL_REWARDS_FEATURES=false
OPS_ADMIN_USERNAME=dummy-ops-user
OPS_ADMIN_PASSWORD="DUMMYSECRET-opspw"
OPS_ADMIN_TOKEN_EXPIRES=12h
PUBLIC_BASE_URL=https://api.datadance.ai
APP_PUBLIC_URL=https://app.datadance.ai
GEMINI_API_KEY=DUMMYSECRET-gemini
GEMINI_DEFAULT_MODEL=gemini-dummy
WEB3AUTH_VERIFY_MODE=log
WEB3AUTH_CLIENT_ID=BGiGcxrXA-dummy-devnet-client-id-000000000000000000
WEB3AUTH_ALLOWED_VERIFIERS=web3auth-google-sapphire-devnet,external-wallet
WEB3AUTH_LEGACY_VERIFIERS=old-verifier
WEB3AUTH_JWKS_URL=https://api-auth.web3auth.io/jwks
WEB3AUTH_ISSUERS=https://api-auth.web3auth.io
WEB3AUTH_EXTERNAL_JWKS_URL=https://authjs.web3auth.io/jwks
WEB3AUTH_EXTERNAL_ISSUERS=https://authjs.web3auth.io
WEB3AUTH_JWKS_PIN_MODE=log
WEB3AUTH_JWKS_PINNED_THUMBPRINTS=dummyThumbprintA,dummyThumbprintB
WEB3AUTH_ALLOW_LEGACY_FALLBACK=true
WEB3AUTH_ALGS=ES256
SSO_ENVIRONMENT=prod
SSO_TGE_ENABLED=false
SSO_TGE_CLIENT_ID=tge-old
SSO_TGE_CLIENT_NAME="DDC TGE old"
SSO_TGE_CLIENT_SECRET_SHA256=DUMMYSECRET-oldhash
SSO_TGE_STATUS_FIELDS=registered_at,wallet_bound
SSO_REQUIRE_VERIFIED_SESSION=false
SSO_SESSION_SECRET="DUMMYSECRET-ssosession"
SSO_TICKET_TTL_SEC=60
SSO_SESSION_TTL_SEC=3600

# edge cases the real file does not have today
export SMTP_HOST=smtp.example.com
SMTP_PASS='DUMMYSECRET-smtp
second line of a single-quoted multi-line value'
BSC_PAYOUT_PRIVATE_KEY=DUMMYSECRET-bsc
GEMINI_DEFAULT_MODEL=gemini-dummy-2
CHAIN_SIGNER_PRIVATE_KEY="0xDUMMYSECRETchainsigner"
WALLET_MNEMONIC="DUMMYSECRET abandon abandon about"
UNUSED_TOKEN=
EOF
# SYNTHETIC frontend .env.tge: the two names 20-env.sh reads (the mainnet Web3Auth client id prefix it checks is a
# public value of the tge build; 10-build.sh and 20-env.sh check the real file on the server).
printf '%s\n' '# synthetic .env.tge for the local test' 'VITE_MODE=tge' 'VITE_WEB3AUTH_NETWORK=mainnet' \
  'VITE_WEB3AUTH_CLIENT_ID="BBpkxUTUr-synthetic-local-test-client-id"' > "$T/env.tge"
echo "synthetic old file: $(grep -c . "$OLD") non-empty lines, $(grep -c DUMMYSECRET "$OLD") lines with DUMMYSECRET markers"

run20() { DDC_LOCAL_TEST=1 NEW_DIR="$T/ddcnew" OLD_ENV="$OLD" FE_ENV_TGE="$T/env.tge" bash "$PKG/20-env.sh"; }
run20 > "$T/run1.out" 2>&1 || { cat "$T/run1.out"; bad "20-env.sh run 1 failed"; }
run20 > "$T/run2.out" 2>&1 || { cat "$T/run2.out"; bad "20-env.sh run 2 failed"; }
echo "--- 20-env.sh output (run 1) ---"; cat "$T/run1.out"; echo "--- end ---"
h1=$(grep -o 'env_file_sha256=[0-9a-f]*' "$T/run1.out" || true); h2=$(grep -o 'env_file_sha256=[0-9a-f]*' "$T/run2.out" || true)
[ -n "$h1" ] && [ "$h1" = "$h2" ] && ok "idempotent: run 2 produced the same file ($h1)" || bad "run 2 differs ($h1 vs $h2)"
grep -q 'reused db_password' "$T/run2.out" && ok "run 2 reused the generated secrets" || bad "run 2 regenerated secrets"

echo; echo "== leak check on everything 20-env.sh printed"
leaks=$(cat "$T/run1.out" "$T/run2.out" | grep -c 'DUMMYSECRET' || true)
[ "$leaks" = 0 ] && ok "no DUMMYSECRET marker in the output" || bad "$leaks output lines carry a dummy secret"
for s in "$T"/ddcnew/secrets/*; do
  n=$(cat "$T/run1.out" "$T/run2.out" | grep -cF "$(cat "$s")" || true)
  [ "$n" = 0 ] && ok "generated $(basename "$s") not in the output" || bad "generated $(basename "$s") printed"
done
n=$(cat "$T/run1.out" "$T/run2.out" | grep -cF "$(sed -n 's/^SSO_TGE_CLIENT_SECRET_SHA256="\(.*\)"$/\1/p' "$T/ddcnew/.env.rehearsal")" || true)
[ "$n" = 0 ] && ok "the TGE secret hash itself is not printed either" || bad "TGE hash printed"
nlogs=$(ls "$T"/ddcnew/logs/*-20-env-*.log 2>/dev/null | wc -l | tr -d ' ')
leaks=$(cat "$T"/ddcnew/logs/*.log | grep -c 'DUMMYSECRET' || true); for s in "$T"/ddcnew/secrets/*; do leaks=$((leaks + $(cat "$T"/ddcnew/logs/*.log | grep -cF "$(cat "$s")" || true))); done
m=0; for o in "$T/run1.out" "$T/run2.out"; do for l in "$T"/ddcnew/logs/*-20-env-*.log; do if cmp -s "$o" "$l" && [ "$(stat -f %Lp "$l")" = 600 ]; then m=$((m + 1)); break; fi; done; done
[ "$nlogs" = 2 ] && [ "$m" = 2 ] && [ "$leaks" = 0 ] \
  && ok "server-side logs: one per run (600), each byte-identical to what its run printed, no dummy or generated secret in them" || bad "server-side logs of 20-env.sh (logs=$nlogs matching=$m leaks=$leaks)"
for f in .env.rehearsal .env.db secrets secrets/db_password; do echo "mode $f=$(stat -f %Lp "$T/ddcnew/$f")"; done

echo; echo "== compose's own env_file parser: old vs new (counts only)"
mkdir -p "$T/parse"; cp "$OLD" "$T/parse/old.env"; cp "$T/ddcnew/.env.rehearsal" "$T/parse/new.env"
cat > "$T/parse/compose.yaml" <<'EOF'
services:
  old: { image: busybox, env_file: old.env }
  new: { image: busybox, env_file: new.env }
EOF
(cd "$T/parse" && docker compose config --format json) | python3 -c '
import json, sys
c = json.load(sys.stdin)
o = c["services"]["old"]["environment"]; n = c["services"]["new"]["environment"]
sets = """GOOGLE_WALLET_ISSUER_ID GOOGLE_WALLET_SERVICE_ACCOUNT GEMINI_API_KEY X_CLIENT_ID X_CLIENT_SECRET X_BEARER_TOKEN DATABASE_URL PUBLIC_BASE_URL APP_PUBLIC_URL FRONTEND_URL API_BASE_URL JWT_SECRET WEB3AUTH_CLIENT_ID WEB3AUTH_ALLOWED_VERIFIERS
WEB3AUTH_LEGACY_VERIFIERS WEB3AUTH_EXTERNAL_AUDIENCE WEB3AUTH_VERIFY_MODE WEB3AUTH_ALLOW_LEGACY_FALLBACK WEB3AUTH_WALLET_MATCH
WEB3AUTH_JWKS_PIN_MODE WEB3AUTH_NETWORK_REBIND WEB3AUTH_REBIND_VERIFIERS WEB3AUTH_EMAIL_TRUSTED_VERIFIERS SSO_TGE_ENABLED SSO_ENVIRONMENT
SSO_TGE_CLIENT_ID SSO_TGE_CLIENT_NAME SSO_TGE_CLIENT_SECRET_SHA256 SSO_TGE_REDIRECT_URIS SSO_TGE_INITIATE_LOGIN_URI SSO_SESSION_SECRET
SSO_TGE_AUTO_APPROVE SSO_TGE_REFERRAL_BIND SSO_TGE_APP_PRESENTATION SSO_TGE_STATUS_FIELDS SSO_REQUIRE_VERIFIED_SESSION
OAUTH_PUBLIC_REGISTRATION_ENABLED DISBURSEMENT_PAUSED SMTP_HOST SMTP_PASS""".split()
kept = [k for k in n if k not in sets]
same = [k for k in kept if o.get(k) == n.get(k)]
print("compose parsed: old=%d names, new=%d names, kept=%d, kept identical=%d" % (len(o), len(n), len(kept), len(same)))
ml = o.get("INVOICE_SELLER_ADDRESS", "")
print("multi-line INVOICE_SELLER_ADDRESS (kept): old lines=%d, new identical=%s" % (ml.count("\n") + 1, n.get("INVOICE_SELLER_ADDRESS") == ml))
print("duplicate GEMINI_DEFAULT_MODEL keeps the last value: %s" % (n.get("GEMINI_DEFAULT_MODEL") == o.get("GEMINI_DEFAULT_MODEL") == "gemini-dummy-2"))
gone = [k for k in ("BSC_PAYOUT_PRIVATE_KEY", "BACKEND_WALLET_PRIVATE_KEY", "CHAIN_SIGNER_PRIVATE_KEY", "GOOGLE_WALLET_PRIVATE_KEY", "WALLET_MNEMONIC",
                    "SSO_TICKET_TTL_SEC", "SSO_SESSION_TTL_SEC", "WEB3AUTH_ALGS") if k in n]
print("removed names absent from new: %s" % (not gone))
exp = {"DISBURSEMENT_PAUSED": "true", "SMTP_HOST": "", "SMTP_PASS": "", "WEB3AUTH_NETWORK_REBIND": "on", "WEB3AUTH_VERIFY_MODE": "enforce",
       "WEB3AUTH_ALLOW_LEGACY_FALLBACK": "false", "WEB3AUTH_JWKS_PIN_MODE": "enforce", "SSO_TGE_ENABLED": "true", "SSO_TGE_CLIENT_ID": "tge-rehearsal",
       "PUBLIC_BASE_URL": "https://tge-api.datadance.ai", "APP_PUBLIC_URL": "https://tge-app.datadance.ai", "SSO_TGE_CLIENT_NAME": "DDC TGE",
       "WEB3AUTH_JWKS_PINNED_THUMBPRINTS": o.get("WEB3AUTH_JWKS_PINNED_THUMBPRINTS"),
       "X_CLIENT_ID": "", "X_CLIENT_SECRET": "", "X_BEARER_TOKEN": "", "GEMINI_API_KEY": "", "GOOGLE_WALLET_ISSUER_ID": "",
       "GOOGLE_WALLET_SERVICE_ACCOUNT": "", "APNS_KEY_ID": o.get("APNS_KEY_ID"), "APNS_TEAM_ID": o.get("APNS_TEAM_ID"),
       "OPS_ADMIN_PASSWORD": o.get("OPS_ADMIN_PASSWORD"), "X_API_URL": o.get("X_API_URL"), "UNUSED_TOKEN": ""}
wrong = [k for k, v in exp.items() if n.get(k) != v]
print("expected rehearsal values: %d checked, wrong=%s" % (len(exp), wrong))
print("WEB3AUTH_CLIENT_ID prefix=%s" % n["WEB3AUTH_CLIENT_ID"][:9])
dummy = sorted(k for k, v in n.items() if "DUMMYSECRET" in v)
print("names whose rehearsal value still carries a production (DUMMYSECRET) value: %s (allowed: OPS_ADMIN_PASSWORD only)" % dummy)
ok = len(same) == len(kept) and n.get("INVOICE_SELLER_ADDRESS") == ml and not gone and not wrong and n["WEB3AUTH_CLIENT_ID"].startswith("BBpkxUTUr") and dummy == ["OPS_ADMIN_PASSWORD"]
sys.exit(0 if ok else "FAIL compose parse comparison")
' && ok "compose parses both files; kept values identical, rehearsal values as expected" || bad "compose parse comparison"

echo; echo "== 3b. credential policy: an unclassified credential with a value must stop 20-env.sh"
grep -E 'PASS no private-key|BACKEND_WALLET_PRIVATE_KEY and CHAIN_SIGNER|blanked third-party|every credential-like name' "$T/run1.out" || true
grep -q 'PASS no private-key / mnemonic name left' "$T/run1.out" && grep -q 'blanked third-party credentials: .*X_BEARER_TOKEN' "$T/run1.out" && ok "policy lines present in the 20-env.sh output" || bad "policy lines missing"
grep -q 'PASS every name with a value is classified' "$T/run1.out" && grep -q 'PASS no copied value carries' "$T/run1.out" && ok "every name classified; no copied value carries a credential (synthetic env)" || bad "classification lines missing"
# Negative cases (round 2 review): each line is appended to the synthetic env (a later duplicate wins) in its own run.
#   stop:<name>    20-env.sh must stop, print the name, print no value, and leave NO .env.rehearsal / .tmp behind
#   remove:<name>  signing-key-like name: removed (listed), value absent from .env.rehearsal, run passes
neg() { # <expect> <line>
  local exp="$1" line="$2" n d rc=0
  n="${line%%=*}"; d="$T/neg-$n"; mkdir -p "$d/ddcnew"; cp "$OLD" "$d/old.env"; printf '%s\n' "$line" >> "$d/old.env"
  DDC_LOCAL_TEST=1 NEW_DIR="$d/ddcnew" OLD_ENV="$d/old.env" FE_ENV_TGE="$T/env.tge" bash "$PKG/20-env.sh" > "$d/out" 2>&1 || rc=$?
  if grep -q DUMMYSECRET "$d/out" || cat "$d"/ddcnew/logs/*.log 2>/dev/null | grep -q DUMMYSECRET; then bad "$n: a value was printed (output or server-side log)"; return; fi
  case "$exp" in
    stop) if [ "$rc" != 0 ] && grep -q "^FAIL .*$n" "$d/out" && [ ! -e "$d/ddcnew/.env.rehearsal" ] && [ ! -e "$d/ddcnew/.env.rehearsal.tmp" ]; then
            ok "$n stops 20-env.sh: $(grep -m1 "^FAIL .*$n" "$d/out" | cut -c1-70)...; no .env.rehearsal written"
          else bad "$n: rc=$rc, rehearsal file present=$([ -e "$d/ddcnew/.env.rehearsal" ] && echo yes || echo no)"; fi;;
    remove) if [ "$rc" = 0 ] && grep -q "removed: .*$n" "$d/out" && ! grep -q "^$n=" "$d/ddcnew/.env.rehearsal" && [ "$(grep -c DUMMYSECRET "$d/ddcnew/.env.rehearsal")" = 1 ]; then
            ok "$n is removed as a signing key (only OPS_ADMIN_PASSWORD keeps a production value)"
          else bad "$n: rc=$rc, not removed"; fi;;
  esac
}
neg remove 'HOT_WALLET_PRIVATEKEY=0xDUMMYSECREThotwallet'
neg remove 'DEPLOYER_PK=DUMMYSECRET-deployer'
neg stop 'APIKEY=DUMMYSECRET-apikey'
neg stop 'OSS_ACCESSKEYSECRET=DUMMYSECRET-oss'
neg stop 'REDIS_URL=redis://:DUMMYSECRET@redis:6379/0'
neg stop 'SENTRY_DSN=https://DUMMYSECRETkey@o1.ingest.sentry.io/1'
neg stop 'SLACK_WEBHOOK_URL=https://hooks.slack.com/services/T0/B0/DUMMYSECRET'
neg stop 'NEWVENDOR_API_KEY=DUMMYSECRET-newvendor'
# value shape on KNOWN names (kept-plain list): URL credentials, a 0x / bare 64-hex key, a PEM private key block
neg stop 'X_API_URL=https://user:DUMMYSECRET@api.x.com/2'
neg stop "GEMINI_DEFAULT_MODEL=0x$(printf 'ab%.0s' $(seq 1 32))"
neg stop "DDC_CHAIN_ID=$(printf 'cd%.0s' $(seq 1 32))"
neg stop "$(printf 'TEST_USER_EMAIL="-----BEGIN EC PRIVATE KEY-----\nDUMMYSECRET\n-----END EC PRIVATE KEY-----"')"
# a failing run also removes a PREVIOUS .env.rehearsal (built from the same old env, it may carry the same problem)
d="$T/neg-prev"; mkdir -p "$d"; cp -R "$T/ddcnew" "$d/ddcnew"; cp "$OLD" "$d/old.env"; printf 'APIKEY=DUMMYSECRET-apikey\n' >> "$d/old.env"
[ -f "$d/ddcnew/.env.rehearsal" ] || bad "setup: no previous .env.rehearsal"
if DDC_LOCAL_TEST=1 NEW_DIR="$d/ddcnew" OLD_ENV="$d/old.env" FE_ENV_TGE="$T/env.tge" bash "$PKG/20-env.sh" > "$d/out" 2>&1; then bad "previous-file case passed"
else [ ! -e "$d/ddcnew/.env.rehearsal" ] && grep -q 'FAIL removed .*\.env\.rehearsal' "$d/out" && ok "a failing run removes the previous .env.rehearsal too (40-up.sh then refuses to start)" || bad "previous .env.rehearsal kept after a failing run"; fi

echo; echo "== 3c. 20-env.sh on Ubuntu 22.04 (ubuntu:jammy: mawk, GNU coreutils/grep/sed): output identical to the macOS run"
# Same inputs and the same generated secrets as macOS run 2 (a copy of its NEW_DIR), every path mounted at the same
# place, a stub docker that lists no container (like the Mac, which has no ddc-* container). Only the run/lock lines
# may differ (pid, log name, flock is not installed on the Mac).
if docker info >/dev/null 2>&1; then
  J="$T/jammy"; mkdir -p "$J/bin"; cp -Rp "$T/ddcnew" "$J/ddcnew"; rm -rf "$J/ddcnew/logs"
  printf '#!/bin/sh\nexit 0\n' > "$J/bin/docker"; chmod 755 "$J/bin/docker"
  jrc=0; docker run --rm --name "env20-$RANDOM-$SFX" --user "$(id -u):$(id -g)" -e DDC_LOCAL_TEST=1 -e NEW_DIR="$T/ddcnew" -e OLD_ENV="$OLD" -e FE_ENV_TGE="$T/env.tge" \
    -v "$PKG:$PKG:ro" -v "$J/ddcnew:$T/ddcnew" -v "$OLD:$OLD:ro" -v "$T/env.tge:$T/env.tge:ro" -v "$J/bin:/stubbin:ro" ubuntu:jammy \
    bash -c 'export PATH="/stubbin:$PATH"; exec bash "$0/20-env.sh"' "$PKG" > "$J/run3.out" 2>&1 || jrc=$?
  awkv=$(docker run --rm --name "awkv-$RANDOM-$SFX" ubuntu:jammy bash -c 'readlink -f "$(command -v awk)"; awk -W version 2>&1 | head -1' | tr '\n' ' ')
  norm() { grep -vE '^(run|lock): ' "$1"; }
  if [ "$jrc" = 0 ] && diff <(norm "$T/run2.out") <(norm "$J/run3.out") > "$J/diff.txt"; then
    ok "20-env.sh on ubuntu:jammy ($awkv) prints exactly what it printed on macOS ($(norm "$J/run3.out" | wc -l | tr -d ' ') lines; run/lock lines excluded)"
  else sed 's/^/  diff> /' "$J/diff.txt"; tail -5 "$J/run3.out"; bad "20-env.sh output on ubuntu:jammy differs from macOS (rc=$jrc)"; fi
  cmp -s "$T/ddcnew/.env.rehearsal" "$J/ddcnew/.env.rehearsal" && cmp -s "$T/ddcnew/.env.db" "$J/ddcnew/.env.db" \
    && ok ".env.rehearsal and .env.db written on ubuntu:jammy are byte-identical to the macOS ones" || bad "files written on ubuntu:jammy differ"
  grep -rq DUMMYSECRET "$J/ddcnew/logs" && bad "the ubuntu:jammy server-side log carries a dummy secret" || ok "ubuntu:jammy server-side log: no DUMMYSECRET marker"
else bad "section 3c needs Docker Desktop"; fi

echo; echo "== 4. nginx copies (30-nginx.sh render) from the SYNTHETIC vhost fixtures in test/fixtures/"
NG="$T/nginx"; mkdir -p "$NG"
if DDC_LOCAL_TEST=1 NEW_DIR="$T/ddcnew" bash "$PKG/30-nginx.sh" render "$PKG/test/fixtures/api.datadance.co" "$PKG/test/fixtures/app.datadance.co" "$NG" > "$T/render.out" 2>&1; then
  cat "$T/render.out"; ok "render checks passed"
else cat "$T/render.out"; bad "render failed"; fi
# The partner info page location (section 14 serves the page through it): tge-app only, once, with these exact headers.
CSP="default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'"
miss=""
for l in 'location ^~ /partner-info/ {' 'alias /srv/ddcnew/partner-info/;' 'add_header Cache-Control "no-store" always;' \
         'add_header X-Robots-Tag "noindex, nofollow" always;' 'add_header Referrer-Policy "no-referrer" always;' \
         'add_header X-Frame-Options "DENY" always;' "add_header Content-Security-Policy \"$CSP\" always;"; do
  [ "$(grep -cF -- "$l" "$NG/tge-app.datadance.ai" || true)" = 1 ] || miss="$miss [$l]"
done
[ -z "$miss" ] && [ "$(grep -c 'partner-info' "$NG/tge-api.datadance.ai" || true)" = 0 ] \
  && ok "tge-app copy: one /partner-info/ location (alias /srv/ddcnew/partner-info/, no-store, noindex, no-referrer, DENY, the CSP); tge-api copy: none" \
  || bad "partner-info location in the rendered copies; missing or repeated:$miss"
if docker info >/dev/null 2>&1; then
  mkdir -p "$NG/conf"
  cp "$PKG/test/fixtures/api.datadance.co" "$PKG/test/fixtures/app.datadance.co" "$NG/tge-api.datadance.ai" "$NG/tge-app.datadance.ai" "$NG/conf/"
  printf 'events {}\nhttp {\n  include /etc/nginx/mime.types;\n  include /etc/nginx/sites/*;\n}\n' > "$NG/nginx.conf"
  for variant in old-only with-tge; do
    [ "$variant" = old-only ] && sel="api.datadance.co app.datadance.co" || sel="api.datadance.co app.datadance.co tge-api.datadance.ai tge-app.datadance.ai"
    mkdir -p "$NG/$variant"; for f in $sel; do cp "$NG/conf/$f" "$NG/$variant/"; done
    for img in nginx:1.18 nginx:stable; do   # 1.18 = the Ubuntu 22.04 server's major version
      if docker run --rm --name "nginxtest-$variant-${img#nginx:}-$SFX" -v "$NG/nginx.conf:/etc/nginx/nginx.conf:ro" -v "$NG/$variant:/etc/nginx/sites:ro" "$img" nginx -t > "$T/nginx-$variant.out" 2>&1; then
        ok "nginx -t $img ($variant): $(tail -1 "$T/nginx-$variant.out")"
      else cat "$T/nginx-$variant.out"; bad "nginx -t $img ($variant)"; fi
    done
  done
else
  echo "docker daemon not running: nginx -t on the rendered files skipped"
fi

# ---------------------------------------------------------------------------
echo; echo "== 5. old-stack integrity: files (common.sh old_files_snapshot / old_snapshot_assert)"
O="$T/oldtree"; mkdir -p "$O/ddc-backend/overlays/sub" "$O/ddc" "$O/nginx/sites-available"
printf 'A=1\n' > "$O/ddc-backend/backend.env"; printf 'services: {}\n' > "$O/ddc-backend/docker-compose.yaml"; printf 'services: {}\n' > "$O/ddc/docker-compose.yml"
printf 'x\n' > "$O/ddc-backend/overlays/a.js"; printf 'y\n' > "$O/ddc-backend/overlays/sub/b.js"
for v in api.datadance.co app.datadance.co admin.datadance.co tge-api.datadance.ai; do printf 'server {}\n' > "$O/nginx/sites-available/$v"; done
integ() { ( DDC_LOCAL_TEST=1; NEW_DIR="$T/ddcnew"; OLD_BACKEND_DIR="$O/ddc-backend"; OLD_APP_DIR="$O/ddc"; OLD_ENV="$O/ddc-backend/backend.env"; NGINX_AVAIL="$O/nginx/sites-available"
  # shellcheck source=../common.sh
  . "$PKG/common.sh"; OLD_FILES_BEFORE="$(old_files_snapshot)"; "$@"; old_files_compare ); }
n=$( ( DDC_LOCAL_TEST=1; OLD_BACKEND_DIR="$O/ddc-backend"; OLD_APP_DIR="$O/ddc"; OLD_ENV="$O/ddc-backend/backend.env"; NGINX_AVAIL="$O/nginx/sites-available"; . "$PKG/common.sh"; old_files_snapshot ) | grep -c .)
[ "$n" = 8 ] && ok "fingerprinted 8 files (backend.env, 2 compose, 2 overlays incl. subdir, 3 old vhosts; tge-api excluded)" || bad "expected 8 fingerprinted files, got $n"
integ true > "$T/integ0.out" 2>&1 && ok "no change -> compare passes" || bad "no change reported a difference"
integ sh -c "printf 'changed\n' >> '$O/nginx/sites-available/tge-api.datadance.ai'; printf 'z\n' > '$O/nginx/sites-available/tge-app.datadance.ai.new'" > "$T/integ1.out" 2>&1 && ok "changes to tge-* files are ignored" || bad "tge-* change was reported"
if integ sh -c "printf 'B=2\n' >> '$O/ddc-backend/backend.env'; printf 'w\n' >> '$O/ddc-backend/overlays/sub/b.js'; rm '$O/ddc/docker-compose.yml'; printf 'new\n' > '$O/nginx/sites-available/business.datadance.co'" > "$T/integ2.out" 2>&1; then bad "changes not detected"
else
  sed 's/^/  expected> /' "$T/integ2.out"
  c=$(grep -cE '^  (before|after ) ' "$T/integ2.out" || true)
  long=$(grep -cE '[0-9a-f]{13,}' "$T/integ2.out" || true)
  [ "$c" = 7 ] && [ "$long" = 0 ] && grep -q 'MISSING .*docker-compose.yml' "$T/integ2.out" && ! grep -qE 'B=2|^w$' "$T/integ2.out" && ok "4 changes detected (edit, overlay edit, removal, new vhost): 7 before/after lines, 12-char hashes only, no file content" || bad "diff output wrong (lines=$c long_hashes=$long)"
fi
if ( DDC_LOCAL_TEST=1; NEW_DIR="$T/ddcnew"; OLD_BACKEND_DIR="$O/ddc-backend"; OLD_APP_DIR="$O/ddc"; OLD_ENV="$O/ddc-backend/backend.env"; NGINX_AVAIL="$O/nginx/sites-available"
     . "$PKG/common.sh"; old_snapshot_begin; printf 'C=3\n' >> "$O/ddc-backend/backend.env"; old_snapshot_assert ) > "$T/integ3.out" 2>&1; then bad "old_snapshot_assert did not fail"
else
  sed 's/^/  expected> /' "$T/integ3.out"
  grep -q 'teammate may have changed' "$T/integ3.out" && grep -q '^FAIL old-stack integrity check failed' "$T/integ3.out" && ok "old_snapshot_assert FAILS loudly and names a possible teammate change" || bad "old_snapshot_assert message wrong"
fi

# ---------------------------------------------------------------------------
echo; echo "== 6. memory watchdog (fake meminfo, local Docker Desktop only)"
if docker info >/dev/null 2>&1; then
  WD="$T/wd"; mkdir -p "$WD/ok" "$WD/kill" "$WD/sel"
  printf 'FROM nginx:stable\nRUN echo watchdog-ok > /wd-ok\n' > "$WD/ok/Dockerfile"
  printf 'FROM nginx:stable\nRUN sleep 4242\n' > "$WD/kill/Dockerfile"
  printf 'FROM nginx:stable\nRUN sleep 4243\n' > "$WD/sel/Dockerfile"
  hi() { printf 'MemTotal:       16000000 kB\nMemAvailable:    8000000 kB\n' > "$WD/meminfo"; }
  lo() { printf 'MemTotal:       16000000 kB\nMemAvailable:     512000 kB\n' > "$WD/meminfo"; }
  vmps() { docker run --rm --pid=host --name "wdps-$RANDOM-$SFX" node:22-alpine ps -o pid,args 2>/dev/null; }
  wdrun() { ( DDC_LOCAL_TEST=1; NEW_DIR="$T/ddcnew"; DDC_MEMINFO="$WD/meminfo"; BUILD_WATCH_INTERVAL=1
    # shellcheck source=../common.sh
    . "$PKG/common.sh"; run_build_watched "$@" ); }
  hi
  if wdrun "$WD/ok.log" --no-cache -t ddcnew-wdtest:ok-$SFX "$WD/ok" > "$T/wd-ok.out" 2>&1; then
    cat "$T/wd-ok.out"; docker image inspect ddcnew-wdtest:ok-$SFX >/dev/null 2>&1 && ok "normal build under the watchdog passes and tags the image" || bad "image missing"
  else cat "$T/wd-ok.out"; bad "normal build under the watchdog failed"; fi
  hi
  ( for _ in $(seq 1 90); do vmps | grep -q 'sleep 4242' && { echo "test: sleep 4242 (the RUN step) is running; MemAvailable -> 500MB"; lo; exit 0; }; sleep 1; done; echo "test: RUN step never seen"; lo ) > "$T/wd-flip.out" 2>&1 &
  flip=$!
  t0=$(date +%s); rc=0
  wdrun "$WD/kill.log" --no-cache -t ddcnew-wdtest:kill-$SFX "$WD/kill" > "$T/wd-kill.out" 2>&1 || rc=$?
  t1=$(date +%s); wait "$flip" || true
  cat "$T/wd-flip.out"; sed 's/^/  expected> /' "$T/wd-kill.out"
  left=1; for _ in $(seq 1 15); do vmps | grep -q 'sleep 4242' || { left=0; break; }; sleep 1; done
  [ "$rc" != 0 ] && grep -q 'BUILD STOPPED BY THE WATCHDOG: MemAvailable' "$T/wd-kill.out" && grep -q 'RUN step) is running' "$T/wd-flip.out" && [ "$left" = 0 ] && ! docker image inspect ddcnew-wdtest:kill-$SFX >/dev/null 2>&1 \
    && ok "watchdog stopped the build during RUN sleep 4242: exit=$rc after $((t1-t0))s, step process gone, no image tagged" || bad "watchdog kill test (rc=$rc left=$left)"
  # escalation path: are BuildKit step processes found by their cgroup? (plain build, no watchdog)
  docker build --no-cache -t ddcnew-wdtest:sel-$SFX "$WD/sel" > "$WD/sel.log" 2>&1 &
  sel=$!
  for _ in $(seq 1 90); do vmps | grep -q 'sleep 4243' && break; sleep 1; done
  docker run --rm --pid=host --cgroupns=host --privileged -v "$PKG:/pkg:ro" --name "wdsel-$RANDOM-$SFX" --entrypoint bash nginx:stable -c \
    '. /pkg/common.sh; for p in $(buildkit_step_pids); do printf "pid=%s cgroup=%s cmd=" "$p" "$(cut -d: -f3 /proc/$p/cgroup | head -1)"; tr "\0" " " < /proc/$p/cmdline; echo; done
     echo "oom_marked=$(buildkit_oom_prefer)"; for p in $(buildkit_step_pids); do echo "oom pid=$p adj=$(cat /proc/$p/oom_score_adj)"; done' > "$T/wd-sel.out" 2>&1 || true
  cat "$T/wd-sel.out"
  if grep -q 'cmd=sleep 4243' "$T/wd-sel.out" && ! grep -qE 'cmd=[^ ]*(dockerd|containerd)' "$T/wd-sel.out"; then
    docker run --rm --pid=host --cgroupns=host --privileged -v "$PKG:/pkg:ro" --name "wdkill-$RANDOM-$SFX" --entrypoint bash nginx:stable -c \
      '. /pkg/common.sh; for p in $(buildkit_step_pids); do grep -q "sleep" /proc/$p/cmdline 2>/dev/null && kill -KILL "$p" && echo "killed step pid $p"; done' || true
    src=0; wait "$sel" || src=$?
    [ "$src" != 0 ] && ok "buildkit_step_pids finds the RUN step by cgroup (not dockerd/containerd); SIGKILL on it fails the build (exit $src)" || bad "build survived the step kill"
    grep -q '^oom_marked=[1-9]' "$T/wd-sel.out" && ! grep -E '^oom pid=' "$T/wd-sel.out" | grep -vq 'adj=1000$' && ok "buildkit_oom_prefer sets oom_score_adj=1000 on every BuildKit step process ($(grep -c '^oom pid=' "$T/wd-sel.out"))" || bad "oom_score_adj not set on the step processes"
  else
    kill "$sel" 2>/dev/null || true; wait "$sel" 2>/dev/null || true
    bad "buildkit_step_pids did not find the RUN step (see above)"
  fi
  for i in ok kill sel; do docker image rm "ddcnew-wdtest:$i-$SFX" >/dev/null 2>&1 || true; done
  echo "test images ddcnew-wdtest:*-$SFX removed; leftover test containers: $(docker ps -a --format '{{.Names}}' | grep -c -- "-$SFX\$" || true)"
else
  echo "docker daemon not running: watchdog test skipped"; bad "watchdog test needs Docker Desktop"
fi
# MemAvailable unreadable -> treated as low (fail closed)
r=$( ( DDC_LOCAL_TEST=1; DDC_MEMINFO="$T/does-not-exist"; . "$PKG/common.sh"; printf 'mem=[%s]' "$(mem_avail_mb)" ) )
[ "$r" = "mem=[]" ] && ok "unreadable meminfo gives an empty value (run_build_watched treats it as low)" || bad "unreadable meminfo: $r"

# ---------------------------------------------------------------------------
echo; echo "== 6b. watchdog after the SSH session ends (stdout/stderr closed mid-build), bash 3.2 (macOS) and 5.1 (ubuntu:22.04)"
# remote.sh allocates no tty: a dropped connection sends no SIGHUP, and the next write used to kill the script with
# SIGPIPE before kill_build ran (round 3 review). test/helpers/closed-session.sh: stub docker build, fake meminfo,
# a FIFO reader that goes away after the first two lines, then MemAvailable falls below the floor.
cs_check() { # <label> <result line>
  case "$2" in "rc=1 term=yes build_alive=no reader_lines=2 "*) ok "$1: the watchdog still stopped the build and exited 1 ($2)";; *) bad "$1: $2";; esac
}
cs_check "macOS /bin/bash" "$(timeout 120 /bin/bash "$PKG/test/helpers/closed-session.sh" "$PKG" "$T/cs-mac" mem 2>&1 | tail -1)"
if docker info >/dev/null 2>&1; then
  cs_check "ubuntu:22.04 bash" "$(timeout 300 docker run --rm --name "closed-$RANDOM-$SFX" --platform linux/amd64 --user 1000:1000 -v "$PKG:/pkg:ro" ubuntu:22.04 \
    bash /pkg/test/helpers/closed-session.sh /pkg /tmp/cs mem 2>&1 | tail -1)"
else bad "section 6b (ubuntu:22.04) needs Docker Desktop"; fi
out=$(timeout 120 /bin/bash "$PKG/test/helpers/closed-session.sh" "$PKG" "$T/cs-disk" disk 2>&1); printf '%s\n' "$out" | sed 's/^/  /'
printf '%s\n' "$out" | grep -q '^rc=1 term=yes build_alive=no' && printf '%s\n' "$out" | grep -q 'FAIL BUILD STOPPED BY THE WATCHDOG: free disk on / [0-9]*MB < 999999999MB' \
  && ok "disk floor: free disk below BUILD_DISK_FLOOR_MB stops the build (exit 1)" || bad "disk floor"

# ---------------------------------------------------------------------------
echo; echo "== 6c. RUN-step selector on fake /proc trees, both cgroup drivers (macOS awk and ubuntu:jammy mawk)"
# test/helpers/selector.sh: never a process of a container that docker ps lists (before or after the scan), every
# RUN-step process for the cgroupfs and the systemd layout; OOM marking; kill_build on test-owned processes only.
if timeout 120 /bin/bash "$PKG/test/helpers/selector.sh" "$PKG" "$T/sel-mac" > "$T/sel-mac.out" 2>&1; then cat "$T/sel-mac.out"; ok "selector suite on macOS (bash 3.2, BSD awk)"
else cat "$T/sel-mac.out"; bad "selector suite on macOS"; fi
if docker info >/dev/null 2>&1; then
  if timeout 300 docker run --rm --name "selector-$RANDOM-$SFX" --user 1000:1000 -v "$PKG:/pkg:ro" ubuntu:jammy bash /pkg/test/helpers/selector.sh /pkg /tmp/sel > "$T/sel-jammy.out" 2>&1; then
    cat "$T/sel-jammy.out"; ok "selector suite on ubuntu:jammy (bash 5.1, mawk 1.3.4)"
  else cat "$T/sel-jammy.out"; bad "selector suite on ubuntu:jammy"; fi
else bad "section 6c (ubuntu:jammy) needs Docker Desktop"; fi

# ---------------------------------------------------------------------------
echo; echo "== 6d. the watchdog on a REAL dockerd 29.1.3 with the systemd cgroup driver (the server's version and default layout)"
# A throwaway privileged container runs systemd as PID 1 and docker-ce 29.1.3 from download.docker.com (cgroup v2,
# systemd driver, containerd image store), so the server's cgroup layout is reproduced, not assumed. Its dockerd is
# separate from Docker Desktop's: nothing outside the container is touched. test/helpers/sysd-driver.sh runs inside.
SYSD_IMG=ddcnew-sysdtest:jammy-$SFX
if docker info >/dev/null 2>&1; then
  if ! docker image inspect "$SYSD_IMG" >/dev/null 2>&1; then
    mkdir -p "$T/sysd-img"
    cat > "$T/sysd-img/Dockerfile" <<'EOF'
FROM ubuntu:jammy
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update -qq && apt-get -o Acquire::Retries=8 install -y -qq --no-install-recommends systemd systemd-sysv dbus ca-certificates curl iptables
RUN install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu jammy stable" > /etc/apt/sources.list.d/docker.list \
 && apt-get update -qq
RUN V=$(apt-cache madison docker-ce | awk '/ 5:29\.1\.3-/ {print $3; exit}'); [ -n "$V" ] || { echo "docker-ce 29.1.3 not available"; exit 1; }; \
    apt-get -o Acquire::Retries=8 install -y -qq --no-install-recommends docker-ce="$V" docker-ce-cli="$V" containerd.io docker-buildx-plugin busybox-static procps \
 && rm -rf /var/lib/apt/lists/* && systemctl enable docker containerd
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
EOF
    echo "building $SYSD_IMG (systemd + docker-ce 29.1.3; needs the network once)"
    timeout 900 docker build -q -t "$SYSD_IMG" "$T/sysd-img" >/dev/null || bad "could not build $SYSD_IMG"
  fi
  C6="sysdtest-$RANDOM-$SFX"
  if docker run -d --name "$C6" --privileged --cgroupns=private -v /var/lib/docker -v /var/lib/containerd --tmpfs /run --tmpfs /run/lock \
       -v "$PKG:/pkg:ro" "$SYSD_IMG" >/dev/null; then
    for _ in $(seq 1 60); do docker exec "$C6" docker info >/dev/null 2>&1 && break; sleep 1; done
    if timeout 400 docker exec "$C6" bash /pkg/test/helpers/sysd-driver.sh /pkg > "$T/sysd.out" 2>&1; then cat "$T/sysd.out"; ok "watchdog, selector and SIGKILL fallback on the real systemd driver"
    else cat "$T/sysd.out"; bad "real systemd-driver test"; fi
  else bad "could not start $C6"; fi
  docker rm -fv "$C6" >/dev/null 2>&1 || true
else bad "section 6d needs Docker Desktop"; fi

# ---------------------------------------------------------------------------
echo; echo "== 7. JWKS pin decision (common.sh jwks_pins_decide)"
tpA=$(printf 'A%.0s' $(seq 1 43)); tpB=$(printf 'b_-%.0s' $(seq 1 14))x; tpC=$(printf 'C%.0s' $(seq 1 43)); tpN=$(printf 'n%.0s' $(seq 1 43))
row() { printf 'kid=k%s alg=ES256 thumbprint=%s jwks=https://api-auth.web3auth.io/jwks\n' "$1" "$2"; }
pins() { ( DDC_LOCAL_TEST=1; . "$PKG/common.sh"; jwks_pins_decide "$1" "$2" "$3"; echo "PINS=$JWKS_PINS" ) 2>&1; }
out=$(pins "$(row 1 "$tpA"; row 2 "$tpB")" "$tpB,$tpA" "")
printf '%s\n' "$out" | grep -q "^PINS=$tpA,$tpB$" && ok "served = configured: pins written (2)" || { echo "$out"; bad "case same"; }
out=$(pins "$(row 1 "$tpA")" "$tpC" "") && bad "no configured pin served was accepted" || { printf '%s\n' "$out" | grep -q 'none of the 1 configured' && ok "no configured pin served -> refuses to start the api" || { echo "$out"; bad "case none"; }; }
out=$(pins "$(row 1 "$tpA"; row 2 "$tpN")" "$tpA" "") && bad "unpinned new key accepted" || { printf '%s\n' "$out" | grep -q 'never pinned' && ok "served key never pinned -> refuses until confirmed" || { echo "$out"; bad "case new"; }; }
out=$(pins "$(row 1 "$tpA"; row 2 "$tpN")" "$tpA" "$tpN")
printf '%s\n' "$out" | grep -q "^PINS=$tpA,$tpN$" && ok "new key confirmed with JWKS_NEW_PINS_VERIFIED -> pinned" || { echo "$out"; bad "case verified"; }
out=$(pins "$(row 1 "$tpA")" "$tpA,$tpC" "")
printf '%s\n' "$out" | grep -q "^PINS=$tpA$" && printf '%s\n' "$out" | grep -q 'no longer served: dropped' && ok "configured key no longer served -> dropped" || { echo "$out"; bad "case gone"; }
out=$(pins "kid=k1 alg=ES256 error=bad key jwks=x" "$tpA" "") && bad "no usable key accepted" || { printf '%s\n' "$out" | grep -q 'no usable key' && ok "no thumbprint in the output -> refuses" || { echo "$out"; bad "case empty"; }; }
out=$(pins "$(row 1 "${tpA}Z")" "$tpA" "") && bad "44-char thumbprint accepted" || ok "a 44-character value is not taken as a thumbprint"

# ---------------------------------------------------------------------------
echo; echo "== 8. 10-build.sh flag gate, refuse_if_infra_only, disk_expand_verdict"
S40=0123456789abcdef0123456789abcdef01234567
b10() { DDC_LOCAL_TEST=1 DDC_ARGS_ONLY=1 NEW_DIR="$T/ddcnew" bash "$PKG/10-build.sh" "$S40" "$S40" "$@" 2>&1; }
out=$(b10 --overlays-reconciled); printf '%s\n' "$out" | grep -q "API_IMAGE=ddcnew/backend:0123456789ab WEB" && printf '%s\n' "$out" | grep -q 'INFRA_ONLY=0' && ok "--overlays-reconciled: $out" || bad "reconciled: $out"
out=$(b10 --infra-only); printf '%s\n' "$out" | grep -q "API_IMAGE=ddcnew/backend:0123456789ab-infra" && printf '%s\n' "$out" | grep -q 'INFRA_ONLY=1' && ok "--infra-only: $out" || bad "infra: $out"
out=$(b10 --infra-only --overlays-reconciled) && bad "both flags accepted" || { printf '%s\n' "$out" | grep -q 'together is an error' && ok "both flags -> $out" || bad "both: $out"; }
out=$(b10) && bad "no flag accepted" || ok "no flag -> $(printf '%s' "$out" | cut -c1-90)..."
out=$(b10 --yes) && bad "unknown flag accepted" || ok "unknown flag -> $out"
for v in 1 0 missing; do
  d="$T/infra-$v"; mkdir -p "$d"; [ "$v" = missing ] || printf 'API_IMAGE=x\nWEB_IMAGE=y\nINFRA_ONLY=%s\n' "$v" > "$d/.env"
  if ( DDC_LOCAL_TEST=1; NEW_DIR="$d"; . "$PKG/common.sh"; refuse_if_infra_only ) > "$T/infra-$v.out" 2>&1; then r=allowed; else r=refused; fi
  case "$v:$r" in 0:allowed|1:refused|missing:refused) ok "refuse_if_infra_only with INFRA_ONLY=$v -> $r";; *) cat "$T/infra-$v.out"; bad "refuse_if_infra_only INFRA_ONLY=$v -> $r";; esac
done
grep -q 'production-only code' "$T/infra-1.out" && ok "refusal names the missing production-only code" || bad "refusal text"
G=1073741824; M=1048576
dv() { ( . "$PKG/common.sh"; disk_expand_verdict "$@" ); }
chk() { r=$(dv "$2" "$3" "$4" "$5"); case "$r" in *"growpart_needed=$6 resize2fs_needed=$7"*) ok "$1: $r";; *) bad "$1: $r";; esac; }
chk "before the resize (30G disk, full partition, full fs)" $((30*G)) $((M)) $((30*G - M - 20*1024)) $((30*G - M - 20*1024 - 4096)) no no
chk "after the console resize to 80G"                      $((80*G)) $((M)) $((30*G - M - 20*1024)) $((30*G - M - 20*1024 - 4096)) yes yes
chk "after growpart"                                       $((80*G)) $((M)) $((80*G - M - 20*1024)) $((30*G - M - 20*1024 - 4096)) no yes
chk "after resize2fs"                                      $((80*G)) $((M)) $((80*G - M - 20*1024)) $((80*G - M - 20*1024 - 4096)) no no

# ---------------------------------------------------------------------------
echo; echo "== 9. expand_check (read-only) on a real ext4 partition: the Docker Desktop VM disk behind /etc/hosts"
if docker info >/dev/null 2>&1; then
  if docker run --rm --privileged --platform linux/arm64 --name "expandro-$RANDOM-$SFX" -v "$PKG:/pkg:ro" ubuntu:jammy bash -c \
      'set -e; . /pkg/common.sh; expand_check /etc/hosts
       d=$(findmnt -n -o SOURCE /etc/hosts); d=${d%%\[*}; b=$(basename "$d")
       echo "raw: part_bytes=$(( $(cat /sys/class/block/$b/size) * 512 )) fs_bytes=$(dumpe2fs -h "$d" 2>/dev/null | awk -F: "/^Block count/ {c=\$2} /^Block size/ {s=\$2} END {print c*s}")"' > "$T/expand.out" 2>&1; then
    grep -v WARNING "$T/expand.out"
    grep -qE 'growpart_needed=(yes|no) resize2fs_needed=(yes|no)' "$T/expand.out" && grep -q 'growpart /dev/' "$T/expand.out" && ok "expand_check reads a real partition table and ext4 superblock (read-only) and prints the commands" || bad "expand_check output"
  else cat "$T/expand.out"; bad "expand_check failed on the VM disk"; fi
fi

# ---------------------------------------------------------------------------
echo; echo "== 10a. throwaway pass signer (common.sh rehearsal_pass_signer; 10-build.sh step 3, 40-up.sh checks)"
K="$T/keys"; mkdir -p "$K/prod" "$K/new"
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=fake production signer" -keyout "$K/prod/signerKey.pem" -out "$K/prod/signerCert.pem" >/dev/null 2>&1
cp "$K/prod/signerKey.pem" "$K/prod/signerCert.pem" "$K/new/"   # as if round 1 had copied the production pair
sig() { ( DDC_LOCAL_TEST=1; NEW_DIR="$T/ddcnew"; . "$PKG/common.sh"; "$@" ) 2>&1; }
( DDC_LOCAL_TEST=1; . "$PKG/common.sh"; pass_signer_ok "$K/new/signerKey.pem" "$K/new/signerCert.pem" "$K/prod/signerKey.pem" "$K/prod/signerCert.pem" ) && bad "the production pair was accepted" || ok "pass_signer_ok refuses the production pair (40-up.sh would stop)"
out=$(sig rehearsal_pass_signer "$K/new" "$K/prod"); printf '%s\n' "$out" | sed 's/^/  /'
h1=$(cat "$K/new/signerKey.pem" | shasum -a 256)
! cmp -s "$K/new/signerKey.pem" "$K/prod/signerKey.pem" && ! cmp -s "$K/new/signerCert.pem" "$K/prod/signerCert.pem" && printf '%s\n' "$out" | grep -q 'generated a throwaway' \
  && [ "$(stat -f %Lp "$K/new/signerKey.pem")" = 400 ] && [ "$(openssl pkey -in "$K/new/signerKey.pem" -pubout | shasum)" = "$(openssl x509 -in "$K/new/signerCert.pem" -noout -pubkey | shasum)" ] \
  && openssl x509 -in "$K/new/signerCert.pem" -noout -subject | grep -q THROWAWAY && ok "copied production pair replaced by a throwaway RSA key + self-signed cert (400, cert matches key)" || bad "throwaway signer not generated"
out=$(sig rehearsal_pass_signer "$K/new" "$K/prod"); [ "$h1" = "$(cat "$K/new/signerKey.pem" | shasum -a 256)" ] && printf '%s\n' "$out" | grep -q reusing && ok "re-run reuses the throwaway pair" || bad "re-run regenerated the pair"
chmod 600 "$K/new/signerCert.pem"; openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=other" -keyout "$K/other.pem" -out "$K/new/signerCert.pem" >/dev/null 2>&1
out=$(sig rehearsal_pass_signer "$K/new" "$K/prod"); printf '%s\n' "$out" | grep -q 'generated a throwaway' && ( DDC_LOCAL_TEST=1; . "$PKG/common.sh"; pass_signer_ok "$K/new/signerKey.pem" "$K/new/signerCert.pem" "$K/prod/signerKey.pem" "$K/prod/signerCert.pem" ) && ok "a cert that does not match the key is regenerated" || bad "mismatched pair kept"
grep -l 'PRIVATE KEY' "$K/new/"* >/dev/null && ! printf '%s\n' "$out" | grep -q 'PRIVATE KEY' && ok "no key material in the output" || bad "key material printed"

echo; echo "== 10b. money-path log fields (common.sh money_path_fields_check; 40-up.sh step 5): a missing field STOPS"
GOOD='Partner SSO money-path assertions OK: nodeEnv=production web3authVerify=enforce legacyFallback=false allowedVerifiers=5 jwksPinMode=enforce jwksPins=2 sessionSecretSeparate=true issuer=https://tge-api.datadance.ai consentOrigin=https://tge-app.datadance.ai publicClientRegistration=closed'
mp() { ( DDC_LOCAL_TEST=1; . "$PKG/common.sh"; money_path_fields_check "$1" "$2" ) 2>&1; }
out=$(mp "$GOOD" 2) && [ "$(printf '%s\n' "$out" | grep -c '^PASS log:')" = 10 ] && ok "complete line passes (9 required fields incl. sessionSecretSeparate=true + publicClientRegistration=closed)" || { echo "$out"; bad "good line"; }
out=$(mp "${GOOD/publicClientRegistration=closed/publicClientRegistration=open}" 2) && printf '%s\n' "$out" | grep -q '^WARN publicClientRegistration' && ok "publicClientRegistration=open is a warning only (runbook 5.2 open)" || bad "open registration handling"
for c in "jwksPins=2|jwksPins=3" "allowedVerifiers=5|allowedVerifiers=50" "issuer=https://tge-api.datadance.ai|issuer=https://tge-api.datadance.ai.evil" "web3authVerify=enforce|web3authVerify=log" "legacyFallback=false|legacyFallback=true" "jwksPinMode=enforce|jwksPinMode=log" "consentOrigin=https://tge-app.datadance.ai|consentOrigin=https://app.datadance.ai" "nodeEnv=production|nodeEnv=development" "jwksPins=2 |" "sessionSecretSeparate=true|sessionSecretSeparate=false" "sessionSecretSeparate=true |"; do
  from="${c%%|*}"; to="${c#*|}"; bad_line="${GOOD/"$from"/$to}"
  [ "$bad_line" != "$GOOD" ] || { bad "test setup: '$from' not replaced"; continue; }
  if out=$(mp "$bad_line" 2); then bad "accepted a line with '$to' instead of '$from'"
  else printf '%s\n' "$out" | grep -q '^FAIL the money-path log line lacks:' && ok "stops when '$from' is '${to:-absent}'" || { echo "$out"; bad "wrong failure for $from"; }; fi
done

echo; echo "== 10c. SSH login guard (sshpw.sh, remote.sh, ro-ssh.sh) against a throwaway Ubuntu 22.04 sshd (password + keyboard-interactive via PAM)"
if docker info >/dev/null 2>&1; then
  SS="$T/ssh"; mkdir -p "$SS/img" "$SS/pkg"; C="sshpwtest-$RANDOM-$SFX"; SSHD_IMG=ddcnew-sshtest:jammy-$SFX
  TESTPW="test-$(openssl rand -hex 12)"   # password of the throwaway container only
  if ! docker image inspect "$SSHD_IMG" >/dev/null 2>&1; then
    printf 'FROM ubuntu:jammy\nRUN export DEBIAN_FRONTEND=noninteractive && apt-get update -qq && apt-get -o Acquire::Retries=8 install -y -qq --no-install-recommends openssh-server >/dev/null && mkdir -p /run/sshd && rm -rf /var/lib/apt/lists/*\n' > "$SS/img/Dockerfile"
    timeout 600 docker build -q -t "$SSHD_IMG" "$SS/img" >/dev/null || bad "could not build the sshd test image"
  fi
  docker run -d --name "$C" -p 127.0.0.1::22 -e TESTPW="$TESTPW" "$SSHD_IMG" bash -c '
    printf "root:%s\n" "$TESTPW" | chpasswd
    exec /usr/sbin/sshd -D -e -o PermitRootLogin=yes -o PasswordAuthentication=yes -o KbdInteractiveAuthentication=yes -o UsePAM=yes -o LogLevel=VERBOSE -o MaxAuthTries=6' >/dev/null
  PORT=$(docker port "$C" 22/tcp | head -1 | sed 's/.*://')
  for _ in $(seq 1 30); do docker logs "$C" 2>&1 | grep -q 'Server listening' && break; sleep 1; done
  ssh-keyscan -p "$PORT" 127.0.0.1 2>/dev/null > "$SS/known_hosts"
  # A scratch copy of sshpw.sh with a TEST local.env next to it (loopback target, test vault): the package's own
  # local.env, if one exists, is never read by these tests.
  cp "$PKG/sshpw.sh" "$SS/pkg/sshpw.sh"
  printf 'DDC_SSH_TARGET=root@127.0.0.1\nDDC_OP_SECRET_REF=op://test-vault/test-item/password\n' > "$SS/pkg/local.env"
  # fake op: ok (prints the test password), fail (like 'authorization timeout'), flaky (passes the precheck, then fails)
  printf '#!/bin/sh\nprintf "%%s\\n" "%s"\n' "$TESTPW" > "$SS/op-ok"
  printf '#!/bin/sh\necho "[ERROR] could not read secret: authorization timeout" >&2\nexit 1\n' > "$SS/op-fail"
  printf '#!/bin/sh\nif [ -e "%s/flaky.used" ]; then echo "[ERROR] authorization timeout" >&2; exit 1; fi\ntouch "%s/flaky.used"\nprintf "%%s\\n" "%s"\n' "$SS" "$SS" "$TESTPW" > "$SS/op-flaky"
  chmod 700 "$SS"/op-*
  # Failed authentications as sshd (OpenSSH 8.9, Ubuntu 22.04) logs them. A FIRST empty password is logged as "Failed none"
  # (monitor.c mm_answer_authpassword), and fail2ban's sshd filter counts that line too.
  nfail() { docker logs "$C" 2>&1 | grep -cE 'Failed (none|password|keyboard-interactive)' || true; }
  nconn() { docker logs "$C" 2>&1 | grep -c 'Connection from' || true; }
  attempt() { # <label> <op-binary> [old|empty-askpass]
    RC=0
    ( . "$SS/pkg/sshpw.sh"; SSHPW_OP_BIN="$2"
      if [ "${3:-}" = old ]; then   # the round-2 askpass and options, as a control
        a="$SS/askpass-old"; printf '#!/bin/sh\nexec %s read "x"\n' "$2" > "$a"; chmod 700 "$a"
        SSH_ASKPASS="$a" SSH_ASKPASS_REQUIRE=force DISPLAY=none ssh -o PreferredAuthentications=password,keyboard-interactive -o PubkeyAuthentication=no \
          -o StrictHostKeyChecking=yes -o ConnectTimeout=20 -o NumberOfPasswordPrompts=2 -o UserKnownHostsFile="$SS/known_hosts" -p "$PORT" root@127.0.0.1 'echo "LOG""GED-IN"'
        exit $?
      fi
      if [ "${3:-}" = empty-askpass ]; then   # what ro-ssh.sh did when mktemp failed: SSH_ASKPASS="" (round 3 control)
        SSH_ASKPASS="" SSH_ASKPASS_REQUIRE=force DISPLAY=none ssh "${SSHPW_OPTS[@]}" -o UserKnownHostsFile="$SS/known_hosts" -p "$PORT" root@127.0.0.1 'echo "LOG""GED-IN"'
        exit $?
      fi
      sshpw_precheck || exit 3
      [ "$SSHPW_TARGET" = root@127.0.0.1 ] || exit 4   # only ever the throwaway sshd
      a="$SS/askpass-$1"; sshpw_make_askpass "$a" || exit 3
      SSH_ASKPASS="$a" SSH_ASKPASS_REQUIRE=force DISPLAY=none ssh "${SSHPW_OPTS[@]}" -o UserKnownHostsFile="$SS/known_hosts" -p "$PORT" "$SSHPW_TARGET" 'echo "LOG""GED-IN"'
    ) > "$SS/ssh-$1.out" 2>&1 || RC=$?
    sleep 2
  }
  f0=$(nfail); attempt control-old "$SS/op-fail" old; f1=$(nfail)
  [ $((f1 - f0)) -ge 1 ] && ok "control: the round-2 askpass with a failing op makes the test sshd log $((f1 - f0)) failed login(s) (the round-2 finding reproduced)" || bad "control did not reproduce the failed logins"
  f0=$(nfail); attempt control-empty "$SS/op-ok" empty-askpass; f1=$(nfail)
  docker logs "$C" > "$SS/sshd.log" 2>&1 || true   # (a file: `docker logs | grep -q` can fail with SIGPIPE under pipefail)
  [ $((f1 - f0)) -ge 1 ] && grep -q 'Failed none for root' "$SS/sshd.log" && grep -q 'ssh_askpass: exec' "$SS/ssh-control-empty.out" \
    && ok "control: ssh with SSH_ASKPASS=\"\" and SSH_ASKPASS_REQUIRE=force sends an EMPTY password: $((f1 - f0)) failed login, logged by the test sshd as 'Failed none' (the round-3 finding reproduced, $(ssh -V 2>&1 | cut -d, -f1))" || bad "empty-askpass control did not reproduce the failed login"
  c0=$(nconn); attempt precheck "$SS/op-fail"; c1=$(nconn)
  [ "$RC" = 3 ] && [ "$c1" = "$c0" ] && grep -q 'REFUSING TO CONNECT' "$SS/ssh-precheck.out" && ok "op fails -> sshpw_precheck refuses; no TCP connection reached sshd" || bad "precheck case (rc=$RC connections $c0->$c1)"
  f2=$(nfail); attempt flaky "$SS/op-flaky"; f3=$(nfail)
  [ "$RC" != 0 ] && [ "$RC" != 4 ] && [ "$f3" = "$f2" ] && ! grep -q LOGGED-IN "$SS/ssh-flaky.out" && ok "op passes the precheck, then fails in the askpass -> the askpass sees its parent is ssh and kills it: 0 failed logins on sshd (exit $RC)" || bad "flaky case (rc=$RC failed $f2->$f3)"
  a0=$(docker logs "$C" 2>&1 | grep -c 'Accepted password for root' || true)
  attempt good "$SS/op-ok"
  a1=$(docker logs "$C" 2>&1 | grep -c 'Accepted password for root' || true)
  docker logs "$C" > "$SS/sshd.log" 2>&1 || true
  [ "$RC" = 0 ] && grep -q LOGGED-IN "$SS/ssh-good.out" && [ $((a1 - a0)) = 1 ] && ! grep -q 'Accepted keyboard-interactive' "$SS/sshd.log" \
    && ok "op works -> one login to the target from the test local.env, accepted with the password method (the client offers no keyboard-interactive)" || bad "good case (rc=$RC accepted $a0->$a1)"
  # the askpass never kills a parent that is not ssh
  ( . "$SS/pkg/sshpw.sh"; sshpw_load_local_env || exit 1
    # shellcheck disable=SC2034  # read by the sourced sshpw.sh when it writes the askpass
    SSHPW_OP_BIN="$SS/op-fail"; sshpw_make_askpass "$SS/askpass-parent" ) || bad "askpass-parent setup"
  out=$(/bin/bash -c '"$1"; echo "parent alive, askpass exit $?"' _ "$SS/askpass-parent" 2>&1)
  printf '%s\n' "$out" | grep -q 'parent alive, askpass exit 1' && printf '%s\n' "$out" | grep -q 'is not ssh: not killing it' && ok "askpass with a failing op and a parent that is not ssh: exits 1 and leaves the parent alone" || bad "parent check: $out"
  # sshpw_make_askpass refuses an unusable file, and writes nothing without a loaded 1Password reference
  ( . "$SS/pkg/sshpw.sh"
    sshpw_make_askpass "$SS/noref" && echo "BUG askpass written without a loaded 1Password reference"
    [ -e "$SS/noref" ] && echo "BUG noref file created"
    sshpw_load_local_env || echo "BUG test local.env refused"
    sshpw_make_askpass "" && echo "BUG empty name accepted"
    sshpw_make_askpass "$SS/no-such-dir/a" 2>/dev/null && echo "BUG missing dir accepted"
    mkdir -p "$SS/ro"; chmod 500 "$SS/ro"; sshpw_make_askpass "$SS/ro/a" 2>/dev/null && echo "BUG read-only dir accepted"
    sshpw_make_askpass "$SS/full" && head -c 300 "$SS/full" > "$SS/trunc" && chmod 700 "$SS/trunc" && sshpw_askpass_ok "$SS/trunc" && echo "BUG truncated file accepted"
    grep -v 'kill -TERM' "$SS/full" > "$SS/midloss"; chmod 700 "$SS/midloss"; sshpw_askpass_ok "$SS/midloss" && echo "BUG file without the kill line accepted"
    sshpw_askpass_ok "$SS/full" || echo "BUG complete file refused" ) > "$SS/make.out" 2>&1
  [ ! -s "$SS/make.out" ] && ok "sshpw_make_askpass fails without a loaded 1Password reference, for an empty name, a missing or read-only directory; sshpw_askpass_ok refuses a truncated file and one that lost a middle line (sentinel 'exit 1' intact)" || { cat "$SS/make.out"; bad "askpass file checks"; }
  if docker run --rm --name "devfull-$RANDOM-$SFX" -v "$SS/pkg:/pkg:ro" ubuntu:jammy bash -c '. /pkg/sshpw.sh; sshpw_load_local_env || exit 9; if sshpw_make_askpass /dev/full; then echo accepted; else echo refused; fi' 2>/dev/null | grep -qx refused; then
    ok "disk full (/dev/full, ENOSPC on every write): sshpw_make_askpass fails"
  else bad "sshpw_make_askpass accepted /dev/full"; fi
  # remote.sh and ro-ssh.sh themselves, with an askpass that cannot be created: scratch COPIES whose test local.env points
  # at the throwaway sshd. remote.sh and survey/ro-ssh.sh are byte-identical to the package's; sshpw.sh differs in two
  # lines only (the op binary; port + known_hosts appended), asserted below. The host comes from local.env alone.
  CP="$T/sshcopy/deploy/new-stack"; mkdir -p "$CP/survey"
  cp "$PKG/remote.sh" "$PKG/00-preflight.sh" "$CP/"; cp "$PKG/survey/ro-ssh.sh" "$CP/survey/"; cp "$SS/pkg/local.env" "$CP/local.env"
  sed "s#^SSHPW_OP_BIN=/opt/homebrew/bin/op #SSHPW_OP_BIN=$SS/op-ok #" "$PKG/sshpw.sh" > "$CP/sshpw.sh"
  printf 'SSHPW_OPTS+=(-p %s -o UserKnownHostsFile=%s)\n' "$PORT" "$SS/known_hosts" >> "$CP/sshpw.sh"
  nd=$( { diff "$PKG/survey/ro-ssh.sh" "$CP/survey/ro-ssh.sh"; diff "$PKG/sshpw.sh" "$CP/sshpw.sh"; diff "$PKG/remote.sh" "$CP/remote.sh"; } | grep -c '^>' || true)
  if [ "$nd" = 2 ] && [ "$(sed -n 's/^DDC_SSH_TARGET=//p' "$CP/local.env")" = root@127.0.0.1 ]; then
    printf 'echo PROBE-OK\n' > "$CP/probe.sh"
    c0=$(nconn); f0=$(nfail); rc=0; out=$(TMPDIR="$T/no-such-dir" bash "$CP/survey/ro-ssh.sh" "$CP/probe.sh" "$CP/probe.out" 2>&1) || rc=$?; sleep 2; c1=$(nconn); f1=$(nfail)
    [ "$rc" = 3 ] && [ "$(printf '%s\n' "$out" | tail -1)" = "ro-ssh exit=3 (askpass not created; not connected)" ] && [ "$c1" = "$c0" ] && [ "$f1" = "$f0" ] \
      && ok "ro-ssh.sh with TMPDIR missing: exit 3, no TCP connection, 0 failed logins" || bad "ro-ssh.sh TMPDIR missing (rc=$rc out=$out conn $c0->$c1 failed $f0->$f1)"
    mkdir -p "$T/ro-tmp"; chmod 500 "$T/ro-tmp"
    c0=$(nconn); f0=$(nfail); rc=0; out=$(TMPDIR="$T/ro-tmp" bash "$CP/survey/ro-ssh.sh" "$CP/probe.sh" "$CP/probe.out" 2>&1) || rc=$?; sleep 2; c1=$(nconn); f1=$(nfail)
    [ "$rc" = 3 ] && [ "$c1" = "$c0" ] && [ "$f1" = "$f0" ] && ok "ro-ssh.sh with a read-only TMPDIR: exit 3, no TCP connection, 0 failed logins" || bad "ro-ssh.sh read-only TMPDIR (rc=$rc out=$out conn $c0->$c1)"
    c0=$(nconn); f0=$(nfail); rc=0; out=$(TMPDIR="$T/no-such-dir" bash "$CP/remote.sh" run p2-disk.sh preview 2>&1 < /dev/null) || rc=$?; sleep 2; c1=$(nconn); f1=$(nfail)
    [ "$rc" = 3 ] && printf '%s\n' "$out" | grep -q 'REFUSING TO CONNECT: the askpass file could not be created' && [ "$c1" = "$c0" ] && [ "$f1" = "$f0" ] \
      && ok "remote.sh run with TMPDIR missing: exit 3, no TCP connection, 0 failed logins" || bad "remote.sh TMPDIR missing (rc=$rc conn $c0->$c1 failed $f0->$f1): $out"
    a0=$(docker logs "$C" 2>&1 | grep -c 'Accepted password for root' || true); rc=0
    out=$(bash "$CP/survey/ro-ssh.sh" "$CP/probe.sh" "$CP/probe.out" 2>&1) || rc=$?; sleep 1
    a1=$(docker logs "$C" 2>&1 | grep -c 'Accepted password for root' || true)
    [ "$rc" = 0 ] && grep -q PROBE-OK "$CP/probe.out" && [ $((a1 - a0)) = 1 ] && ok "the same ro-ssh.sh copy with a usable TMPDIR logs in once (so 'no connection' above is the guard, not the copy)" || bad "ro-ssh.sh copy positive case (rc=$rc out=$out)"
  else bad "the test copies of ro-ssh.sh/sshpw.sh/remote.sh changed more than the op binary and port ($nd lines), or the test local.env is not the loopback one"; fi
  grep -qF 'SSHPW_OPTS=(-o PreferredAuthentications=password -o' "$PKG/sshpw.sh" && ! grep -q 'keyboard-interactive' "$PKG/sshpw.sh" \
    && grep -q 'NumberOfPasswordPrompts=1' "$PKG/sshpw.sh" && grep -qF 'mktemp "${TMPDIR:-/tmp}/askpass.XXXXXX") && sshpw_make_askpass "$a" ||' "$PKG/remote.sh" \
    && grep -qF 'A=$(mktemp "${TMPDIR:-/tmp}/askpass.XXXXXX") && sshpw_make_askpass "$A" || { rm -f "${A:-}"; echo "ro-ssh exit=3 (askpass not created; not connected)"; exit 3; }' "$PKG/survey/ro-ssh.sh" \
    && ! grep -q 'scratchpad' "$PKG/survey/ro-ssh.sh" && ! grep -q 'NumberOfPasswordPrompts=2' "$PKG/remote.sh" "$PKG/survey/ro-ssh.sh" \
    && ok "remote.sh and ro-ssh.sh: precheck, askpass creation guarded (exit 3 before ssh), no hard-coded scratchpad; sshpw.sh: password method only, NumberOfPasswordPrompts=1" || bad "remote.sh / ro-ssh.sh / sshpw.sh not wired as expected"
  grep -qF "$TESTPW" "$SS"/ssh-*.out "$CP/probe.out" 2>/dev/null && bad "the test password appeared in the output" || ok "the password never appears in the ssh output"
  # The partner page password through the REAL ssh (remote.sh run 50-partner-page.sh apply, 10-05): a scratch copy of
  # remote.sh + sshpw.sh whose stub op drains its own stdin into a file (so it would swallow a password it was handed),
  # and a stub 50-partner-page.sh in the throwaway sshd that prints a hash of the one line it receives on stdin.
  docker exec -i "$C" sh -c 'mkdir -p /root/ddcnew/deploy && cat > /root/ddcnew/deploy/50-partner-page.sh && chmod 700 /root/ddcnew/deploy/50-partner-page.sh' <<'EOF'
#!/bin/bash
IFS= read -r line; printf 'remote got-sha=%s args=%s ip=%s\n' "$(printf '%s' "$line" | sha256sum | cut -c1-16)" "$*" "${PARTNER_ALLOWED_IP:-}"
EOF
  CP2="$T/sshcopy2/deploy/new-stack"; mkdir -p "$CP2"
  printf '#!/bin/sh\ncat > "%s/op-drain.stdin.$$"\nprintf "%%s\\n" "%s"\n' "$SS" "$TESTPW" > "$SS/op-drain"; chmod 700 "$SS/op-drain"
  cp "$PKG/remote.sh" "$CP2/"; cp "$SS/pkg/local.env" "$CP2/local.env"
  sed "s#^SSHPW_OP_BIN=/opt/homebrew/bin/op #SSHPW_OP_BIN=$SS/op-drain #" "$PKG/sshpw.sh" > "$CP2/sshpw.sh"
  printf 'SSHPW_OPTS+=(-p %s -o UserKnownHostsFile=%s)\n' "$PORT" "$SS/known_hosts" >> "$CP2/sshpw.sh"
  ( umask 077; printf 'lt-%s\n' "$(openssl rand -hex 16)" > "$SS/page-pw" )   # a dummy page password for this test only
  rm -f "$SS"/op-drain.stdin.*; rc=0
  out=$(DDC_APPROVED=yes bash "$CP2/remote.sh" run 50-partner-page.sh apply PARTNER_ALLOWED_IP=203.0.113.7 < "$SS/page-pw" 2>&1) || rc=$?
  want=$(tr -d '\n' < "$SS/page-pw" | shasum -a 256 | cut -c1-16)
  nop=$(ls "$SS"/op-drain.stdin.* 2>/dev/null | wc -l | tr -d ' '); sop=$(cat "$SS"/op-drain.stdin.* 2>/dev/null | wc -c | tr -d ' ')
  if [ "$rc" = 0 ] && printf '%s\n' "$out" | grep -qx "remote got-sha=$want args=apply ip=203.0.113.7" && [ "$nop" -ge 2 ] && [ "$sop" = 0 ] \
     && ! printf '%s\n' "$out" | grep -qF -f "$SS/page-pw" && ! cat "$CP2"/logs/* | grep -qF -f "$SS/page-pw"; then
    ok "real ssh: the piped page password reaches the remote script's stdin unchanged (sha256 prefix $want), with PARTNER_ALLOWED_IP as its environment; 1Password ran $nop times (precheck, askpass) and read 0 bytes of stdin; the password is not in the output or logs/"
  else printf '%s\n' "$out" | sed 's/^/    /'; bad "page password through the real ssh (rc=$rc op runs=$nop op stdin bytes=$sop)"; fi
  docker rm -f "$C" >/dev/null 2>&1 || true
  echo "throwaway sshd container removed"
else
  bad "SSH guard test needs Docker Desktop"
fi

echo; echo "== 10d. remote.sh env overrides: allowlist (a COPY of remote.sh with a stub sshpw.sh: nothing can connect)"
R="$T/remote"; mkdir -p "$R"; cp "$PKG/remote.sh" "$R/"
printf '%s\n' 'SSHPW_OPTS=(-o BatchMode=yes)' 'sshpw_precheck() { echo "STUB: would connect now (stopped)"; return 1; }' 'sshpw_make_askpass() { :; }' > "$R/sshpw.sh"
for a in PATH=/tmp BASH_ENV=/tmp/x LD_PRELOAD=/tmp/x.so DDC_LOCAL_TEST=1 NEW_DIR=/tmp/x OLD_ENV=/tmp/x BACKUP_DIR=/tmp/x DDC_MEMINFO=/tmp/x BUILD_WATCH_INTERVAL=1 lower_case=1; do
  rc=0; out=$(DDC_APPROVED=yes bash "$R/remote.sh" run 40-up.sh "$a" 2>&1 < /dev/null) || rc=$?
  [ "$rc" = 2 ] && printf '%s\n' "$out" | grep -q "override ${a%%=*} is not allowed" && ! printf '%s\n' "$out" | grep -q STUB || bad "override ${a%%=*}: rc=$rc $out"
done
ok "10 non-allowlisted overrides (PATH, BASH_ENV, LD_PRELOAD, DDC_LOCAL_TEST, NEW_DIR, OLD_ENV, BACKUP_DIR, DDC_MEMINFO, BUILD_WATCH_INTERVAL, lower_case) refused before any connection"
out=$(DDC_APPROVED=yes bash "$R/remote.sh" run 40-up.sh JWKS_NEW_PINS_VERIFIED=abc REHEARSAL_DB=ddc_rehearsal2 2>&1 < /dev/null || true)
printf '%s\n' "$out" | grep -q STUB && ok "allowlisted overrides (JWKS_NEW_PINS_VERIFIED, REHEARSAL_DB) pass through to the (stubbed) connection" || bad "allowlisted override refused: $out"
out=$(DDC_APPROVED=yes bash "$R/remote.sh" run p1-backup.sh verify P1_USERS_MIN=1000 2>&1 < /dev/null || true)
printf '%s\n' "$out" | grep -q STUB && ok "P1_USERS_MIN (p1-backup.sh verify) is allowlisted and passes through to the (stubbed) connection" || bad "P1_USERS_MIN refused: $out"
out=$(bash "$R/remote.sh" run 40-up.sh 2>&1 < /dev/null || true); printf '%s\n' "$out" | grep -q 'refusing: this call changes the server' && ok "write call without DDC_APPROVED=yes refused" || bad "approval gate: $out"
# 50-partner-page.sh (10-05): PARTNER_ALLOWED_IP allowlisted, status read-only, apply/verify/remove approved, a terminal
# on stdin refused for apply and verify, the local-test-only overrides refused.
out=$(DDC_APPROVED=yes bash "$R/remote.sh" run 50-partner-page.sh apply PARTNER_ALLOWED_IP=203.0.113.7 2>&1 < /dev/null || true)
printf '%s\n' "$out" | grep -q STUB && ok "PARTNER_ALLOWED_IP (50-partner-page.sh apply) is allowlisted and passes through to the (stubbed) connection" || bad "PARTNER_ALLOWED_IP refused: $out"
out=$(bash "$R/remote.sh" run 50-partner-page.sh status 2>&1 < /dev/null || true)
printf '%s\n' "$out" | grep -q STUB && ok "50-partner-page.sh status needs no approval (read-only)" || bad "50-partner-page.sh status: $out"
for c in apply verify remove; do
  out=$(bash "$R/remote.sh" run 50-partner-page.sh "$c" 2>&1 < /dev/null || true)
  printf '%s\n' "$out" | grep -q 'refusing: this call changes the server' || bad "50-partner-page.sh $c without DDC_APPROVED=yes: $out"
done
ok "50-partner-page.sh apply, verify and remove without DDC_APPROVED=yes: refused"
for a in PARTNER_CRYPT_IMAGE=node:22-alpine SRV_DIR=/tmp/x DDC_TEST_SUFFIX=20261005; do
  rc=0; out=$(DDC_APPROVED=yes bash "$R/remote.sh" run 50-partner-page.sh apply "$a" 2>&1 < /dev/null) || rc=$?
  [ "$rc" = 2 ] && printf '%s\n' "$out" | grep -q "override ${a%%=*} is not allowed" && ! printf '%s\n' "$out" | grep -q STUB || bad "override ${a%%=*} (50-partner-page.sh): rc=$rc $out"
done
ok "the local-test-only overrides of 50-partner-page.sh (PARTNER_CRYPT_IMAGE, SRV_DIR, DDC_TEST_SUFFIX) refused before any connection"
for c in apply verify; do   # script(1) gives remote.sh a pty as stdin, as if Sloan forgot the pipe
  rc=0; out=$(script -q /dev/null env DDC_APPROVED=yes bash "$R/remote.sh" run 50-partner-page.sh "$c" PARTNER_ALLOWED_IP=203.0.113.7 < /dev/null 2>&1) || rc=$?
  [ "$rc" = 2 ] && printf '%s\n' "$out" | grep -q 'the page password is piped, never typed' && ! printf '%s\n' "$out" | grep -q STUB || bad "50-partner-page.sh $c with a terminal on stdin: rc=$rc $out"
done
ok "50-partner-page.sh apply and verify with a terminal on stdin: refused before any connection (the password is never typed)"

# ---------------------------------------------------------------------------
echo; echo "== 10e. local.env: remote.sh and survey/ro-ssh.sh refuse to connect without a usable local.env (stub op and ssh record every call)"
# Scratch copies: remote.sh, 00-preflight.sh and survey/ro-ssh.sh unmodified; sshpw.sh with the op binary pointed at a
# stub that records its calls. A stub ssh first in PATH records any connection attempt. Nothing here reaches a network.
LE="$T/localenv"; mkdir -p "$LE/bin"
printf '#!/bin/sh\necho "op $*" >> "%s/calls"\nprintf "%%s\\n" stub-password\n' "$LE" > "$LE/bin/op"
printf '#!/bin/sh\necho "ssh $*" >> "%s/calls"\ncat > "%s/ssh.stdin"\nexit 0\n' "$LE" "$LE" > "$LE/bin/ssh"
chmod 755 "$LE/bin/op" "$LE/bin/ssh"
lecopy() { # <dir> [local.env content]: the copies; no local.env without a second argument
  rm -rf "$1"; mkdir -p "$1/survey"
  cp "$PKG/remote.sh" "$PKG/00-preflight.sh" "$PKG/local.env.example" "$1/"; cp "$PKG/survey/ro-ssh.sh" "$1/survey/"
  sed "s#^SSHPW_OP_BIN=/opt/homebrew/bin/op #SSHPW_OP_BIN=$LE/bin/op #" "$PKG/sshpw.sh" > "$1/sshpw.sh"
  if [ $# -ge 2 ]; then printf '%s\n' "$2" > "$1/local.env"; fi
}
le_run() { # <dir> <run|preflight|ro> -> output in $LE/out, status in $RC, calls in $LE/calls
  rm -f "$LE/calls" "$LE/ssh.stdin"; RC=0
  case "$2" in
    run) PATH="$LE/bin:$PATH" bash "$1/remote.sh" run p2-disk.sh preview > "$LE/out" 2>&1 < /dev/null || RC=$?;;
    preflight) PATH="$LE/bin:$PATH" bash "$1/remote.sh" preflight > "$LE/out" 2>&1 < /dev/null || RC=$?;;
    ro) printf 'echo PROBE\n' > "$1/probe.sh"; PATH="$LE/bin:$PATH" bash "$1/survey/ro-ssh.sh" "$1/probe.sh" "$1/probe.out" > "$LE/out" 2>&1 < /dev/null || RC=$?;;
  esac
}
le_refuses() { # <label> <expected reason text> <dir>
  local e
  for e in run preflight ro; do
    le_run "$3" "$e"
    if [ "$RC" = 3 ] && grep -qF 'REFUSING TO CONNECT: ' "$LE/out" && grep -qF -- "$2" "$LE/out" && [ ! -e "$LE/calls" ] && ! grep -q 'pasted-secret' "$LE/out"; then :
    else sed 's/^/    /' "$LE/out"; bad "$1: $e (rc=$RC, calls: $(tr '\n' ';' < "$LE/calls" 2>/dev/null))"; return; fi
  done
  ok "$1 -> remote.sh run, remote.sh preflight and survey/ro-ssh.sh each refuse (exit 3: '$2'); 1Password not asked, ssh never started"
}
TREF=op://test-vault/test-item/password
lecopy "$LE/missing";                                                                le_refuses "no local.env" "local.env does not exist" "$LE/missing"
lecopy "$LE/placeholder" "$(cat "$PKG/local.env.example")";                          le_refuses "local.env copied from local.env.example (CHANGE_ME)" "still has the CHANGE_ME placeholder values" "$LE/placeholder"
lecopy "$LE/empty" "$(printf 'DDC_SSH_TARGET=\nDDC_OP_SECRET_REF=')";                 le_refuses "both values empty" "is empty or missing" "$LE/empty"
lecopy "$LE/one-empty" "$(printf 'DDC_SSH_TARGET=root@127.0.0.1\nDDC_OP_SECRET_REF=""')"; le_refuses "an empty (quoted) 1Password reference" "is empty or missing" "$LE/one-empty"
lecopy "$LE/commented" "$(printf '# DDC_SSH_TARGET=root@127.0.0.1\nDDC_OP_SECRET_REF=%s' "$TREF")"; le_refuses "the target only in a comment" "is empty or missing" "$LE/commented"
lecopy "$LE/option" "$(printf 'DDC_SSH_TARGET=-oProxyCommand=touch_x\nDDC_OP_SECRET_REF=%s' "$TREF")"; le_refuses "a target that ssh would read as an option" "is not of the form user@host" "$LE/option"
lecopy "$LE/pasted" "$(printf 'DDC_SSH_TARGET=root@127.0.0.1\nDDC_OP_SECRET_REF=pasted-secret-not-a-reference')"; le_refuses "a pasted password instead of a reference (never printed)" "is not a 1Password secret reference" "$LE/pasted"
# controls: a usable test local.env reaches the stubs, once each, with the target from local.env
lecopy "$LE/good" "$(printf 'DDC_SSH_TARGET=root@127.0.0.1\nDDC_OP_SECRET_REF=%s' "$TREF")"
le_run "$LE/good" run
[ "$RC" = 0 ] && [ "$(grep -c "^op read $TREF\$" "$LE/calls")" = 1 ] && [ "$(grep -c '^ssh ' "$LE/calls")" = 1 ] && grep -q '^ssh .* root@127\.0\.0\.1 cd /root/ddcnew/deploy && env \./p2-disk\.sh preview$' "$LE/calls" \
  && ok "control: with a usable test local.env, remote.sh asks the (stub) 1Password once and starts the (stub) ssh once, to the target from local.env" || { sed 's/^/    /' "$LE/out" "$LE/calls"; bad "positive control, remote.sh run (rc=$RC)"; }
le_run "$LE/good" ro
[ "$RC" = 0 ] && [ "$(grep -c '^ssh .* root@127\.0\.0\.1 bash -s$' "$LE/calls")" = 1 ] && cmp -s "$LE/ssh.stdin" "$LE/good/probe.sh" \
  && ok "control: survey/ro-ssh.sh with the same local.env pipes the script to the (stub) ssh once" || { sed 's/^/    /' "$LE/out" "$LE/calls"; bad "positive control, ro-ssh.sh (rc=$RC)"; }
le_run "$LE/good" preflight
[ "$RC" = 0 ] && [ "$(head -1 "$LE/ssh.stdin")" = "GIT_APN_SHA=" ] && cmp -s <(tail -n +2 "$LE/ssh.stdin") "$PKG/00-preflight.sh" \
  && ok "remote.sh preflight outside a git checkout: pipes GIT_APN_SHA= (empty) + the unchanged 00-preflight.sh" || { sed 's/^/    /' "$LE/out"; bad "preflight outside git (rc=$RC)"; }
# remote.sh preflight inside a git checkout: the sha256 of keys_fixed/apn_key.p8 at HEAD is computed at run time
G="$T/apnrepo"; mkdir -p "$G/keys_fixed"; lecopy "$G/deploy/new-stack" "$(printf 'DDC_SSH_TARGET=root@127.0.0.1\nDDC_OP_SECRET_REF=%s' "$TREF")"
printf 'synthetic apn key file for the preflight wiring test\n' > "$G/keys_fixed/apn_key.p8"
# a throwaway repository in the scratch directory; its one commit is not signed (a signing prompt would block the suite)
git -C "$G" init -q 2>/dev/null && git -C "$G" add keys_fixed/apn_key.p8 \
  && git -C "$G" -c user.name=ddcnew-local-test -c user.email=ddcnew-local-test@example.invalid commit -q --no-gpg-sign -m "throwaway repository of the local test" >/dev/null 2>&1 \
  || bad "could not set up the throwaway git repository"
want=$(shasum -a 256 < "$G/keys_fixed/apn_key.p8" | cut -c1-64)
le_run "$G/deploy/new-stack" preflight
[ "$RC" = 0 ] && [ "$(head -1 "$LE/ssh.stdin")" = "GIT_APN_SHA=$want" ] && cmp -s <(tail -n +2 "$LE/ssh.stdin") "$PKG/00-preflight.sh" \
  && ok "remote.sh preflight in a git checkout: prepends GIT_APN_SHA=<sha256 of keys_fixed/apn_key.p8 at HEAD> to the unchanged 00-preflight.sh (no hash is stored in the repository)" || { sed 's/^/    /' "$LE/out"; bad "preflight hash wiring (rc=$RC)"; }
# remote.sh run 50-partner-page.sh apply with the page password piped in (10-05): the stub ssh receives exactly that line
# on its stdin; a stub op that drains its own stdin reads none of it; it is not printed and not in logs/.
lecopy "$LE/pp" "$(printf 'DDC_SSH_TARGET=root@127.0.0.1\nDDC_OP_SECRET_REF=%s' "$TREF")"
printf '#!/bin/sh\ncat > "%s/op-stdin.$$"\necho "op $*" >> "%s/calls"\nprintf "%%s\\n" stub-password\n' "$LE" "$LE" > "$LE/op-drain"; chmod 755 "$LE/op-drain"
sed "s#^SSHPW_OP_BIN=/opt/homebrew/bin/op #SSHPW_OP_BIN=$LE/op-drain #" "$PKG/sshpw.sh" > "$LE/pp/sshpw.sh"
( umask 077; printf 'lt-%s\n' "$(openssl rand -hex 16)" > "$LE/page-pw" )   # a dummy page password for this test only
rm -f "$LE/calls" "$LE/ssh.stdin" "$LE"/op-stdin.*; RC=0
DDC_APPROVED=yes PATH="$LE/bin:$PATH" bash "$LE/pp/remote.sh" run 50-partner-page.sh apply PARTNER_ALLOWED_IP=203.0.113.7 < "$LE/page-pw" > "$LE/out" 2>&1 || RC=$?
[ "$RC" = 0 ] && cmp -s "$LE/ssh.stdin" "$LE/page-pw" && [ "$(cat "$LE"/op-stdin.* | wc -c | tr -d ' ')" = 0 ] \
  && grep -q '^ssh .* root@127\.0\.0\.1 cd /root/ddcnew/deploy && env PARTNER_ALLOWED_IP=203\.0\.113\.7 \./50-partner-page\.sh apply$' "$LE/calls" \
  && ! cat "$LE/out" "$LE/calls" "$LE"/pp/logs/* | grep -qF -f "$LE/page-pw" \
  && ok "remote.sh run 50-partner-page.sh apply: the piped page password reaches ssh's stdin byte for byte, op reads 0 bytes of it, the remote command carries only PARTNER_ALLOWED_IP; nothing prints or logs the password" \
  || { sed 's/^/    /' "$LE/out" "$LE/calls"; bad "page password through remote.sh (rc=$RC)"; }
# remote.sh upload: the tarball (captured by the stub ssh) holds exactly the scripts, compose.yaml and partner-info/index.html
UP="$LE/upload"; rm -rf "$UP"; mkdir -p "$UP/partner-info"
cp "$PKG"/*.sh "$PKG/compose.yaml" "$UP/"; cp "$PKG/partner-info/index.html" "$UP/partner-info/"
sed "s#^SSHPW_OP_BIN=/opt/homebrew/bin/op #SSHPW_OP_BIN=$LE/bin/op #" "$PKG/sshpw.sh" > "$UP/sshpw.sh"
printf 'DDC_SSH_TARGET=root@127.0.0.1\nDDC_OP_SECRET_REF=%s\n' "$TREF" > "$UP/local.env"
rm -f "$LE/calls" "$LE/ssh.stdin"; RC=0
DDC_APPROVED=yes PATH="$LE/bin:$PATH" bash "$UP/remote.sh" upload > "$LE/out" 2>&1 < /dev/null || RC=$?
got=$(tar -tzf "$LE/ssh.stdin" 2>/dev/null | LC_ALL=C sort | tr '\n' ' ')
want="00-preflight.sh 10-build.sh 20-env.sh 30-nginx.sh 40-up.sh 50-partner-page.sh 99-teardown.sh common.sh compose.yaml p1-backup.sh p2-disk.sh partner-info/index.html "
[ "$RC" = 0 ] && [ "$got" = "$want" ] && cmp -s <(tar -xzOf "$LE/ssh.stdin" partner-info/index.html) "$PKG/partner-info/index.html" \
  && ok "remote.sh upload: the tarball holds the 10 scripts, compose.yaml and partner-info/index.html (the server then lists 12 entries in /root/ddcnew/deploy)" \
  || { sed 's/^/    /' "$LE/out"; bad "upload tarball (rc=$RC): $got"; }
# 00-preflight.sh itself, as root in a throwaway ubuntu:jammy (no network, stub docker, a fake old tree): the apn_key.p8
# line reports yes / no / not checked and nothing else; the CORS counts use the neutral labels.
if docker info >/dev/null 2>&1; then
  PF="$T/preflight"; mkdir -p "$PF/bin"
  cat > "$PF/bin/docker" <<'EOF'
#!/bin/sh
# stub docker for 00-preflight.sh: six old containers, nothing else
case "$1" in ps) for n in api db app web admin business; do echo "ddc-$n-1|Up 1 day|"; done;; esac
exit 0
EOF
  chmod 755 "$PF/bin/docker"
  pfrun() { # <GIT_APN_SHA line or -> -> output in $PF/out
    { [ "$1" = - ] || printf 'GIT_APN_SHA=%s\n' "$1"; cat "$PKG/00-preflight.sh"; } > "$PF/script.sh"
    docker run --rm --network none --name "preflight-$RANDOM-$SFX" -v "$PF:/pf:ro" -v "$PKG/test/fixtures:/fx:ro" ubuntu:jammy bash -c '
      set -e; export PATH="/pf/bin:$PATH"
      mkdir -p /root/ddc-backend/keys_fixed /root/ddc-backend/campaign-covers /root/ddc-backend/passes /root/ddc-backend/overlays /etc/nginx/sites-available /etc/nginx/sites-enabled
      printf "A=1\n" > /root/ddc-backend/backend.env
      for k in apn_key.p8 wwdr.pem signerCert.pem signerKey.pem; do echo "synthetic $k" > "/root/ddc-backend/keys_fixed/$k"; done
      cp /fx/api.datadance.co /fx/app.datadance.co /etc/nginx/sites-available/
      bash /pf/script.sh' > "$PF/out" 2>&1 || true
  }
  same=$(printf 'synthetic apn_key.p8\n' | shasum -a 256 | cut -c1-64); other=$(printf 'another file\n' | shasum -a 256 | cut -c1-64)
  r=""
  pfrun "$same"; grep -q '^===== summary =====' "$PF/out" && r="$r $(grep -c '^keys_fixed/apn_key.p8 identical to the git-tree copy: yes$' "$PF/out")"
  pfrun "$other"; grep -q '^===== summary =====' "$PF/out" && r="$r $(grep -c '^keys_fixed/apn_key.p8 identical to the git-tree copy: no$' "$PF/out")"
  pfrun -; grep -q '^===== summary =====' "$PF/out" && r="$r $(grep -c '^keys_fixed/apn_key.p8 identical to the git-tree copy: not checked' "$PF/out")"
  cors=$(grep -E '^(api_vhost_hardcoded_cors_origins|api_vhost_http_origin_lines|map_connection_upgrade_in_app_vhost)=' "$PF/out" | tr '\n' ' ')
  if [ "$r" = " 1 1 1" ] && [ "$(grep -ciE 'apn.*(public|rotate)' "$PF/out")" = 0 ] && [ "$cors" = "map_connection_upgrade_in_app_vhost=1 api_vhost_hardcoded_cors_origins=0 api_vhost_http_origin_lines=3 " ]; then
    ok "00-preflight.sh as root (ubuntu:jammy, stub docker): apn_key.p8 identical to the git-tree copy -> yes / no / not checked, nothing more; CORS counts: $cors"
  else sed 's/^/    /' "$PF/out" | tail -40; bad "00-preflight.sh apn_key.p8 / CORS lines (got [$r] [$cors])"; fi
else bad "00-preflight.sh smoke run needs Docker Desktop"; fi

# ---------------------------------------------------------------------------
echo; echo "== 11. ROOT mode in ubuntu:22.04 (no DDC_LOCAL_TEST, the server's /root/ddcnew layout): write guard, require_server, run lock, server-side log"
# test/helpers/root-guard.sh: first-run and re-run targets allowed (existing files, in-tree symlinks); a symlink into
# /root/ddc-backend, .. traversal and paths outside the allowlist refused; one write run at a time; logs 600.
if docker info >/dev/null 2>&1; then
  if timeout 300 docker run --rm --name "rootguard-$RANDOM-$SFX" --platform linux/amd64 -v "$PKG:/pkg:ro" ubuntu:22.04 bash /pkg/test/helpers/root-guard.sh /pkg > "$T/rootguard.out" 2>&1; then
    cat "$T/rootguard.out"; ok "root-mode guard, lock and log suite (ubuntu:22.04 amd64, bash 5.1, GNU realpath)"
  else cat "$T/rootguard.out"; bad "root-mode guard suite"; fi
else bad "section 11 needs Docker Desktop"; fi

# ---------------------------------------------------------------------------
echo; echo "== 12. pass criteria that STOP the scripts (p1 verify, 30-nginx apply/undo, 40-up step 8) and the teardown fallback"
if docker info >/dev/null 2>&1; then
  if timeout 300 docker run --rm --name "p1verify-$RANDOM-$SFX" --user 1000:1000 -v "$PKG:/pkg:ro" ubuntu:jammy bash /pkg/test/helpers/p1-verify.sh /pkg /tmp/p1 > "$T/p1verify.out" 2>&1; then
    cat "$T/p1verify.out"; ok "p1-backup.sh verify: stops on pg_restore --list failures and on a restored user count that is not a number or below P1_USERS_MIN; warns only above live"
  else cat "$T/p1verify.out"; bad "p1-backup.sh verify stop cases"; fi
else bad "section 12 (p1) needs Docker Desktop"; fi
# 30-nginx.sh apply/undo with stub nginx/systemctl/curl/docker in scratch vhost directories (DDC_LOCAL_TEST=1)
ST="$T/stubs"; mkdir -p "$ST"
printf '#!/bin/sh\nexit 0\n' > "$ST/nginx"
printf '#!/bin/sh\n[ "$1 $2" = "reload nginx" ] && touch "$STUB_DIR/reloaded"\nexit 0\n' > "$ST/systemctl"
cat > "$ST/curl" <<'EOF'
#!/bin/sh
# answers like the host nginx: 200 for the old vhosts, 502 for tge-*; after a reload, $CHANGE_HOST answers 502
host=""; prev=""
for a in "$@"; do [ "$prev" = -H ] && host="${a#Host: }"; prev="$a"; done
case "$host" in tge-*) printf 502; exit 0;; esac
if [ -f "$STUB_DIR/reloaded" ] && [ "$host" = "${CHANGE_HOST:-none}" ]; then printf 502; else printf 200; fi
EOF
chmod 755 "$ST"/*
vhosts() { # <dir>: avail/ and enabled/ with the two synthetic vhost fixtures
  mkdir -p "$1/avail" "$1/enabled" "$1/ddcnew"
  cp "$PKG/test/fixtures/api.datadance.co" "$PKG/test/fixtures/app.datadance.co" "$1/avail/"
  ln -sfn "$1/avail/api.datadance.co" "$1/enabled/api.datadance.co"; ln -sfn "$1/avail/app.datadance.co" "$1/enabled/app.datadance.co"
}
NX="$T/nginx-stop"; vhosts "$NX"; mkdir -p "$NX/bin"; printf '#!/bin/sh\nexit 0\n' > "$NX/bin/docker"; chmod 755 "$NX/bin/docker"
ng() { # <host whose code changes after the reload | none> <apply|undo>; output in $NX/out, status in $RC
  rm -f "$NX/reloaded"; RC=0
  PATH="$NX/bin:$ST:$PATH" STUB_DIR="$NX" CHANGE_HOST="$1" DDC_LOCAL_TEST=1 NEW_DIR="$NX/ddcnew" NGINX_AVAIL="$NX/avail" NGINX_ENABLED="$NX/enabled" \
    bash "$PKG/30-nginx.sh" "$2" > "$NX/out" 2>&1 || RC=$?
}
ng none apply
[ "$RC" = 0 ] && grep -q '^PASS old vhosts answer exactly as before' "$NX/out" && [ -L "$NX/enabled/tge-api.datadance.ai" ] && ok "30-nginx.sh apply, old codes unchanged -> passes" || { cat "$NX/out"; bad "apply baseline (rc=$RC)"; }
ng api.datadance.ai apply
[ "$RC" = 1 ] && grep -q '^FAIL old vhost status codes changed: before \[api=200 app=200 business=200 admin=200\] after \[api=502 app=200' "$NX/out" \
  && grep -q '^PASS old-stack containers unchanged' "$NX/out" && [ "$(tail -1 "$NX/out")" = "FAIL old vhost status codes changed after the reload — run ./30-nginx.sh undo now" ] \
  && ok "30-nginx.sh apply, old api vhost answers 502 after the reload -> integrity check printed, then STOPS: $(tail -1 "$NX/out")" || { cat "$NX/out"; bad "apply stop case (rc=$RC)"; }
ng app.datadance.ai undo
[ "$RC" = 1 ] && grep -q 'FAIL old vhost status codes changed after the reload — the tge vhosts are already removed' "$NX/out" && [ ! -e "$NX/avail/tge-api.datadance.ai" ] \
  && ok "30-nginx.sh undo, old app vhost changed after the reload -> STOPS (tge vhosts already removed)" || { cat "$NX/out"; bad "undo stop case (rc=$RC)"; }
ng none undo
[ "$RC" = 0 ] && grep -q '^PASS old vhosts unchanged' "$NX/out" && ok "30-nginx.sh undo, old codes unchanged -> passes" || { cat "$NX/out"; bad "undo baseline (rc=$RC)"; }
for f in 30-nginx.sh 40-up.sh; do grep -qE 'warn "old (vhost )?(status )?codes' "$PKG/$f" && bad "$f still only warns on changed old vhost codes"; done
grep -q 'die "old vhost status codes changed while 40-up.sh ran' "$PKG/40-up.sh" && ok "40-up.sh step 8: changed old vhost codes STOP the script (same pattern as 30-nginx.sh; no warn left in either)" || bad "40-up.sh step 8 still warns"
# 99-teardown.sh when docker compose cannot run (e.g. .env missing): removal by the ddcnew compose label only
TD="$T/teardown"; vhosts "$TD"; mkdir -p "$TD/bin"; printf 'name: ddcnew\n' > "$TD/ddcnew/compose.yaml"
cat > "$TD/bin/docker" <<'EOF'
#!/bin/bash
# stub docker for 99-teardown.sh: compose fails like a missing .env; one old-stack container that must stay untouched
echo "$*" >> "$STUB_DIR/calls"
case "$1" in
  compose) echo "required variable API_IMAGE is missing a value" >&2; exit 1;;
  ps) if [[ "$*" == *"label=com.docker.compose.project=ddcnew"* ]]; then [ -f "$STUB_DIR/rm.done" ] || printf '%s\n' 1111 2222
      else [ -f "$STUB_DIR/rm.done" ] || printf '%s\n' ddcnew-api-1 ddcnew-db-1; echo ddc-backend-ddc-backend-db-1; fi;;
  inspect) if [[ "$*" == *"{{.Name}}|{{.Id}}"* ]]; then echo "/ddc-backend-ddc-backend-db-1|feed|running|2026-09-20T00:00:00Z|0|always"
           elif [ "${STUB_BAD:-0}" = 1 ]; then printf '%s\n' /ddcnew-api-1 /ddc-backend-ddc-backend-api-1
           else printf '%s\n' /ddcnew-api-1 /ddcnew-db-1; fi;;
  rm) touch "$STUB_DIR/rm.done";;
  network) case "$2" in ls) [ -f "$STUB_DIR/net.done" ] || echo net1;; inspect) echo ddcnew_default;; rm) touch "$STUB_DIR/net.done";; esac;;
esac
exit 0
EOF
chmod 755 "$TD/bin/docker"
td() { rm -f "$TD/calls" "$TD/rm.done" "$TD/net.done" "$TD/reloaded"; RC=0
  PATH="$TD/bin:$ST:$PATH" STUB_DIR="$TD" STUB_BAD="$1" CHANGE_HOST=none DDC_LOCAL_TEST=1 NEW_DIR="$TD/ddcnew" NGINX_AVAIL="$TD/avail" NGINX_ENABLED="$TD/enabled" \
    bash "$PKG/99-teardown.sh" > "$TD/out" 2>&1 || RC=$?; }
td 0
rmc=$(grep -E '^(rm|network rm)' "$TD/calls" | tr '\n' ';')
[ "$RC" = 0 ] && grep -q '^WARN docker compose down is not possible or failed' "$TD/out" && [ "$rmc" = "rm -f 1111 2222;network rm net1;" ] \
  && grep -q 'ps -aq --filter label=com.docker.compose.project=ddcnew' "$TD/calls" && grep -q 'network ls -q --filter label=com.docker.compose.project=ddcnew' "$TD/calls" \
  && grep -q '^PASS no ddcnew containers left' "$TD/out" && grep -q '^PASS old-stack containers unchanged (1 containers' "$TD/out" \
  && ok "99-teardown.sh, compose down fails -> removes only the ddcnew-labelled containers, then the ddcnew network; the old container untouched" || { cat "$TD/out"; cat "$TD/calls"; bad "teardown fallback (rc=$RC rm calls: $rmc)"; }
td 1
[ "$RC" = 1 ] && grep -q 'FAIL refusing: container(s) labelled project ddcnew without the ddcnew- name prefix: ddc-backend-ddc-backend-api-1' "$TD/out" && ! grep -qE '^(rm|network rm)' "$TD/calls" \
  && ok "teardown fallback refuses when a ddcnew-labelled container has another name: nothing removed" || { cat "$TD/out"; bad "teardown fallback name check (rc=$RC)"; }

# ---------------------------------------------------------------------------
echo; echo "== 13. public repository: no server address, 1Password reference or id, hash or key, or server finding in any committable file"
# test/helpers/public-repo-scan.sh on the package itself (git: tracked files + untracked files that are not ignored),
# then a negative control on a scratch copy with one injected violation per rule. The violations are assembled at run
# time, so this file carries none of them.
if out=$(bash "$PKG/test/helpers/public-repo-scan.sh" "$PKG" 2>&1); then ok "$(printf '%s\n' "$out" | tail -1 | sed 's/^PASS //')"
else printf '%s\n' "$out"; bad "public-repo-scan found the hits above (file:line [rule]; the matching text is never printed)"; fi
SC="$T/scan-control"; mkdir -p "$SC"
if git -C "$PKG" rev-parse --is-inside-work-tree >/dev/null 2>&1; then   # the committable files only (never local.env)
  while IFS= read -r -d '' f; do if [ -f "$PKG/$f" ]; then mkdir -p "$SC/$(dirname "$f")"; cp -p "$PKG/$f" "$SC/$f"; fi; done \
    < <(cd "$PKG" && git ls-files -z --cached --others --exclude-standard -- .)
else cp -R "$PKG/." "$SC/"; rm -rf "$SC/logs" "$SC/out" "$SC/local.env"; fi
oct() { printf '%s.%s.%s.%s' "$@"; }
mode=$((640 + 4))   # the file mode under test, computed so that this file does not trip the rule itself
{ printf 'allowed: loopback %s, documentation ranges %s %s\n' "$(oct 127 0 0 1)" "$(oct 203 0 113 7)" "$(oct 192 0 2 10)"
  printf 'allowed: chmod %s /etc/cron.d/x\n' "$mode"
  printf 'allowed: obvious test value %s1\n' "$(printf '0%.0s' $(seq 1 63))"; } > "$SC/control-allowed.txt"
{ printf 'address %s\n' "$(oct 198 18 7 9)"; printf 'escaped %s\\.%s\\.%s\\.%s\n' 198 18 7 9; } > "$SC/control-ip.txt"
printf 'reference op:%s//%s/%s/password\n' '' scanvault scanitem > "$SC/control-opref.txt"
printf 'hash %s%s%s%s\n' 0123456789abcdef 0123456789abcdef 0123456789abcdef 0123456789abcdef > "$SC/control-hex.txt"
printf 'id %s%s%s\n' abcdefghij 0123456789 klmnop > "$SC/control-opid.txt"
{ printf 'the env file is world-%s\n' readable; printf 'the vhost re%s any Origin\n' flects; } > "$SC/control-phrase.txt"
printf 'backend env mode %s\n' "$mode" > "$SC/control-mode.txt"
printf 'host %s\nvault %s\nitem %s\n' scan-host-17.example.net scanlocalvault scanlocalitem > "$SC/control-local.txt"
printf 'DDC_SSH_TARGET=ops@%s\nDDC_OP_SECRET_REF=op:%s//%s/%s/password\n' scan-host-17.example.net '' scanlocalvault scanlocalitem > "$SC/local.env"
rc=0; out=$(bash "$SC/test/helpers/public-repo-scan.sh" "$SC" 2>&1) || rc=$?
missing=""
for want in "control-ip.txt:1 [ip]" "control-ip.txt:2 [ip]" "control-opref.txt:1 [op-ref]" "control-hex.txt:1 [hex64]" "control-opid.txt:1 [op-id]" \
            "control-phrase.txt:1 [phrase: " "control-phrase.txt:2 [phrase: " "control-mode.txt:1 [mode]" \
            "control-local.txt:1 [local:host]" "control-local.txt:2 [local:vault]" "control-local.txt:3 [local:item]"; do
  printf '%s\n' "$out" | grep -qF "FAIL public-repo-scan: $want" || missing="$missing $want;"
done
leak=$(printf '%s\n' "$out" | grep -cE 'scan-host-17|scanlocal|scanvault|0123456789abcdef|198\.18|abcdefghij' || true)
if [ "$rc" = 1 ] && [ -z "$missing" ] && ! printf '%s\n' "$out" | grep -q 'control-allowed.txt' && [ "$leak" = 0 ]; then
  ok "negative control: every rule fires on its injected line (ip, escaped ip, op-ref, hex64, op-id, phrase, mode, local host/vault/item); loopback, documentation ranges, chmod 644 and an obvious test value pass; no matching text printed"
else printf '%s\n' "$out" | sed 's/^/    /' | head -40; bad "negative control (rc=$rc missing:$missing printed values: $leak)"; fi
printf 'DDC_SSH_TARGET=ops@%s\nDDC_OP_SECRET_REF=op:%s//%s/%s/password\n' "$(oct 198 18 44 5)" '' scanlocalvault scanlocalitem > "$SC/local.env"
printf 'prefix %s.%s.x\n' 198 18 > "$SC/control-prefix.txt"
rc=0; out=$(bash "$SC/test/helpers/public-repo-scan.sh" "$SC" 2>&1) || rc=$?
[ "$rc" = 1 ] && printf '%s\n' "$out" | grep -qF 'FAIL public-repo-scan: control-prefix.txt:1 [local:ipv4-prefix]' && ! printf '%s\n' "$out" | grep -q '198\.18' \
  && ok "negative control: an IPv4 target in local.env also flags its first octets written as a partial address (the x.y.x form)" || { printf '%s\n' "$out" | sed 's/^/    /' | head -20; bad "ipv4-prefix control (rc=$rc)"; }

# ---------------------------------------------------------------------------
echo; echo "== 14. partner info page (50-partner-page.sh): apply, verify, refusals; no secret or password in the files, output, logs or ps; nginx + headless Chromium"
# Inputs: the rehearsal env of section 3, re-run with the partner's addresses (documentation-range IP). 20-env.sh made
# the client secret there, so the dummy secret is a real 20-env.sh output; the two dummy page passwords (32 letters and
# digits) are made here. Every value stays in a file: the checks use grep -F -f, so none becomes a process argument.
PP="$T/partner"; mkdir -p "$PP"; PAGE="$PP/srv/ddcnew/partner-info"
pp_fmode=$((640 + 4))   # the page files' mode, computed so that this file does not trip the public-repo scan's mode rule
PW_VERSION=1.60.0       # playwright-core; its Chromium revision (1223) is the one in the local Playwright cache
REDIR1="https://203.0.113.7/pages/oauth/callback"; REDIR2="https://203.0.113.7/pages/oauth/cb2?env=test&v=2"; INIT="https://203.0.113.7/pages/login/login"
cp -Rp "$T/ddcnew" "$PP/ddcnew"; rm -rf "$PP/ddcnew/logs"
if DDC_LOCAL_TEST=1 NEW_DIR="$PP/ddcnew" OLD_ENV="$OLD" FE_ENV_TGE="$T/env.tge" REHEARSAL_REDIRECT_URIS="$REDIR1,$REDIR2" \
     REHEARSAL_INITIATE_LOGIN_URI="$INIT" bash "$PKG/20-env.sh" > "$PP/env20.out" 2>&1; then ok "20-env.sh with the partner's redirect and start-login URIs"
else tail -5 "$PP/env20.out"; bad "20-env.sh with the partner's addresses"; fi
SECF="$PP/ddcnew/secrets/tge_rehearsal_client_secret"
pw_gen() { python3 -c 'import secrets, string; a = string.ascii_letters + string.digits; print("".join(secrets.choice(a) for _ in range(32)), end="")'; }
( umask 077; pw_gen > "$PP/pw"; pw_gen > "$PP/pw-wrong"; { cat "$PP/pw"; echo; } > "$PP/pw.nl"; base64 < "$SECF" | tr -d '\n' > "$PP/secret.b64" )
echo "dummy secret: $(wc -c < "$SECF" | tr -d ' ') characters from 20-env.sh; page passwords: $(wc -c < "$PP/pw" | tr -d ' ') characters (pw.nl ends with a newline, as op read prints it)"
leak_count() { # <pattern file> <files...>: lines of the files that contain the value (never passed as an argument)
  local p="$1"; shift; cat "$@" 2>/dev/null | grep -cF -f "$p" || true; }
pprun() { # <command> <stdin file> [VAR=value...]: output in $PP/out, status in $RC (later VAR=value override earlier ones)
  local c="$1" in="$2"; shift 2; RC=0
  env DDC_LOCAL_TEST=1 NEW_DIR="$PP/ddcnew" SRV_DIR="$PP/srv/ddcnew" PARTNER_CRYPT_IMAGE=node:22-alpine DDC_TEST_SUFFIX="$SFX" "$@" \
    bash "$PKG/50-partner-page.sh" "$c" < "$in" > "$PP/out" 2>&1 || RC=$?
}
# ps sampler: every process's arguments AND environment (ps -E: the Mac's processes, the docker CLI included), plus the
# throwaway container's configuration (entrypoint, command, environment). Only counts are kept: the samples (which
# hold other processes' environments) never touch the disk.
pp_sampler() { # <counts file> <stop file>
  local snap
  while [ ! -e "$2" ]; do
    snap=$(ps -axwwE -o pid=,command= 2>/dev/null || true
           for id in $(docker ps -q --filter name=ddcnew-partner-crypt- 2>/dev/null || true); do
             docker inspect --format 'CONTAINER {{.Name}} env={{json .Config.Env}} entrypoint={{json .Config.Entrypoint}} cmd={{json .Config.Cmd}}' "$id" 2>/dev/null || true
           done)
    printf 'cli=%s ctr=%s secret=%s pw=%s wrong=%s\n' \
      "$(printf '%s\n' "$snap" | grep -c -- "--name ddcnew-partner-crypt-[0-9]*-$SFX " || true)" \
      "$(printf '%s\n' "$snap" | grep -c '^CONTAINER /ddcnew-partner-crypt-' || true)" \
      "$(printf '%s\n' "$snap" | grep -cF -f "$SECF" || true)" "$(printf '%s\n' "$snap" | grep -cF -f "$PP/pw" || true)" \
      "$(printf '%s\n' "$snap" | grep -cF -f "$PP/pw-wrong" || true)" >> "$1"
  done
}
rm -f "$PP/stop"; : > "$PP/ps-counts"
pp_sampler "$PP/ps-counts" "$PP/stop" & sampler=$!
pprun apply "$PP/pw.nl" PARTNER_ALLOWED_IP=203.0.113.7; cp "$PP/out" "$PP/apply1.out"; rc_apply=$RC
pprun verify "$PP/pw"; cp "$PP/out" "$PP/verify-right.out"; rc_right=$RC
pprun verify "$PP/pw-wrong"; cp "$PP/out" "$PP/verify-wrong.out"; rc_wrong=$RC
touch "$PP/stop"; wait "$sampler" 2>/dev/null || true
echo "--- 50-partner-page.sh apply output ---"; cat "$PP/apply1.out"; echo "--- end ---"
sha_of() { shasum -a 256 < "$1" | cut -c1-64; }
[ "$rc_apply" = 0 ] && grep -qxF "$PAGE/index.html mode $pp_fmode sha256=$(sha_of "$PAGE/index.html")" "$PP/apply1.out" \
  && grep -qxF "$PAGE/secret.json mode $pp_fmode sha256=$(sha_of "$PAGE/secret.json")" "$PP/apply1.out" \
  && ok "apply: index.html and secret.json written; it printed their paths, mode and sha256" || bad "apply (rc=$rc_apply)"
lsmode() { ls -ld "$1" | cut -c1-10; }
[ "$(lsmode "$PAGE/index.html")" = "-rw-r--r--" ] && [ "$(lsmode "$PAGE/secret.json")" = "-rw-r--r--" ] && [ "$(lsmode "$PAGE")" = drwxr-xr-x ] \
  && [ "$(lsmode "$PP/srv/ddcnew")" = drwxr-xr-x ] && [ "$(ls -A "$PAGE" | tr '\n' ' ')" = "index.html secret.json " ] \
  && ok "modes: both files rw-r--r-- in rwxr-xr-x directories (readable by nginx); no temporary file left" || bad "modes or leftovers: $(ls -lA "$PAGE" | tr '\n' ';')"
if python3 - "$PAGE/secret.json" "$SECF" <<'EOF'
import base64, json, sys
d = json.load(open(sys.argv[1]))
n = len(open(sys.argv[2], "rb").read().rstrip(b"\n"))
b = lambda k: base64.b64decode(d[k], validate=True)
good = (sorted(d) == ["ct", "iter", "iv", "kdf", "salt", "v"] and d["v"] == 1 and d["kdf"] == "PBKDF2-SHA256" and type(d["iter"]) is int
        and d["iter"] >= 600000 and len(b("salt")) == 16 and len(b("iv")) == 12 and len(b("ct")) == n + 16)
print("secret.json: fields=%s iter=%d salt=%dB iv=%dB ct=%dB (secret %dB + 16-byte GCM tag)" % (",".join(sorted(d)), d["iter"], len(b("salt")), len(b("iv")), len(b("ct")), n))
sys.exit(0 if good else 1)
EOF
then ok "secret.json is {v:1, kdf:PBKDF2-SHA256, iter>=600000, salt 16 B, iv 12 B, ct = secret + 16-byte tag}, base64"; else bad "secret.json structure"; fi
[ "$(leak_count "$SECF" "$PAGE/secret.json" "$PAGE/index.html")$(leak_count "$PP/secret.b64" "$PAGE/secret.json" "$PAGE/index.html")$(leak_count "$PP/pw" "$PAGE/secret.json" "$PAGE/index.html")" = 000 ] \
  && ok "no plaintext: neither file holds the secret (as text or base64) or the password" || bad "plaintext in the page files"
logs=$(ls "$PP"/ddcnew/logs/*-50-partner-page-*.log 2>/dev/null || true)
outs="$PP/apply1.out $PP/verify-right.out $PP/verify-wrong.out"
# shellcheck disable=SC2086  # file lists
n=$(leak_count "$SECF" $outs $logs)$(leak_count "$PP/pw" $outs $logs)$(leak_count "$PP/pw-wrong" $outs $logs)
[ "$n" = 000 ] && [ "$(printf '%s\n' "$logs" | grep -c .)" = 3 ] && ok "the output and the 3 server-side logs (apply, verify twice) hold neither the secret nor a password" || bad "output/log leak check ($n, logs: $(printf '%s\n' "$logs" | grep -c .))"
ps_sum=$(awk '{ for (i = 1; i <= NF; i++) { split($i, kv, "="); s[kv[1]] += kv[2] } } END { printf "samples=%d cli=%d ctr=%d secret=%d pw=%d wrong=%d", NR, s["cli"], s["ctr"], s["secret"], s["pw"], s["wrong"] }' "$PP/ps-counts")
case "$ps_sum" in
  *" secret=0 pw=0 wrong=0") case "$ps_sum" in *" cli=0 "*) bad "ps sampler never saw the throwaway container's docker run: inconclusive ($ps_sum)";;
                                                *) ok "ps during apply and both verify runs ($ps_sum: arguments and environment of every process; cli = samples showing the throwaway container's docker run, ctr = its configuration): neither the secret nor a password";; esac;;
  *) bad "ps showed the secret or a password ($ps_sum)";;
esac
[ "$rc_right" = 0 ] && [ "$(tail -1 "$PP/verify-right.out")" = match=yes ] && [ "$rc_wrong" = 1 ] && [ "$(tail -1 "$PP/verify-wrong.out")" = match=no ] \
  && ok "verify: match=yes with the password (exit 0); match=no with a wrong one (exit 1)" || bad "verify (right rc=$rc_right, wrong rc=$rc_wrong)"
miss=""
for s in 'issuer</span>: <span class="s">"https://tge-api.datadance.ai"' 'client_id</span>: <span class="s">"tge-rehearsal"' "redirect_uri</span>: <span class=\"s\">\"$REDIR1\"" \
         "<span class=\"val\">$REDIR1</span><span class=\"val\">https://203.0.113.7/pages/oauth/cb2?env=test&amp;v=2</span>" "<span class=\"val\">$INIT</span>" \
         '<span class="val">203.0.113.7</span>' '（北京时间）'; do
  grep -qF -- "$s" "$PAGE/index.html" || miss="$miss [$s]"
done
[ -z "$miss" ] && ! grep -q '{{[A-Z_]*}}' "$PAGE/index.html" && ! grep -qF '&v=2' "$PAGE/index.html" \
  && ok "index.html: issuer, client_id, both redirect URIs (& escaped), start-login URI, the allowed IP and the time filled in; no placeholder left" || bad "index.html values; missing:$miss"
cp "$PAGE/secret.json" "$PP/secret1.json"
pprun apply "$PP/pw.nl" PARTNER_ALLOWED_IP=203.0.113.7; rc2=$RC
pprun verify "$PP/pw"
[ "$rc2" = 0 ] && [ "$RC" = 0 ] && python3 -c 'import json, sys; a, b = (json.load(open(f)) for f in sys.argv[1:]); sys.exit(0 if a["salt"] != b["salt"] and a["iv"] != b["iv"] and a["ct"] != b["ct"] else 1)' "$PP/secret1.json" "$PAGE/secret.json" \
  && ok "a second apply draws a new salt and IV (new ciphertext); verify: $(tail -1 "$PP/out")" || bad "second apply (rc=$rc2, verify rc=$RC)"

echo "-- refusals (each must stop, print neither value and leave the page as it was)"
before=$(cat "$PAGE/index.html" "$PAGE/secret.json" | shasum -a 256)
refuse() { # <label> <expected text> <command> <stdin file> [VAR=value...]
  local label="$1" want="$2"; shift 2
  pprun "$@"
  if [ "$RC" != 0 ] && grep -qF -- "$want" "$PP/out" && [ "$(leak_count "$PP/pw" "$PP/out")$(leak_count "$SECF" "$PP/out")" = 00 ]; then ok "refused: $label"
  else sed 's/^/    /' "$PP/out" | tail -5; bad "not refused as expected: $label (rc=$RC)"; fi
}
: > "$PP/empty"; head -c 23 "$PP/pw" > "$PP/pw-short"
{ cat "$PP/pw"; printf ' \n'; } > "$PP/pw-blank"; { cat "$PP/pw"; printf '\r\n'; } > "$PP/pw-crlf"
refuse "empty stdin" "no page password on stdin" apply "$PP/empty" PARTNER_ALLOWED_IP=203.0.113.7
refuse "a 23-character password" "shorter than 24 characters" apply "$PP/pw-short" PARTNER_ALLOWED_IP=203.0.113.7
refuse "a password with a trailing blank" "starts or ends with a blank" apply "$PP/pw-blank" PARTNER_ALLOWED_IP=203.0.113.7
refuse "a password with a carriage return (CRLF)" "must be printable ASCII" apply "$PP/pw-crlf" PARTNER_ALLOWED_IP=203.0.113.7
refuse "no PARTNER_ALLOWED_IP" "PARTNER_ALLOWED_IP=<the partner server's address> is required" apply "$PP/pw.nl"
for ip in 203.0.113.256 203.0.113 203.0.113.07 a.b.c.d '203.0.113.7;x' '203.0.113.7,,203.0.113.8'; do
  refuse "PARTNER_ALLOWED_IP=$ip" "is not an IPv4 or IPv6 address" apply "$PP/pw.nl" "PARTNER_ALLOWED_IP=$ip"
done
mkdir -p "$PP/placeholder"; cp -Rp "$T/ddcnew" "$PP/placeholder/ddcnew"; rm -rf "$PP/placeholder/ddcnew/logs"
refuse "SSO_TGE_REDIRECT_URIS still the .invalid placeholder of 20-env.sh" ".invalid placeholder" apply "$PP/pw.nl" PARTNER_ALLOWED_IP=203.0.113.7 \
  NEW_DIR="$PP/placeholder/ddcnew" SRV_DIR="$PP/placeholder/srv"
mkdir -p "$PP/mismatch"; cp -Rp "$PP/ddcnew" "$PP/mismatch/ddcnew"; rm -rf "$PP/mismatch/ddcnew/logs"
( umask 077; openssl rand -hex 32 | tr -d '\n' > "$PP/mismatch/ddcnew/secrets/tge_rehearsal_client_secret" )
refuse "a secret file whose sha256 is not SSO_TGE_CLIENT_SECRET_SHA256 (the api would refuse it)" "differs from SSO_TGE_CLIENT_SECRET_SHA256" apply "$PP/pw.nl" \
  PARTNER_ALLOWED_IP=203.0.113.7 NEW_DIR="$PP/mismatch/ddcnew" SRV_DIR="$PP/mismatch/srv"
refuse "an image that is not on this host (the script never pulls)" "is not on this host" apply "$PP/pw.nl" PARTNER_ALLOWED_IP=203.0.113.7 PARTNER_CRYPT_IMAGE="ddcnew-absent:x-$SFX"
refuse "SRV_DIR under /root" "refuses SRV_DIR under /root" status /dev/null SRV_DIR=/root/srv
RC=0; env DDC_LOCAL_TEST=1 NEW_DIR="$PP/ddcnew" SRV_DIR="$PP/srv/ddcnew" bash "$PKG/50-partner-page.sh" apply extra < "$PP/pw.nl" > "$PP/out" 2>&1 || RC=$?
[ "$RC" != 0 ] && grep -q '^FAIL usage:' "$PP/out" && ok "refused: an extra argument (the password is never an argument)" || bad "extra argument (rc=$RC)"
RC=0; env DDC_LOCAL_TEST=1 NEW_DIR="$PP/ddcnew" SRV_DIR="$PP/srv/ddcnew" PARTNER_CRYPT_IMAGE=node:22-alpine PARTNER_ALLOWED_IP=203.0.113.7 \
  bash -x "$PKG/50-partner-page.sh" apply < "$PP/pw.nl" > "$PP/out" 2>&1 || RC=$?
[ "$RC" = 1 ] && grep -q '^FAIL refusing to run with xtrace' "$PP/out" && [ "$(leak_count "$PP/pw" "$PP/out")" = 0 ] && ok "refused: bash -x (xtrace would print the password), before it is read" || bad "xtrace (rc=$RC)"
for c in apply verify; do   # script(1) gives the script a pty as stdin
  RC=0; script -q /dev/null env DDC_LOCAL_TEST=1 NEW_DIR="$PP/ddcnew" SRV_DIR="$PP/srv/ddcnew" PARTNER_CRYPT_IMAGE=node:22-alpine \
    PARTNER_ALLOWED_IP=203.0.113.7 bash "$PKG/50-partner-page.sh" "$c" < /dev/null > "$PP/out" 2>&1 || RC=$?
  [ "$RC" = 1 ] && grep -q 'a terminal is refused' "$PP/out" && ok "refused: $c with a terminal on stdin (typing would echo the password)" || { cat "$PP/out"; bad "$c with a terminal (rc=$RC)"; }
done
[ "$(cat "$PAGE/index.html" "$PAGE/secret.json" | shasum -a 256)" = "$before" ] && [ "$(ls -A "$PAGE" | tr '\n' ' ')" = "index.html secret.json " ] \
  && [ ! -e "$PP/placeholder/srv/partner-info" ] && [ ! -e "$PP/mismatch/srv/partner-info" ] \
  && ok "every refusal left the installed page unchanged and created no other page" || bad "a refusal changed or created page files"

echo "-- status (read-only)"
nl0=$(ls "$PP/ddcnew/logs" | wc -l | tr -d ' ')
pprun status /dev/null; sed 's/^/  /' "$PP/out"
[ "$RC" = 0 ] && grep -qF "$PAGE/secret.json mode $pp_fmode bytes" "$PP/out" && grep -qF "sha256=$(sha_of "$PAGE/secret.json")" "$PP/out" \
  && [ "$(ls "$PP/ddcnew/logs" | wc -l | tr -d ' ')" = "$nl0" ] && ok "status: both files with mode and sha256; read-only (no run log)" || bad "status (rc=$RC)"

echo "-- the page behind nginx:stable (the section 4 render of the tge-app vhost), driven by headless Chromium"
if docker info >/dev/null 2>&1; then
  W="$PP/web"; mkdir -p "$W/sites"; cp "$NG/tge-app.datadance.ai" "$W/sites/"
  printf 'events {}\nhttp {\n  include /etc/nginx/mime.types;\n  include /etc/nginx/sites/*;\n}\n' > "$W/nginx.conf"
  WC="partnerweb-$RANDOM-$SFX"
  if docker run -d --name "$WC" -p 127.0.0.1::80 -v "$W/nginx.conf:/etc/nginx/nginx.conf:ro" -v "$W/sites:/etc/nginx/sites:ro" \
       -v "$PAGE:/srv/ddcnew/partner-info:ro" nginx:stable > /dev/null; then
    WPORT=$(docker port "$WC" 80/tcp | head -1 | sed 's/.*://'); URL="http://127.0.0.1:$WPORT/partner-info/"
    for _ in $(seq 1 40); do curl -s -o /dev/null "$URL" && break; sleep 0.25; done
    curl -s -D "$W/h-page" -o "$W/page.html" "$URL" || true; curl -s -D "$W/h-json" -o "$W/secret.json" "${URL}secret.json" || true
    miss=""
    for h in 'Cache-Control: no-store' 'X-Robots-Tag: noindex, nofollow' 'Referrer-Policy: no-referrer' 'X-Frame-Options: DENY' "Content-Security-Policy: $CSP"; do
      grep -qiF -- "$h" "$W/h-page" && grep -qiF -- "$h" "$W/h-json" || miss="$miss [$h]"
    done
    head -1 "$W/h-page" | grep -q ' 200' && grep -qi '^Content-Type: text/html' "$W/h-page" && grep -qi '^Content-Type: application/json' "$W/h-json" \
      && cmp -s "$W/page.html" "$PAGE/index.html" && cmp -s "$W/secret.json" "$PAGE/secret.json" && [ -z "$miss" ] \
      && ok "nginx:stable with the rendered tge-app vhost serves both files unchanged (text/html, application/json), each with no-store, noindex, no-referrer, DENY and the CSP" \
      || { sed 's/^/    /' "$W/h-page"; bad "nginx serving; missing headers:$miss"; }
    PWM="$T/playwright"
    if npm install --prefix "$PWM" --no-audit --no-fund --no-save --prefer-offline --loglevel=error "playwright-core@$PW_VERSION" > "$PP/npm.out" 2>&1; then
      printf '{"issuer":"https://tge-api.datadance.ai","client_id":"tge-rehearsal","redirects":["%s","%s"],"initiate":"%s","ips":["203.0.113.7"]}\n' \
        "$REDIR1" "$REDIR2" "$INIT" > "$PP/expect.json"
      if NODE_PATH="$PWM/node_modules" timeout 300 node "$PKG/test/helpers/partner-browser.js" "$URL" "$SECF" "$PP/pw" "$PP/pw-wrong" "$PP/expect.json" "$PP/shots" > "$PP/browser.out" 2>&1; then
        sed 's/^/  /' "$PP/browser.out"; ok "headless Chromium: a wrong password shows the error, the right one reveals exactly the dummy secret; copy, hide; no other origin (screenshots: $PP/shots)"
      else sed 's/^/  /' "$PP/browser.out"; bad "headless Chromium test"; fi
      [ "$(leak_count "$SECF" "$PP/browser.out")$(leak_count "$PP/pw" "$PP/browser.out")" = 00 ] && ok "the browser test printed neither the secret nor a password" || bad "the browser test output carries a secret"
    else tail -5 "$PP/npm.out"; bad "could not install playwright-core@$PW_VERSION (npm)"; fi
  else bad "could not start the nginx container $WC"; fi
  docker rm -f "$WC" > /dev/null 2>&1 || true
else bad "section 14 (nginx + browser) needs Docker Desktop"; fi

echo "-- remove"
pprun remove /dev/null; sed 's/^/  /' "$PP/out" | grep -vE '^  (run|lock|old-stack)' || true
[ "$RC" = 0 ] && [ ! -e "$PAGE" ] && [ ! -e "$PP/srv/ddcnew" ] && grep -q '^PASS partner info page removed' "$PP/out" \
  && ok "remove: the page directory and the then-empty /srv/ddcnew are gone; old stack unchanged" || bad "remove (rc=$RC)"
pprun remove /dev/null
[ "$RC" = 0 ] && grep -q 'does not exist' "$PP/out" && ok "remove again: nothing to do" || bad "second remove (rc=$RC)"
left=$(docker ps -a --format '{{.Names}}' | grep -c '^ddcnew-partner-crypt-' || true)
[ "$left" = 0 ] && ok "no throwaway crypt container left (docker run --rm)" || bad "$left ddcnew-partner-crypt-* container(s) left"

# ---------------------------------------------------------------------------
echo; echo "== cleanup"
if docker info >/dev/null 2>&1; then
  for c in $(docker ps -a --format '{{.Names}}' | grep -- "-$SFX\$" || true); do docker rm -fv "$c" >/dev/null 2>&1 && echo "removed leftover test container $c"; done
  if [ "${KEEP_TEST_IMAGES:-0}" != 1 ]; then
    for i in ddcnew-sshtest:jammy-$SFX ddcnew-sysdtest:jammy-$SFX; do docker image rm "$i" >/dev/null 2>&1 && echo "removed test image $i"; done
  else echo "KEEP_TEST_IMAGES=1: test images kept"; fi
  echo "test containers left: $(docker ps -a --format '{{.Names}}' | grep -c -- "-$SFX\$" || true); test images left: $(docker image ls --format '{{.Repository}}:{{.Tag}}' | grep -c -- "-$SFX\$" || true)"
fi

echo; echo "== summary: fails=$fails"
[ "$fails" = 0 ]
