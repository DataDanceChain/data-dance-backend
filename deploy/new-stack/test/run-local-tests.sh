#!/usr/bin/env bash
# run-local-tests.sh - LOCAL validation of the new-stack package (runs on the Mac; touches no server).
#   1. bash -n and shellcheck on every script
#   2. docker compose config on compose.yaml (no daemon needed)
#   3. 20-env.sh against a SYNTHETIC old env file (multi-line quoted values, comments, export prefixes,
#      duplicates, inline comments) in a scratch directory; twice (idempotency); leak check on its output;
#      compose's own env_file parser compares old and new values (counts only); the rehearsal credential
#      policy (signing keys removed, third-party credentials blanked, unknown credential fails closed).
#   4. 30-nginx.sh render + nginx -t (1.18 and stable) on SYNTHETIC vhost fixtures (test/fixtures/), with the default
#      hosts and ports and with overrides.
#   5. old-stack integrity (common.sh old_files_*): fake old tree with Race's vhosts and /root/ddc-mainnet stand-ins;
#      changes detected, this package's own vhost files ignored (and only those), short hashes only; ddc-mainnet-*
#      containers fingerprinted.
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
#   12b. (10-05) 30-nginx.sh never overwrites a vhost it did not write: Race's entries at the default names stop apply;
#      TAKE_OVER_VHOSTS=yes is refused until this stack answers on its own ports, then backs them up and replaces them,
#      restore puts them back byte for byte; any failure after the removal (before nginx -t, nginx -t itself, another
#      host changing after the reload) puts them back at once; a restore whose entries fail nginx -t brings this
#      package's back; an interrupted backup (SIGKILL) blocks nothing; only a vhost proxying to ddc-mainnet-* ports is
#      ever taken over (static sites, other upstreams, second names, docs.datadance.ai refused); a server_name clash
#      and a port held by another container stop apply; outcome B leaves Race's entries untouched and stops if his
#      hosts answer differently after the reload; teardown undoes the vhosts at the RECORDED hosts.
# Follow-ups of the 10-05 review:
#   3. REHEARSAL_CLIENT_ID (required, no default, the backend's rule, recorded only by a passing run) and the settings
#      record (each of the five names exactly once); 3a: this checkout's own src/server.js boots through every check on
#      the env 20-env.sh writes, and refuses tge-rehearsal (test/helpers/backend-boot.js).
#   10d. every allowlisted override with ;, $(), backticks, a newline or a CR is refused before connecting; the
#      settings, the client id and TAKE_OVER_VHOSTS are checked with the server's rules before connecting.
#   12. the Host-header checks after the reload, the https probe with SNI on 443 when it is served.
# Follow-ups of the review of #42 (10-06):
#   4. both copies serve this package's vhost token to 127.0.0.1 only. 12. the checks after a reload start with it; a
#      listener on 443 that never answers ends each probe at its time limit, with a WARN. 12b. after a take-over those
#      checks always run: a stack that stops answering, a host nginx that still serves the other party, a reload that
#      reports a failure and apply's final old-stack check each roll the take-over back exactly; the rollback compares the
#      other hosts again and reports its own failed reload; undo and 99-teardown.sh refuse until a take-over is restored;
#      restore keeps what a half-finished rollback already put back and arms its own rollback before it sets anything
#      aside; a take-over next to an entry of this package's is refused; S4 also refuses wildcard, regex and "_" names, a
#      default server, other includes, *_pass, a commented-out proxy_pass, a remote host, and takes over a certbot-style
#      vhost. 12c. TERM to the script, and TERM, HUP and INT to its whole process group, right after the removal: rolled
#      back exactly and logged, under bash 3.2 (macOS) and 5.1 (ubuntu:jammy).
# No check ends the run early: after the prologue the suite runs without set -e, so a broken state shows up as named
# FAIL lines, and an EXIT trap always runs the label-only cleanup.
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
#   never reads it, and a terminal is refused (10d). Without JavaScript the page offers no field and sends nothing,
#   even with the box forced visible and a form injected around the field (headless Chromium).
# Every SSH test uses scratch COPIES of the scripts with a test local.env (loopback only): the package's own local.env,
# if one exists, is never used to connect, and the real 1Password CLI is never called.
# Containers and images: every docker run and docker build of this run carries the label ddcnew-localtest=<run id>
# (RUN_ID, new for every run) and a name or tag with that id. Cleanup and every count use that label only, so other
# sessions' containers (whatever their names) are never stopped, removed or counted; an image is removed only when
# this run built it (KEEP_TEST_IMAGES=1 keeps them).
# Usage: test/run-local-tests.sh [new-scratch-dir]
set -euo pipefail
PKG="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
T="${1:-${TMPDIR:-/tmp}/ddcnew-localtest-$(date +%Y%m%d-%H%M%S)}"; T="${T%/}"
case "$T" in /*) ;; *) T="$PWD/$T";; esac   # docker -v needs an absolute path
case "$T" in /root*|/) echo "refusing scratch dir $T"; exit 1;; esac
[ ! -e "$T" ] || { echo "scratch dir $T exists; pass a new one"; exit 1; }
# This run's id: in the label of every container and image it creates, and in their names or tags.
RUN_ID="lt$(date +%Y%m%d%H%M%S)-$$-$RANDOM"
LT=(--label "ddcnew-localtest=$RUN_ID")
mkdir -p "$T/ddcnew"
fails=0; ok() { echo "PASS $*"; }; bad() { echo "FAIL $*"; fails=$((fails+1)); }
echo "run id: $RUN_ID (label ddcnew-localtest=$RUN_ID on every container and image this run creates)"
# The cleanup of this run's containers and images (by its label only). It runs once: at the end, or from the EXIT trap
# when the run ends early (an interrupted run, or a bug that ends the shell), so nothing of this run is ever left.
CLEANED=0
cleanup_run() {
  [ "$CLEANED" = 0 ] || return 0
  CLEANED=1
  echo; echo "== cleanup: only what this run created (label ddcnew-localtest=$RUN_ID); nothing is selected by name"
  docker info >/dev/null 2>&1 || return 0
  for id in $(docker ps -aq --filter "label=ddcnew-localtest=$RUN_ID"); do
    n=$(docker inspect --format '{{.Name}}' "$id" 2>/dev/null || echo "$id")
    docker rm -fv "$id" >/dev/null 2>&1 && echo "removed leftover container of this run: ${n#/}"
  done
  if [ "${KEEP_TEST_IMAGES:-0}" != 1 ]; then
    # Images this run built carry its label (docker build --label); nothing else does.
    for ref in $(docker image ls --filter "label=ddcnew-localtest=$RUN_ID" --format '{{.Repository}}:{{.Tag}}' | grep -v '<none>' || true); do
      docker image rm "$ref" >/dev/null 2>&1 && echo "removed image built by this run: $ref"
    done
    for id in $(docker image ls -q --filter "label=ddcnew-localtest=$RUN_ID" | LC_ALL=C sort -u); do docker image rm "$id" >/dev/null 2>&1 && echo "removed untagged image built by this run: $id"; done
  else echo "KEEP_TEST_IMAGES=1: the images this run built are kept (label ddcnew-localtest=$RUN_ID)"; fi
  c_left=$(docker ps -aq --filter "label=ddcnew-localtest=$RUN_ID" | grep -c . || true)
  i_left=$(docker image ls -q --filter "label=ddcnew-localtest=$RUN_ID" | grep -c . || true)
  [ "$c_left" = 0 ] && ok "this run's containers left: 0; its images left: $i_left" || bad "$c_left container(s) of this run left"
  now=$(docker ps -aq --no-trunc 2>/dev/null | LC_ALL=C sort || true)
  gone=$(LC_ALL=C comm -23 <(printf '%s\n' "${PRE_CONTAINERS:-}" | grep . || true) <(printf '%s\n' "$now" | grep . || true) | grep -c . || true)
  echo "containers that existed before this run: $(printf '%s\n' "${PRE_CONTAINERS:-}" | grep -c . || true), gone now: $gone (this run removes only containers with its own label, all created after it started)"
}
trap 'cleanup_run' EXIT
trap 'exit 130' INT; trap 'exit 143' TERM
# Containers that exist before this run (other sessions' included): reported at the end, never touched.
PRE_CONTAINERS=$(docker ps -aq --no-trunc 2>/dev/null | LC_ALL=C sort || true)
# The default settings this suite expects from common.sh (10-05: Race's host names, three free ports).
D_API_HOST=api-rehearsal.datadance.ai; D_APP_HOST=app-rehearsal.datadance.ai; D_API_PORT=10020; D_WEB_PORT=9021; D_DB_PORT=15434
DEFAULTS_SEEN=$( (unset API_HOST APP_HOST API_PORT WEB_PORT DB_PORT; . "$PKG/common.sh"; settings_env_lines) | tr '\n' ' ')
[ "$DEFAULTS_SEEN" = "API_HOST=$D_API_HOST APP_HOST=$D_APP_HOST API_PORT=$D_API_PORT WEB_PORT=$D_WEB_PORT DB_PORT=$D_DB_PORT " ] \
  && ok "common.sh defaults: $DEFAULTS_SEEN" || bad "common.sh defaults are $DEFAULTS_SEEN"
# The rehearsal client id this suite gives 20-env.sh (REHEARSAL_CLIENT_ID: required, no default; the api refuses tge and
# tge-rehearsal at boot since backend fd2d4e9).
CID=lt-partner-client
# From here on a failing command never ends the run: every check reports PASS or FAIL itself, so a broken state (a
# mutation, a slip in a refactoring) shows up as named FAIL lines, the summary is always printed, and the cleanup of
# this run's containers always runs (EXIT trap).
set +e

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
# 00-preflight.sh is self-contained: its copy of the vhost marker line must be common.sh's.
pm=$(sed -n "s/^VHOST_MARKER='\(.*\)'$/\1/p" "$PKG/00-preflight.sh"); cm=$(sed -n "s/^VHOST_MARKER='\(.*\)'$/\1/p" "$PKG/common.sh")
[ -n "$cm" ] && [ "$pm" = "$cm" ] && ok "00-preflight.sh and common.sh carry the same VHOST_MARKER line" || bad "VHOST_MARKER differs between 00-preflight.sh and common.sh"

echo; echo "== 2. docker compose config"
mkdir -p "$T/compose"; cp "$PKG/compose.yaml" "$T/compose/"
printf 'API_IMAGE=ddcnew/backend:0123456789ab\nWEB_IMAGE=ddcnew/web:tge-0123456789ab\n' > "$T/compose/.env"
printf 'NODE_ENV=production\n' > "$T/compose/.env.api"; printf 'POSTGRES_USER=u\nPOSTGRES_PASSWORD=p\nPOSTGRES_DB=d\n' > "$T/compose/.env.db"
# The host ports come from the settings (common.sh dc() passes them); without them compose refuses to interpolate.
export API_PORT="$D_API_PORT" WEB_PORT="$D_WEB_PORT" DB_PORT="$D_DB_PORT"
if (cd "$T/compose" && docker compose -f compose.yaml config -q); then ok "compose.yaml valid"; else bad "compose.yaml invalid"; fi
if (cd "$T/compose" && env -u API_PORT -u WEB_PORT -u DB_PORT docker compose -f compose.yaml config -q) > "$T/compose/noports.out" 2>&1; then bad "compose.yaml interpolated without the port settings"
else grep -qE '(API|WEB|DB)_PORT missing - common.sh dc\(\) passes the settings' "$T/compose/noports.out" && ok "without API_PORT / WEB_PORT / DB_PORT compose refuses to run (no default port; compose names whichever it meets first: $(grep -oE '(API|WEB|DB)_PORT missing' "$T/compose/noports.out" | head -1))" || bad "compose without ports: $(tail -1 "$T/compose/noports.out")"; fi
# Each of the three is required on its own (compose meets them in no fixed order, so each is left out alone).
for v in API_PORT WEB_PORT DB_PORT; do
  if (cd "$T/compose" && env -u "$v" API_PORT="${API_PORT:-$D_API_PORT}" WEB_PORT="${WEB_PORT:-$D_WEB_PORT}" DB_PORT="${DB_PORT:-$D_DB_PORT}" env -u "$v" docker compose -f compose.yaml config -q) > "$T/compose/no-$v.out" 2>&1; then bad "compose.yaml interpolated without $v"
  else grep -q "$v missing - common.sh dc() passes the settings" "$T/compose/no-$v.out" || bad "compose without $v: $(tail -1 "$T/compose/no-$v.out")"; fi
done
dcp=$( (unset API_PORT WEB_PORT DB_PORT; DDC_LOCAL_TEST=1; NEW_DIR="$T/compose"; . "$PKG/common.sh"; dc config --format json) | python3 -c '
import json, sys
c = json.load(sys.stdin)
print(" ".join(sorted("%s:%s->%s" % (p.get("host_ip"), p.get("published"), p.get("target")) for s in c["services"].values() for p in s.get("ports", []))))' || true)
[ "$dcp" = "127.0.0.1:$D_API_PORT->3000 127.0.0.1:$D_DB_PORT->5432 127.0.0.1:$D_WEB_PORT->80" ] && ok "common.sh dc() publishes the settings' ports: $dcp" || bad "dc() ports: $dcp"
dcp=$( (DDC_LOCAL_TEST=1; NEW_DIR="$T/compose"; API_PORT=10031 WEB_PORT=9031 DB_PORT=15441; . "$PKG/common.sh"; dc config --format json) | python3 -c '
import json, sys
c = json.load(sys.stdin)
print(" ".join(sorted(str(p.get("published")) for s in c["services"].values() for p in s.get("ports", []))))' || true)
[ "$dcp" = "10031 15441 9031" ] && ok "overridden ports reach compose through dc(): $dcp" || bad "dc() with overrides: $dcp"
unset API_PORT WEB_PORT DB_PORT
(cd "$T/compose" && API_PORT="$D_API_PORT" WEB_PORT="$D_WEB_PORT" DB_PORT="$D_DB_PORT" docker compose -f compose.yaml config --format json) | python3 -c '
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
(cd "$T/compose" && API_PORT="$D_API_PORT" WEB_PORT="$D_WEB_PORT" DB_PORT="$D_DB_PORT" docker compose -f compose.yaml config --format json) | python3 -c '
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
WEB3AUTH_CLIENT_ID=BGiGcxrXA-dummy-devnet-client-id-000000000000000000000000000000000000000000000000000000
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
# Run 1 names the client (REHEARSAL_CLIENT_ID is required, no default); run 2 has no override and reuses the record.
REHEARSAL_CLIENT_ID="$CID" run20 > "$T/run1.out" 2>&1 || { cat "$T/run1.out"; bad "20-env.sh run 1 failed"; }
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
# The retired (devnet) client id: written in full, printed as its first 8 characters only.
RID=$(sed -n 's/^WEB3AUTH_CLIENT_ID=//p' "$OLD" | tail -1); RID8=$(printf '%s' "$RID" | cut -c1-8); RID9=$(printf '%s' "$RID" | cut -c1-9)
[ "${#RID}" = 87 ] && [ "$(cat "$T/run1.out" "$T/run2.out" "$T"/ddcnew/logs/*.log | grep -cF -- "$RID9" || true)" = 0 ] \
  && grep -qF "PASS WEB3AUTH_RETIRED_CLIENT_IDS = the old WEB3AUTH_CLIENT_ID ($RID8..., the devnet id being retired), not the mainnet id" "$T/run1.out" \
  && grep -qxF "WEB3AUTH_RETIRED_CLIENT_IDS=\"$RID\"" "$T/ddcnew/.env.rehearsal" && grep -qxF 'LOGIN_MISSING_IDTOKEN_MEANS_OLD_APP="on"' "$T/ddcnew/.env.rehearsal" \
  && ok "WEB3AUTH_RETIRED_CLIENT_IDS = the old WEB3AUTH_CLIENT_ID (87 characters) in the file, only its first 8 characters in the output and the logs; LOGIN_MISSING_IDTOKEN_MEANS_OLD_APP=\"on\"" \
  || bad "the old-App names in .env.rehearsal or their printing"
grep -q '^PASS LOGIN_MISSING_IDTOKEN_MEANS_OLD_APP=on; WEB3AUTH_RETIRED_CLIENT_IDS: 1 entry, equal to neither WEB3AUTH_CLIENT_ID nor a WEB3AUTH_EXTERNAL_AUDIENCE entry' "$T/run1.out" \
  && grep -qF "PASS issuer PUBLIC_BASE_URL = API_BASE_URL = https://$D_API_HOST; consent origin APP_PUBLIC_URL = FRONTEND_URL = https://$D_APP_HOST" "$T/run1.out" \
  && ok "20-env.sh checks the issuer and the consent origin against the settings, and PR #38's boot rules on the old-App names" || bad "issuer / consent / old-App check lines missing"
grep -qF "settings: API_HOST=$D_API_HOST APP_HOST=$D_APP_HOST API_PORT=$D_API_PORT WEB_PORT=$D_WEB_PORT DB_PORT=$D_DB_PORT (defaults)" "$T/run1.out" \
  && grep -q '^settings recorded in ' "$T/run1.out" && grep -qF "(recorded in $T/ddcnew/settings.env)" "$T/run2.out" \
  && [ "$(tr '\n' ' ' < "$T/ddcnew/settings.env")" = "API_HOST=$D_API_HOST APP_HOST=$D_APP_HOST API_PORT=$D_API_PORT WEB_PORT=$D_WEB_PORT DB_PORT=$D_DB_PORT REHEARSAL_CLIENT_ID=$CID " ] \
  && ok "run 1 used the default settings and recorded them, with REHEARSAL_CLIENT_ID, in settings.env; run 2 used the record" || bad "settings record of 20-env.sh"
# B1: REHEARSAL_CLIENT_ID is required, has no default, follows the api's rule, and is recorded only by a run that passes.
grep -qx "rehearsal client id: $CID (override)" "$T/run1.out" && grep -qx "rehearsal client id: $CID (recorded in $T/ddcnew/settings.env)" "$T/run2.out" \
  && grep -qx "SSO_TGE_CLIENT_ID=\"$CID\"" "$T/ddcnew/.env.rehearsal" && grep -q "^PASS SSO_TGE_CLIENT_ID=$CID: matches" "$T/run1.out" \
  && ok "SSO_TGE_CLIENT_ID=$CID from REHEARSAL_CLIENT_ID on run 1, from the record on run 2 (no override)" || bad "client id from the override and the record"
cid20() { # <label> <NEW_DIR> [REHEARSAL_CLIENT_ID]: one 20-env.sh run, output in <NEW_DIR>.out, status in RC
  RC=0
  if [ $# -ge 3 ]; then DDC_LOCAL_TEST=1 NEW_DIR="$2" OLD_ENV="$OLD" FE_ENV_TGE="$T/env.tge" REHEARSAL_CLIENT_ID="$3" bash "$PKG/20-env.sh" > "$2.out" 2>&1 || RC=$?
  else DDC_LOCAL_TEST=1 NEW_DIR="$2" OLD_ENV="$OLD" FE_ENV_TGE="$T/env.tge" bash "$PKG/20-env.sh" > "$2.out" 2>&1 || RC=$?; fi
}
mkdir -p "$T/cid"
cid20 none "$T/cid/none"
[ "$RC" != 0 ] && grep -q '^FAIL REHEARSAL_CLIENT_ID=<the partner.s client id> is required, and has no default' "$T/cid/none.out" && [ ! -e "$T/cid/none/.env.rehearsal" ] \
  && ok "no REHEARSAL_CLIENT_ID and no record: 20-env.sh stops before it writes anything (no default)" || bad "missing client id (rc=$RC): $(grep '^FAIL' "$T/cid/none.out" | head -1)"
n=0
for v in tge tge-rehearsal 'a b' 'a:b' "$(printf 'x%.0s' $(seq 1 65))" 'https://x' 'id;x'; do
  n=$((n + 1)); cid20 "bad$n" "$T/cid/bad$n" "$v"
  if [ "$RC" != 0 ] && grep -qE '^FAIL REHEARSAL_CLIENT_ID(=| must match)' "$T/cid/bad$n.out" && [ ! -e "$T/cid/bad$n/.env.rehearsal" ] && [ ! -e "$T/cid/bad$n/settings.env" ]; then :
  else bad "REHEARSAL_CLIENT_ID='$v' was not refused before anything was written (rc=$RC)"; fi
done
ok "REHEARSAL_CLIENT_ID refused before anything is written: tge, tge-rehearsal (retired, the api refuses them at boot), a blank, a colon, 65 characters, a URL, a semicolon"
cp -Rp "$T/ddcnew" "$T/cid/rec"; rm -rf "$T/cid/rec/logs"
cid20 other "$T/cid/rec" lt-other-client
[ "$RC" != 0 ] && grep -qF "FAIL REHEARSAL_CLIENT_ID=lt-other-client differs from REHEARSAL_CLIENT_ID=$CID recorded in $T/cid/rec/settings.env" "$T/cid/rec.out" \
  && grep -qx "SSO_TGE_CLIENT_ID=\"$CID\"" "$T/cid/rec/.env.rehearsal" && ok "an override that differs from the recorded client id stops 20-env.sh; the installed env keeps $CID" || bad "client id conflict (rc=$RC)"
cid20 same "$T/cid/rec" "$CID"
[ "$RC" = 0 ] && ok "the same client id as the record is accepted" || bad "same client id refused (rc=$RC)"
# A run that fails leaves no client id in the record (it is recorded only once every check passed).
d="$T/cid/failing"; mkdir -p "$d"; cp "$OLD" "$d.env"; printf 'APIKEY=DUMMYSECRET-apikey\n' >> "$d.env"; RC=0
DDC_LOCAL_TEST=1 NEW_DIR="$d" OLD_ENV="$d.env" FE_ENV_TGE="$T/env.tge" REHEARSAL_CLIENT_ID="$CID" bash "$PKG/20-env.sh" > "$d.out" 2>&1 || RC=$?
[ "$RC" != 0 ] && [ -f "$d/settings.env" ] && ! grep -q '^REHEARSAL_CLIENT_ID=' "$d/settings.env" \
  && ok "a failing 20-env.sh run records the settings but not the client id" || bad "client id recorded by a failing run (rc=$RC)"
# S5: the record must hold each of the five settings exactly once (REHEARSAL_CLIENT_ID at most once), nothing else.
rec_case() { # <label> <record content> <expected FAIL text>
  local d="$T/rec-$1" rc=0
  mkdir -p "$d"; printf '%s' "$2" > "$d/settings.env"
  ( DDC_LOCAL_TEST=1; NEW_DIR="$d"; . "$PKG/common.sh"; require_server; echo REQ-OK ) > "$d.out" 2>&1 || rc=$?
  [ "$rc" != 0 ] && grep -qF -- "$3" "$d.out" && ! grep -q REQ-OK "$d.out" || bad "record '$1' was accepted or refused for another reason: $(tail -1 "$d.out")"
}
GOODREC=$(printf 'API_HOST=%s\nAPP_HOST=%s\nAPI_PORT=%s\nWEB_PORT=%s\nDB_PORT=%s\n' "$D_API_HOST" "$D_APP_HOST" "$D_API_PORT" "$D_WEB_PORT" "$D_DB_PORT")
rec_case empty '' 'holds API_HOST 0 times'
rec_case partial "$(printf '%s\n' "$GOODREC" | grep -v '^DB_PORT=')
" 'holds DB_PORT 0 times'
rec_case twice "$GOODREC
API_PORT=$D_API_PORT
" 'holds API_PORT 2 times'
rec_case unknown "$GOODREC
EXTRA=1
" 'has a line that is not API_HOST'
rec_case cidtwice "$GOODREC
REHEARSAL_CLIENT_ID=$CID
REHEARSAL_CLIENT_ID=$CID
" 'holds REHEARSAL_CLIENT_ID 2 times'
rec_case blankvalue "$(printf '%s\n' "$GOODREC" | sed 's/^WEB_PORT=.*/WEB_PORT=/')
" 'has a line that is not API_HOST'
d="$T/rec-good"; mkdir -p "$d"; printf '%s\n' "$GOODREC" > "$d/settings.env"
( DDC_LOCAL_TEST=1; NEW_DIR="$d"; . "$PKG/common.sh"; require_server; echo REQ-OK ) > "$d.out" 2>&1
grep -qx REQ-OK "$d.out" && ok "the settings record: an empty or partial record, a repeated or unknown name, a repeated client id and an empty value each stop require_server; a complete record passes" || bad "complete record refused: $(tail -1 "$d.out")"

echo; echo "== 3a. the backend's own boot code (src/server.js of this checkout) on the env 20-env.sh writes"
# test/helpers/backend-boot.js runs src/server.js with every boot check, src/app.js stubbed (nothing listens or
# connects), on .env.api exactly as 40-up.sh writes it: .env.rehearsal with the JWKS pins of the day (two well-formed
# thumbprints here). Its money-path and old-App lines then go through the same checks as in 40-up.sh.
REPO="$(cd "$PKG/../.." && pwd)"; BB="$T/boot"; mkdir -p "$BB"
if [ -f "$REPO/src/server.js" ] && [ -d "$REPO/node_modules/dotenv" ] && command -v node >/dev/null 2>&1; then
  mkapi() { # <.env.rehearsal> <out>
    { grep -vE '^[[:space:]]*(export[[:space:]]+)?WEB3AUTH_JWKS_PINNED_THUMBPRINTS[[:space:]]*=' "$1"
      printf '\n# 40-up.sh: Web3Auth JWKS pins (local test)\nWEB3AUTH_JWKS_PINNED_THUMBPRINTS="%s,%s"\n' "$(printf 'A%.0s' $(seq 1 43))" "$(printf 'b%.0s' $(seq 1 43))"; } > "$2"
  }
  boot() { (cd "$BB" && env -i PATH="$PATH" node "$PKG/test/helpers/backend-boot.js" "$REPO" "$1") > "$2" 2>&1; }
  mkapi "$T/ddcnew/.env.rehearsal" "$BB/env.api"
  rc=0; boot "$BB/env.api" "$BB/out" || rc=$?
  grep -E '^(Partner SSO|Old App|BOOT CHECKS)' "$BB/out" | sed 's/^/  /'
  mp=$(grep 'Partner SSO money-path assertions OK' "$BB/out" | tail -1)
  req=0; git -C "$REPO" merge-base --is-ancestor "$( . "$PKG/common.sh"; echo "$OLD_APP_COMMIT")" HEAD 2>/dev/null && req=1
  if [ "$rc" = 0 ] && grep -qx 'BOOT CHECKS OK' "$BB/out" && grep -q "^Partner SSO enabled \[prod\] client=$CID " "$BB/out" \
     && ( DDC_LOCAL_TEST=1; . "$PKG/common.sh"; money_path_fields_check "$mp" 2 ) > "$BB/mp.out" 2>&1 \
     && ( DDC_LOCAL_TEST=1; . "$PKG/common.sh"; old_app_line_check "$(cat "$BB/out")" "$(sed -n 's/^WEB3AUTH_CLIENT_ID=//p' "$OLD" | tail -1 | cut -c1-8)" "$req" ) > "$BB/oa.out" 2>&1; then
    ok "this checkout's src/server.js boots through every check on the env 20-env.sh wrote (client=$CID); its money-path line passes money_path_fields_check and its old-App line old_app_line_check (required: $req), as in 40-up.sh"
  else sed 's/^/    /' "$BB/out" "$BB/mp.out" "$BB/oa.out" 2>/dev/null | grep -v '^    {' | tail -12; bad "the backend's boot code on the env 20-env.sh wrote (rc=$rc)"; fi
  sed 's/^SSO_TGE_CLIENT_ID=.*/SSO_TGE_CLIENT_ID="tge-rehearsal"/' "$BB/env.api" > "$BB/env.retired"
  rc=0; boot "$BB/env.retired" "$BB/out.retired" || rc=$?
  [ "$rc" = 1 ] && grep -q '^BOOT CHECKS FAIL: .*SSO_TGE_CLIENT_ID cannot be tge or tge-rehearsal' "$BB/out.retired" \
    && ok "control: the same env with SSO_TGE_CLIENT_ID=tge-rehearsal stops the backend's boot ($(grep -o 'SSO_TGE_CLIENT_ID cannot be tge or tge-rehearsal' "$BB/out.retired"))" || bad "control: tge-rehearsal was not refused by the backend (rc=$rc)"
  leaks=$(cat "$BB/out" "$BB/out.retired" | grep -c DUMMYSECRET || true); for sf in "$T"/ddcnew/secrets/*; do leaks=$((leaks + $(cat "$BB/out" | grep -cF "$(cat "$sf")" || true))); done
  [ "$leaks" = 0 ] && ok "the backend's boot output carries no dummy or generated secret" || bad "the backend's boot output carries a secret ($leaks)"
else bad "section 3a needs this checkout's src/ and node_modules (npm ci in the repository) and node"; fi

echo; echo "== compose's own env_file parser: old vs new (counts only)"
mkdir -p "$T/parse"; cp "$OLD" "$T/parse/old.env"; cp "$T/ddcnew/.env.rehearsal" "$T/parse/new.env"
cat > "$T/parse/compose.yaml" <<'EOF'
services:
  old: { image: busybox, env_file: old.env }
  new: { image: busybox, env_file: new.env }
EOF
(cd "$T/parse" && docker compose config --format json) | D_API_HOST="$D_API_HOST" D_APP_HOST="$D_APP_HOST" CID="$CID" python3 -c '
import json, os, sys
API_HOST = os.environ["D_API_HOST"]; APP_HOST = os.environ["D_APP_HOST"]; CID = os.environ["CID"]
c = json.load(sys.stdin)
o = c["services"]["old"]["environment"]; n = c["services"]["new"]["environment"]
sets = """GOOGLE_WALLET_ISSUER_ID GOOGLE_WALLET_SERVICE_ACCOUNT GEMINI_API_KEY X_CLIENT_ID X_CLIENT_SECRET X_BEARER_TOKEN DATABASE_URL PUBLIC_BASE_URL APP_PUBLIC_URL FRONTEND_URL API_BASE_URL JWT_SECRET WEB3AUTH_CLIENT_ID WEB3AUTH_ALLOWED_VERIFIERS WEB3AUTH_RETIRED_CLIENT_IDS LOGIN_MISSING_IDTOKEN_MEANS_OLD_APP
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
       "WEB3AUTH_ALLOW_LEGACY_FALLBACK": "false", "WEB3AUTH_JWKS_PIN_MODE": "enforce", "SSO_TGE_ENABLED": "true", "SSO_TGE_CLIENT_ID": CID,
       "PUBLIC_BASE_URL": "https://" + API_HOST, "APP_PUBLIC_URL": "https://" + APP_HOST, "FRONTEND_URL": "https://" + APP_HOST,
       "API_BASE_URL": "https://" + API_HOST, "SSO_TGE_CLIENT_NAME": "DDC TGE",
       "WEB3AUTH_RETIRED_CLIENT_IDS": o.get("WEB3AUTH_CLIENT_ID"), "LOGIN_MISSING_IDTOKEN_MEANS_OLD_APP": "on",
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
  DDC_LOCAL_TEST=1 NEW_DIR="$d/ddcnew" OLD_ENV="$d/old.env" FE_ENV_TGE="$T/env.tge" REHEARSAL_CLIENT_ID="$CID" bash "$PKG/20-env.sh" > "$d/out" 2>&1 || rc=$?
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
# The retired id (PR #38): the old env's WEB3AUTH_CLIENT_ID must be there, differ from the mainnet id and look like an id.
for c in "empty|WEB3AUTH_CLIENT_ID=|is empty" "mainnet|WEB3AUTH_CLIENT_ID=BBpkxUTUr-synthetic-local-test-client-id|is the new mainnet id" \
         "shape|WEB3AUTH_CLIENT_ID=BGiGcxrXA-too-short|does not look like a Web3Auth client id"; do
  lbl=${c%%|*}; r=${c#*|}; line=${r%%|*}; want=${r#*|}
  d="$T/neg-retired-$lbl"; mkdir -p "$d/ddcnew"; cp "$OLD" "$d/old.env"; printf '%s\n' "$line" >> "$d/old.env"; rc=0
  DDC_LOCAL_TEST=1 NEW_DIR="$d/ddcnew" OLD_ENV="$d/old.env" FE_ENV_TGE="$T/env.tge" REHEARSAL_CLIENT_ID="$CID" bash "$PKG/20-env.sh" > "$d/out" 2>&1 || rc=$?
  if [ "$rc" != 0 ] && grep -q "^FAIL WEB3AUTH_RETIRED_CLIENT_IDS: the old env's WEB3AUTH_CLIENT_ID $want" "$d/out" && [ ! -e "$d/ddcnew/.env.rehearsal" ] \
     && ! grep -qF -- "BBpkxUTUr-synthetic" "$d/out"; then ok "retired client id: the old WEB3AUTH_CLIENT_ID $want -> 20-env.sh stops, no .env.rehearsal"
  else sed 's/^/    /' "$d/out" | tail -3; bad "retired client id case '$lbl' (rc=$rc)"; fi
done
# PR #38's production boot rules (common.sh old_app_env_check): positions only in the messages, values never printed.
oa() { ( . "$PKG/common.sh"; old_app_env_check "$@"; echo "count=$OLD_APP_RETIRED_COUNT" ) 2>&1 | tail -1 || true; }
A=BGiGcxrXA-oa-test-a; B=BBpkxUTUr-oa-test-b
r1=$(oa "$A" "$B" "" on); r2=$(oa " $A , ,$B" "$B" "" on); r3=$(oa "$A" "$B" "x, $A " on); r4=$(oa "$A" "$B" "" true); r5=$(oa "$A" "$B" "" off)
[ "$r1" = count=1 ] && [ "$r2" = "FAIL WEB3AUTH_RETIRED_CLIENT_IDS entry #2 equals WEB3AUTH_CLIENT_ID: a retired client id must not be an accepted ID token audience" ] \
  && [ "$r3" = "FAIL WEB3AUTH_RETIRED_CLIENT_IDS entry #1 equals a WEB3AUTH_EXTERNAL_AUDIENCE entry: a retired client id must not be an accepted ID token audience" ] \
  && [ "$r4" = "FAIL LOGIN_MISSING_IDTOKEN_MEANS_OLD_APP must be on or off (backend PR #38 stops the boot on anything else)" ] && [ "$r5" = count=1 ] \
  && ok "old_app_env_check mirrors PR #38: a retired id equal to WEB3AUTH_CLIENT_ID or to a WEB3AUTH_EXTERNAL_AUDIENCE entry (comma lists trimmed, empties dropped) stops; LOGIN_MISSING_IDTOKEN_MEANS_OLD_APP only on or off" \
  || bad "old_app_env_check: [$r1] [$r2] [$r3] [$r4] [$r5]"
# Outcome B (other names): the overrides reach every host value; a later override that differs from the record stops.
d="$T/hosts-b"; mkdir -p "$d/ddcnew"; rc=0
DDC_LOCAL_TEST=1 NEW_DIR="$d/ddcnew" OLD_ENV="$OLD" FE_ENV_TGE="$T/env.tge" REHEARSAL_CLIENT_ID="$CID" API_HOST=api-coexist.datadance.ai APP_HOST=app-coexist.datadance.ai bash "$PKG/20-env.sh" > "$d/out" 2>&1 || rc=$?
gv() { sed -n "s/^$1=\"\(.*\)\"$/\1/p" "$d/ddcnew/.env.rehearsal" | tail -1; }
[ "$rc" = 0 ] && [ "$(gv PUBLIC_BASE_URL) $(gv API_BASE_URL) $(gv APP_PUBLIC_URL) $(gv FRONTEND_URL)" = "https://api-coexist.datadance.ai https://api-coexist.datadance.ai https://app-coexist.datadance.ai https://app-coexist.datadance.ai" ] \
  && grep -q '^API_HOST=api-coexist.datadance.ai$' "$d/ddcnew/settings.env" && ok "API_HOST / APP_HOST overrides: PUBLIC_BASE_URL, API_BASE_URL, APP_PUBLIC_URL and FRONTEND_URL follow them, and settings.env records them" \
  || { tail -3 "$d/out"; bad "20-env.sh with host overrides (rc=$rc)"; }
rc=0; DDC_LOCAL_TEST=1 NEW_DIR="$d/ddcnew" OLD_ENV="$OLD" FE_ENV_TGE="$T/env.tge" API_HOST=api-other.datadance.ai bash "$PKG/20-env.sh" > "$d/out2" 2>&1 || rc=$?
[ "$rc" != 0 ] && grep -q '^FAIL API_HOST=api-other.datadance.ai differs from API_HOST=api-coexist.datadance.ai recorded in ' "$d/out2" \
  && [ "$(gv PUBLIC_BASE_URL)" = https://api-coexist.datadance.ai ] && ok "an override that differs from the recorded settings stops 20-env.sh (99-teardown.sh first); the file is unchanged" || bad "settings conflict (rc=$rc)"
for o in API_HOST=api.datadance.ai APP_HOST=x.datadance.co API_PORT=10000 WEB_PORT=abc TAKE_OVER_VHOSTS=maybe; do
  rc=0; DDC_LOCAL_TEST=1 NEW_DIR="$T/hosts-bad" OLD_ENV="$OLD" FE_ENV_TGE="$T/env.tge" REHEARSAL_CLIENT_ID="$CID" env "$o" bash "$PKG/20-env.sh" > "$T/hosts-bad.out" 2>&1 || rc=$?
  [ "$rc" != 0 ] && grep -q "^FAIL ${o%%=*}" "$T/hosts-bad.out" || bad "setting $o was not refused: $(tail -1 "$T/hosts-bad.out")"
done
[ ! -e "$T/hosts-bad/settings.env" ] && ok "invalid settings refused before anything is written (a production host, another domain, an old-stack port, a non-number, TAKE_OVER_VHOSTS=maybe)" || bad "a refused setting was recorded"
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
  jrc=0; docker run --rm "${LT[@]}" --name "env20-$RANDOM-$RUN_ID" --user "$(id -u):$(id -g)" -e DDC_LOCAL_TEST=1 -e NEW_DIR="$T/ddcnew" -e OLD_ENV="$OLD" -e FE_ENV_TGE="$T/env.tge" \
    -v "$PKG:$PKG:ro" -v "$J/ddcnew:$T/ddcnew" -v "$OLD:$OLD:ro" -v "$T/env.tge:$T/env.tge:ro" -v "$J/bin:/stubbin:ro" ubuntu:jammy \
    bash -c 'export PATH="/stubbin:$PATH"; exec bash "$0/20-env.sh"' "$PKG" > "$J/run3.out" 2>&1 || jrc=$?
  awkv=$(docker run --rm "${LT[@]}" --name "awkv-$RANDOM-$RUN_ID" ubuntu:jammy bash -c 'readlink -f "$(command -v awk)"; awk -W version 2>&1 | head -1' | tr '\n' ' ')
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
MARKER=$(sed -n "s/^VHOST_MARKER='\(.*\)'$/\1/p" "$PKG/common.sh")
[ "$(head -n 1 "$NG/$D_API_HOST")" = "$MARKER" ] && [ "$(head -n 1 "$NG/$D_APP_HOST")" = "$MARKER" ] \
  && grep -qx "    server_name $D_API_HOST;" "$NG/$D_API_HOST" && grep -q "proxy_pass http://localhost:$D_API_PORT;" "$NG/$D_API_HOST" \
  && grep -qx "    server_name $D_APP_HOST;" "$NG/$D_APP_HOST" && grep -q "proxy_pass http://localhost:$D_WEB_PORT;" "$NG/$D_APP_HOST" \
  && ok "default render: files $D_API_HOST and $D_APP_HOST, each starting with the ddcnew marker line; upstreams localhost:$D_API_PORT and localhost:$D_WEB_PORT" \
  || bad "default render names, marker or upstream ports"
# The partner info page location (section 14 serves the page through it): the app copy only, once, with these exact headers.
CSP="default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; form-action 'none'; base-uri 'none'"
miss=""
for l in 'location ^~ /partner-info/ {' 'alias /srv/ddcnew/partner-info/;' 'add_header Cache-Control "no-store" always;' \
         'add_header X-Robots-Tag "noindex, nofollow" always;' 'add_header Referrer-Policy "no-referrer" always;' \
         'add_header X-Frame-Options "DENY" always;' 'add_header X-Content-Type-Options "nosniff" always;' "add_header Content-Security-Policy \"$CSP\" always;"; do
  [ "$(grep -cF -- "$l" "$NG/$D_APP_HOST" || true)" = 1 ] || miss="$miss [$l]"
done
[ -z "$miss" ] && [ "$(grep -c 'partner-info' "$NG/$D_API_HOST" || true)" = 0 ] && ! grep -q 'fonts\.g' "$NG/$D_APP_HOST" \
  && ok "app copy: one /partner-info/ location (alias /srv/ddcnew/partner-info/, no-store, noindex, no-referrer, DENY, nosniff, the CSP with form-action 'none' and base-uri 'none', no Google Fonts); api copy: none" \
  || bad "partner-info location in the rendered copies; missing or repeated:$miss"
# This package's vhost token location (common.sh host_checks): in both copies, once, with the token of vhost-token (32 hex
# characters, mode 600), answered to 127.0.0.1 only.
TOK=$(cat "$T/ddcnew/vhost-token" 2>/dev/null || true); tl=0
for f in "$NG/$D_API_HOST" "$NG/$D_APP_HOST"; do
  [ "$(grep -c 'location = /.well-known/ddcnew-vhost-token {' "$f")" = 1 ] && [ "$(grep -cF "return 200 \"$TOK\";" "$f")" = 1 ] \
    && [ "$(grep -c 'allow 127.0.0.1;' "$f")" = 1 ] && [ "$(grep -c 'deny all;' "$f")" = 1 ] && tl=$((tl + 1))
done
[[ "$TOK" =~ ^[0-9a-f]{32}$ ]] && [ "$tl" = 2 ] && [ "$(stat -f %Lp "$T/ddcnew/vhost-token")" = 600 ] \
  && ok "both copies: one vhost token location (the 32-hex token of vhost-token, mode 600), answered to 127.0.0.1 only" || bad "vhost token location in the rendered copies (tl=$tl)"
# Outcome B: other names and ports render the same way.
NGB="$T/nginx-b"; mkdir -p "$NGB"
if DDC_LOCAL_TEST=1 NEW_DIR="$T/nginx-b-new" API_HOST=api-coexist.datadance.ai APP_HOST=app-coexist.datadance.ai API_PORT=10031 WEB_PORT=9031 \
     bash "$PKG/30-nginx.sh" render "$PKG/test/fixtures/api.datadance.co" "$PKG/test/fixtures/app.datadance.co" "$NGB" > "$T/render-b.out" 2>&1 \
   && grep -qx "    server_name api-coexist.datadance.ai;" "$NGB/api-coexist.datadance.ai" && grep -q 'proxy_pass http://localhost:10031;' "$NGB/api-coexist.datadance.ai" \
   && grep -qx "    server_name app-coexist.datadance.ai;" "$NGB/app-coexist.datadance.ai" && grep -q 'proxy_pass http://localhost:9031;' "$NGB/app-coexist.datadance.ai" \
   && [ "$(grep -c 'location \^~ /partner-info/' "$NGB/app-coexist.datadance.ai")" = 1 ]; then
  ok "render with API_HOST/APP_HOST/API_PORT/WEB_PORT overrides: the names, server_name lines and upstream ports follow the settings"
else cat "$T/render-b.out"; bad "render with overrides"; fi
if docker info >/dev/null 2>&1; then
  mkdir -p "$NG/conf"
  cp "$PKG/test/fixtures/api.datadance.co" "$PKG/test/fixtures/app.datadance.co" "$NG/$D_API_HOST" "$NG/$D_APP_HOST" "$NG/conf/"
  printf 'events {}\nhttp {\n  include /etc/nginx/mime.types;\n  include /etc/nginx/sites/*;\n}\n' > "$NG/nginx.conf"
  for variant in old-only with-rehearsal; do
    [ "$variant" = old-only ] && sel="api.datadance.co app.datadance.co" || sel="api.datadance.co app.datadance.co $D_API_HOST $D_APP_HOST"
    mkdir -p "$NG/$variant"; for f in $sel; do cp "$NG/conf/$f" "$NG/$variant/"; done
    for img in nginx:1.18 nginx:stable; do   # 1.18 = the Ubuntu 22.04 server's major version
      if docker run --rm "${LT[@]}" --name "nginxtest-$variant-${img#nginx:}-$RUN_ID" -v "$NG/nginx.conf:/etc/nginx/nginx.conf:ro" -v "$NG/$variant:/etc/nginx/sites:ro" "$img" nginx -t > "$T/nginx-$variant.out" 2>&1; then
        ok "nginx -t $img ($variant): $(tail -1 "$T/nginx-$variant.out")"
      else cat "$T/nginx-$variant.out"; bad "nginx -t $img ($variant)"; fi
    done
  done
else
  echo "docker daemon not running: nginx -t on the rendered files skipped"
fi

# ---------------------------------------------------------------------------
echo; echo "== 5. old-stack integrity: files and containers (common.sh old_files_snapshot / old_snapshot_assert)"
# A fake server tree: the old stack's files, Race's vhosts (one at the default API name, his older tge-api file), this
# package's own vhost at the default APP name (marker line) with its .new temporary and link, and a stand-in for
# /root/ddc-mainnet with a data directory that a (stub) container mounts read-write and a .git directory.
O="$T/oldtree"; AV="$O/nginx/sites-available"; EN="$O/nginx/sites-enabled"
mkdir -p "$O/ddc-backend/overlays/sub" "$O/ddc" "$AV" "$EN" "$O/ddc-mainnet/pgdata" "$O/ddc-mainnet/.git" "$O/bin" "$O/bin2"
printf 'A=1\n' > "$O/ddc-backend/backend.env"; printf 'services: {}\n' > "$O/ddc-backend/docker-compose.yaml"; printf 'services: {}\n' > "$O/ddc/docker-compose.yml"
printf 'x\n' > "$O/ddc-backend/overlays/a.js"; printf 'y\n' > "$O/ddc-backend/overlays/sub/b.js"
for v in api.datadance.co app.datadance.co admin.datadance.co; do printf 'server {}\n' > "$AV/$v"; done
race_api() { printf 'server { server_name %s; location / { proxy_pass http://localhost:10010; } }\n' "$D_API_HOST" > "$AV/$D_API_HOST"; }   # Race's (fixture)
race_old() { printf 'server { server_name tge-api.datadance.ai; }\n' > "$AV/tge-api.datadance.ai"; }                                        # Race's older file (fixture)
race_api; race_old
{ printf '%s\n' "$MARKER"; printf 'server {}\n'; } > "$AV/$D_APP_HOST"; { printf '%s\n' "$MARKER"; printf 'server {}\n'; } > "$AV/$D_APP_HOST.new"
ln -s "$AV/api.datadance.co" "$EN/api.datadance.co"; ln -s "../sites-available/$D_API_HOST" "$EN/$D_API_HOST"; ln -s "$AV/$D_APP_HOST" "$EN/$D_APP_HOST"
printf 'services: {}\n' > "$O/ddc-mainnet/compose.yaml"; printf 'X=1\n' > "$O/ddc-mainnet/.env"; printf '17\n' > "$O/ddc-mainnet/pgdata/PG_VERSION"; printf 'ref\n' > "$O/ddc-mainnet/.git/HEAD"
# stub docker: one container that mounts the mainnet data directory read-write (old_files only reads the mounts)
printf '#!/bin/sh\ncase "$1" in ps) echo c1;; inspect) case "$*" in *Mounts*) echo "%s";; esac;; esac\nexit 0\n' "$O/ddc-mainnet/pgdata" > "$O/bin/docker"
# stub docker: the live stack's db, Race's ddc-mainnet-api (its start time from MAINNET_STARTED), this package's
# ddcnew-api-1 and an unrelated container
cat > "$O/bin2/docker" <<'STUB'
#!/bin/sh
case "$1" in
  ps) printf '%s\n' ddc-backend-ddc-backend-db-1 ddc-mainnet-api ddcnew-api-1 other-1;;
  inspect) for n; do :; done
           case "$n" in
             ddc-mainnet-api) echo "/ddc-mainnet-api|m1|running|${MAINNET_STARTED:-t0}|0|unless-stopped";;
             ddc-backend-ddc-backend-db-1) echo "/ddc-backend-ddc-backend-db-1|d1|running|t0|0|always";;
             *) echo "/$n|x|running|t0|0|no";;
           esac;;
esac
exit 0
STUB
chmod 755 "$O/bin/docker" "$O/bin2/docker"
ienv() { DDC_LOCAL_TEST=1; NEW_DIR="$T/ddcnew"; OLD_BACKEND_DIR="$O/ddc-backend"; OLD_APP_DIR="$O/ddc"; OLD_ENV="$O/ddc-backend/backend.env"
  NGINX_AVAIL="$AV"; NGINX_ENABLED="$EN"; MAINNET_DIR="$O/ddc-mainnet"; PATH="$O/bin:$PATH"; }
# shellcheck source=../common.sh
integ() { ( ienv; . "$PKG/common.sh"; OLD_FILES_BEFORE="$(old_files_snapshot)"; "$@"; old_files_compare ); }
snapfiles() { ( ienv; . "$PKG/common.sh"; old_files_snapshot ); }
sf=$(snapfiles); n=$(printf '%s\n' "$sf" | grep -c .)
if [ "$n" = 14 ] && printf '%s\n' "$sf" | grep -q " $AV/$D_API_HOST\$" && printf '%s\n' "$sf" | grep -q " $EN/$D_API_HOST\$" && printf '%s\n' "$sf" | grep -q " $AV/tge-api.datadance.ai\$" \
   && ! printf '%s\n' "$sf" | grep -qF " $AV/$D_APP_HOST" && ! printf '%s\n' "$sf" | grep -qF " $EN/$D_APP_HOST" \
   && printf '%s\n' "$sf" | grep -q " $O/ddc-mainnet/compose.yaml\$" && ! printf '%s\n' "$sf" | grep -qE 'pgdata|/\.git/'; then
  ok "fingerprinted 14 entries: backend.env, 2 compose, 2 overlays, 5 vhost files and 2 links not written by this package (Race's at the default API name included), 2 files of the ddc-mainnet stand-in; this package's own file, .new and link excluded; the read-write mounted data directory and .git left out"
else printf '%s\n' "$sf" | sed 's/^/    /'; bad "expected 14 fingerprinted entries, got $n"; fi
integ true > "$T/integ0.out" 2>&1 && ok "no change -> compare passes" || bad "no change reported a difference"
integ sh -c "printf 'changed\n' >> '$AV/$D_APP_HOST'; printf 'z\n' >> '$AV/$D_APP_HOST.new'" > "$T/integ1.out" 2>&1 && ok "changes to this package's own vhost file and .new (marker line kept) are ignored" || bad "a change to this package's own file was reported"
for c in "Race's vhost at our API name|printf 'x\n' >> '$AV/$D_API_HOST'" "Race's older tge-api file|printf 'x\n' >> '$AV/tge-api.datadance.ai'" \
         "Race's link at our API name, pointed elsewhere|ln -sfn ../sites-available/tge-api.datadance.ai '$EN/$D_API_HOST'" \
         "a file under /root/ddc-mainnet|printf 'Y=2\n' >> '$O/ddc-mainnet/.env'" "a new file under /root/ddc-mainnet|printf 'n\n' > '$O/ddc-mainnet/extra.yaml'"; do
  lbl=${c%%|*}; cmd=${c#*|}
  if integ sh -c "$cmd" > "$T/integ-x.out" 2>&1; then bad "not detected: $lbl"; else ok "detected: $lbl ($(grep -cE '^  (before|after ) ' "$T/integ-x.out") before/after lines)"; fi
  rm -f "$O/ddc-mainnet/extra.yaml"; printf 'X=1\n' > "$O/ddc-mainnet/.env"; race_api; race_old; ln -sfn "../sites-available/$D_API_HOST" "$EN/$D_API_HOST"
done
integ sh -c "printf '18\n' > '$O/ddc-mainnet/pgdata/PG_VERSION'; printf 'ref2\n' > '$O/ddc-mainnet/.git/HEAD'" > "$T/integ-rw.out" 2>&1 \
  && ok "changes inside the read-write mounted data directory and .git of the ddc-mainnet stand-in are not reported (data the container writes itself)" || bad "data directory change reported"
if integ sh -c "printf 'B=2\n' >> '$O/ddc-backend/backend.env'; printf 'w\n' >> '$O/ddc-backend/overlays/sub/b.js'; rm '$O/ddc/docker-compose.yml'; printf 'new\n' > '$AV/business.datadance.co'" > "$T/integ2.out" 2>&1; then bad "changes not detected"
else
  sed 's/^/  expected> /' "$T/integ2.out"
  c=$(grep -cE '^  (before|after ) ' "$T/integ2.out" || true)
  long=$(grep -cE '[0-9a-f]{13,}' "$T/integ2.out" || true)
  [ "$c" = 7 ] && [ "$long" = 0 ] && grep -q 'MISSING .*docker-compose.yml' "$T/integ2.out" && ! grep -qE 'B=2|^w$' "$T/integ2.out" && ok "4 changes detected (edit, overlay edit, removal, new vhost): 7 before/after lines, 12-char hashes only, no file content" || bad "diff output wrong (lines=$c long_hashes=$long)"
fi
if ( ienv; . "$PKG/common.sh"; old_snapshot_begin; printf 'C=3\n' >> "$O/ddc-backend/backend.env"; old_snapshot_assert ) > "$T/integ3.out" 2>&1; then bad "old_snapshot_assert did not fail"
else
  sed 's/^/  expected> /' "$T/integ3.out"
  grep -q 'teammate may have changed' "$T/integ3.out" && grep -q '^FAIL old-stack integrity check failed' "$T/integ3.out" && ok "old_snapshot_assert FAILS loudly and names a possible teammate change" || bad "old_snapshot_assert message wrong"
fi
# Containers: every ddc-* container, Race's ddc-mainnet-* included; ddcnew-* and others are not in the snapshot.
cs=$( ( ienv; PATH="$O/bin2:$PATH"; . "$PKG/common.sh"; old_snapshot ) | cut -d'|' -f1 | tr '\n' ' ')
[ "$cs" = "/ddc-backend-ddc-backend-db-1 /ddc-mainnet-api " ] && ok "container snapshot: the live stack's and Race's ddc-mainnet-* containers, not ddcnew-* or unrelated ones ($cs)" || bad "container snapshot: $cs"
if ( ienv; PATH="$O/bin2:$PATH"; . "$PKG/common.sh"; old_snapshot_begin; export MAINNET_STARTED=t1; old_snapshot_assert ) > "$T/integ4.out" 2>&1; then bad "a restart of ddc-mainnet-api was not detected"
else
  grep -q '^old-stack containers: 2, of them ddc-mainnet-\*: 1 ' "$T/integ4.out" && grep -q 'FAIL old-stack containers changed during this script' "$T/integ4.out" \
    && ok "a restarted ddc-mainnet-* container (new start time) fails old_snapshot_assert, like an old-stack container" || { sed 's/^/    /' "$T/integ4.out"; bad "ddc-mainnet container change message"; }
fi

# ---------------------------------------------------------------------------
echo; echo "== 6. memory watchdog (fake meminfo, local Docker Desktop only)"
# Several suites may run at once on the same Docker Desktop VM: every RUN step here sleeps for a number unique to this
# run (42/43 followed by this shell's pid), only this run's step is looked for, marked or killed, and every wait is a
# wall-clock deadline sized for a loaded VM.
if docker info >/dev/null 2>&1; then
  WD="$T/wd"; mkdir -p "$WD/ok" "$WD/kill" "$WD/sel"
  WDN=$(( ($$ % 90000) + 10000 )); KSLEEP="42$WDN"; SSLEEP="43$WDN"
  printf 'FROM nginx:stable\nRUN echo watchdog-ok-%s > /wd-ok\n' "$RUN_ID" > "$WD/ok/Dockerfile"
  printf 'FROM nginx:stable\nRUN sleep %s\n' "$KSLEEP" > "$WD/kill/Dockerfile"
  printf 'FROM nginx:stable\nRUN sleep %s\n' "$SSLEEP" > "$WD/sel/Dockerfile"
  hi() { printf 'MemTotal:       16000000 kB\nMemAvailable:    8000000 kB\n' > "$WD/meminfo"; }
  lo() { printf 'MemTotal:       16000000 kB\nMemAvailable:     512000 kB\n' > "$WD/meminfo"; }
  vmps() { docker run --rm "${LT[@]}" --pid=host --name "wdps-$RANDOM-$RUN_ID" node:22-alpine ps -o pid,args 2>/dev/null; }
  sees() { vmps | grep -qE "(^|[[:space:]])sleep $1([[:space:]]|$)"; }   # <seconds>: this run's RUN step is running
  wdrun() { ( DDC_LOCAL_TEST=1; NEW_DIR="$T/ddcnew"; DDC_MEMINFO="$WD/meminfo"; BUILD_WATCH_INTERVAL=1
    # shellcheck source=../common.sh
    . "$PKG/common.sh"; run_build_watched "$@" ); }
  hi
  if wdrun "$WD/ok.log" --no-cache "${LT[@]}" -t "ddcnew-wdtest:ok-$RUN_ID" "$WD/ok" > "$T/wd-ok.out" 2>&1; then
    cat "$T/wd-ok.out"; docker image inspect "ddcnew-wdtest:ok-$RUN_ID" >/dev/null 2>&1 && ok "normal build under the watchdog passes and tags the image" || bad "image missing"
  else cat "$T/wd-ok.out"; bad "normal build under the watchdog failed"; fi
  hi
  ( end=$(( $(date +%s) + 300 )); while [ "$(date +%s)" -lt "$end" ]; do sees "$KSLEEP" && { echo "test: sleep $KSLEEP (this run's RUN step) is running; MemAvailable -> 500MB"; lo; exit 0; }; sleep 1; done
    echo "test: RUN step never seen"; lo ) > "$T/wd-flip.out" 2>&1 &
  flip=$!
  t0=$(date +%s); rc=0
  wdrun "$WD/kill.log" --no-cache "${LT[@]}" -t "ddcnew-wdtest:kill-$RUN_ID" "$WD/kill" > "$T/wd-kill.out" 2>&1 || rc=$?
  t1=$(date +%s); wait "$flip" || true
  cat "$T/wd-flip.out"; sed 's/^/  expected> /' "$T/wd-kill.out"
  left=1; end=$(( $(date +%s) + 120 )); while [ "$(date +%s)" -lt "$end" ]; do sees "$KSLEEP" || { left=0; break; }; sleep 1; done
  [ "$rc" != 0 ] && grep -q 'BUILD STOPPED BY THE WATCHDOG: MemAvailable' "$T/wd-kill.out" && grep -q 'RUN step) is running' "$T/wd-flip.out" && [ "$left" = 0 ] && ! docker image inspect "ddcnew-wdtest:kill-$RUN_ID" >/dev/null 2>&1 \
    && ok "watchdog stopped the build during RUN sleep $KSLEEP: exit=$rc after $((t1-t0))s, step process gone, no image tagged" || bad "watchdog kill test (rc=$rc left=$left)"
  # escalation path: are BuildKit step processes found by their cgroup? (plain build, no watchdog)
  docker build --no-cache "${LT[@]}" -t "ddcnew-wdtest:sel-$RUN_ID" "$WD/sel" > "$WD/sel.log" 2>&1 &
  sel=$!
  end=$(( $(date +%s) + 300 )); while [ "$(date +%s)" -lt "$end" ]; do sees "$SSLEEP" && break; sleep 1; done
  # The selector lists every BuildKit step on the VM (other suites' too); buildkit_oom_prefer marks them all, which is
  # its job. Only this run's step (sleep $SSLEEP) is checked, and only it is killed.
  docker run --rm "${LT[@]}" --pid=host --cgroupns=host --privileged -v "$PKG:/pkg:ro" -e WANT="sleep $SSLEEP" --name "wdsel-$RANDOM-$RUN_ID" --entrypoint bash nginx:stable -c \
    '. /pkg/common.sh; for p in $(buildkit_step_pids); do c=$(tr "\0" " " < /proc/$p/cmdline 2>/dev/null | sed "s/ $//"); printf "pid=%s cgroup=%s cmd=%s%s\n" "$p" "$(cut -d: -f3 /proc/$p/cgroup | head -1)" "$c" "$([ "$c" = "$WANT" ] && echo " (this run)")"; done
     echo "oom_marked=$(buildkit_oom_prefer)"; for p in $(buildkit_step_pids); do c=$(tr "\0" " " < /proc/$p/cmdline 2>/dev/null | sed "s/ $//"); [ "$c" = "$WANT" ] && echo "oom this-run pid=$p adj=$(cat /proc/$p/oom_score_adj)"; done' > "$T/wd-sel.out" 2>&1 || true
  cat "$T/wd-sel.out"
  if grep -q "cmd=sleep $SSLEEP (this run)" "$T/wd-sel.out" && ! grep -qE 'cmd=[^ ]*(dockerd|containerd)' "$T/wd-sel.out"; then
    docker run --rm "${LT[@]}" --pid=host --cgroupns=host --privileged -v "$PKG:/pkg:ro" -e WANT="sleep $SSLEEP" --name "wdkill-$RANDOM-$RUN_ID" --entrypoint bash nginx:stable -c \
      '. /pkg/common.sh; for p in $(buildkit_step_pids); do [ "$(tr "\0" " " < /proc/$p/cmdline 2>/dev/null | sed "s/ $//")" = "$WANT" ] && kill -KILL "$p" && echo "killed this run'"'"'s step pid $p"; done' || true
    src=0; wait "$sel" || src=$?
    [ "$src" != 0 ] && ok "buildkit_step_pids finds this run's RUN step by its cgroup (not dockerd/containerd); SIGKILL on it fails the build (exit $src)" || bad "build survived the step kill"
    grep -qE '^oom this-run pid=[0-9]+ adj=1000$' "$T/wd-sel.out" && ok "buildkit_oom_prefer sets oom_score_adj=1000 on the BuildKit step process (this run's checked: $(grep '^oom this-run' "$T/wd-sel.out" | cut -d' ' -f3-))" || bad "oom_score_adj not set on this run's step process"
  else
    kill "$sel" 2>/dev/null || true; wait "$sel" 2>/dev/null || true
    bad "buildkit_step_pids did not find this run's RUN step (see above)"
  fi
  for i in ok kill sel; do docker image rm "ddcnew-wdtest:$i-$RUN_ID" >/dev/null 2>&1 || true; done   # built by this run (run-id tags)
  echo "test images ddcnew-wdtest:*-$RUN_ID removed; this run's containers still present: $(docker ps -aq --filter "label=ddcnew-localtest=$RUN_ID" | grep -c . || true)"
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
cs_check "macOS /bin/bash" "$(DDC_TEST_RUN_ID="$RUN_ID" timeout 120 /bin/bash "$PKG/test/helpers/closed-session.sh" "$PKG" "$T/cs-mac" mem 2>&1 | tail -1)"
if docker info >/dev/null 2>&1; then
  cs_check "ubuntu:22.04 bash" "$(timeout 300 docker run --rm "${LT[@]}" --name "closed-$RANDOM-$RUN_ID" -e DDC_TEST_RUN_ID="$RUN_ID" --platform linux/amd64 --user 1000:1000 -v "$PKG:/pkg:ro" ubuntu:22.04 \
    bash /pkg/test/helpers/closed-session.sh /pkg /tmp/cs mem 2>&1 | tail -1)"
else bad "section 6b (ubuntu:22.04) needs Docker Desktop"; fi
out=$(DDC_TEST_RUN_ID="$RUN_ID" timeout 120 /bin/bash "$PKG/test/helpers/closed-session.sh" "$PKG" "$T/cs-disk" disk 2>&1); printf '%s\n' "$out" | sed 's/^/  /'
printf '%s\n' "$out" | grep -q '^rc=1 term=yes build_alive=no' && printf '%s\n' "$out" | grep -q 'FAIL BUILD STOPPED BY THE WATCHDOG: free disk on / [0-9]*MB < 999999999MB' \
  && ok "disk floor: free disk below BUILD_DISK_FLOOR_MB stops the build (exit 1)" || bad "disk floor"

# ---------------------------------------------------------------------------
echo; echo "== 6c. RUN-step selector on fake /proc trees, both cgroup drivers (macOS awk and ubuntu:jammy mawk)"
# test/helpers/selector.sh: never a process of a container that docker ps lists (before or after the scan), every
# RUN-step process for the cgroupfs and the systemd layout; OOM marking; kill_build on test-owned processes only.
if timeout 120 /bin/bash "$PKG/test/helpers/selector.sh" "$PKG" "$T/sel-mac" > "$T/sel-mac.out" 2>&1; then cat "$T/sel-mac.out"; ok "selector suite on macOS (bash 3.2, BSD awk)"
else cat "$T/sel-mac.out"; bad "selector suite on macOS"; fi
if docker info >/dev/null 2>&1; then
  if timeout 300 docker run --rm "${LT[@]}" --name "selector-$RANDOM-$RUN_ID" --user 1000:1000 -v "$PKG:/pkg:ro" ubuntu:jammy bash /pkg/test/helpers/selector.sh /pkg /tmp/sel > "$T/sel-jammy.out" 2>&1; then
    cat "$T/sel-jammy.out"; ok "selector suite on ubuntu:jammy (bash 5.1, mawk 1.3.4)"
  else cat "$T/sel-jammy.out"; bad "selector suite on ubuntu:jammy"; fi
else bad "section 6c (ubuntu:jammy) needs Docker Desktop"; fi

# ---------------------------------------------------------------------------
echo; echo "== 6d. the watchdog on a REAL dockerd 29.1.3 with the systemd cgroup driver (the server's version and default layout)"
# A throwaway privileged container runs systemd as PID 1 and docker-ce 29.1.3 from download.docker.com (cgroup v2,
# systemd driver, containerd image store), so the server's cgroup layout is reproduced, not assumed. Its dockerd is
# separate from Docker Desktop's: nothing outside the container is touched. test/helpers/sysd-driver.sh runs inside.
SYSD_IMG="ddcnew-sysdtest:$RUN_ID"   # this run's own tag: built here, removed by the label cleanup at the end
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
    timeout 900 docker build -q "${LT[@]}" -t "$SYSD_IMG" "$T/sysd-img" >/dev/null || bad "could not build $SYSD_IMG"
  fi
  C6="sysdtest-$RANDOM-$RUN_ID"
  if C6ID=$(docker run -d "${LT[@]}" --name "$C6" --privileged --cgroupns=private -v /var/lib/docker -v /var/lib/containerd --tmpfs /run --tmpfs /run/lock \
       -v "$PKG:/pkg:ro" "$SYSD_IMG"); then
    end=$(( $(date +%s) + 180 )); while [ "$(date +%s)" -lt "$end" ]; do docker exec "$C6ID" docker info >/dev/null 2>&1 && break; sleep 1; done
    if timeout 400 docker exec "$C6ID" bash /pkg/test/helpers/sysd-driver.sh /pkg "$RUN_ID" > "$T/sysd.out" 2>&1; then cat "$T/sysd.out"; ok "watchdog, selector and SIGKILL fallback on the real systemd driver"
    else cat "$T/sysd.out"; bad "real systemd-driver test"; fi
    docker rm -fv "$C6ID" >/dev/null 2>&1 || true   # by the id this run got back from docker run
  else bad "could not start $C6"; fi
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
# The frontend check comes before the settings record: a frontend built for another API host stops 10-build.sh before it
# records anything (and before any build or network fetch).
B="$T/build-order"; mkdir -p "$B/ddcnew/src" "$B/fe/src/config" "$B/bin"; FE40=fedcba9876543210fedcba9876543210fedcba98
printf "export const API_BASE_URLS = {\n  tge: 'https://other.example.invalid/api',\n};\n" > "$B/fe/src/config/environment.ts"
tar -czf "$B/ddcnew/src/ddc-frontend-$FE40.tar.gz" -C "$B/fe" src
(cd "$B/ddcnew/src" && shasum -a 256 < "ddc-frontend-$FE40.tar.gz" | cut -c1-64 > "ddc-frontend-$FE40.tar.gz.sha256")
printf '#!/bin/sh\nexit 0\n' > "$B/bin/docker"; chmod 755 "$B/bin/docker"
RC=0; PATH="$B/bin:$PATH" DDC_LOCAL_TEST=1 NEW_DIR="$B/ddcnew" NGINX_AVAIL="$B/none" NGINX_ENABLED="$B/none" NGINX_CONFD="$B/none" MAINNET_DIR="$B/none" \
  bash "$PKG/10-build.sh" "$S40" "$FE40" --infra-only > "$B/out" 2>&1 || RC=$?
[ "$RC" != 0 ] && grep -q "^FAIL the frontend commit builds its tge web app for https://other.example.invalid/api, not https://$D_API_HOST/api" "$B/out" && [ ! -e "$B/ddcnew/settings.env" ] \
  && ok "10-build.sh: a frontend built for another API host stops it before the settings are recorded (no settings.env left behind)" || { tail -3 "$B/out"; bad "10-build.sh frontend check order (rc=$RC)"; }
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
  if docker run --rm "${LT[@]}" --privileged --platform linux/arm64 --name "expandro-$RANDOM-$RUN_ID" -v "$PKG:/pkg:ro" ubuntu:jammy bash -c \
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
GOOD="Partner SSO money-path assertions OK: nodeEnv=production web3authVerify=enforce legacyFallback=false allowedVerifiers=5 jwksPinMode=enforce jwksPins=2 sessionSecretSeparate=true issuer=https://$D_API_HOST consentOrigin=https://$D_APP_HOST publicClientRegistration=closed"
mp() { ( DDC_LOCAL_TEST=1; . "$PKG/common.sh"; money_path_fields_check "$1" "$2" ) 2>&1; }
out=$(mp "$GOOD" 2) && [ "$(printf '%s\n' "$out" | grep -c '^PASS log:')" = 10 ] && ok "complete line passes (9 required fields incl. sessionSecretSeparate=true + publicClientRegistration=closed)" || { echo "$out"; bad "good line"; }
out=$(mp "${GOOD/publicClientRegistration=closed/publicClientRegistration=open}" 2) && printf '%s\n' "$out" | grep -q '^WARN publicClientRegistration' && ok "publicClientRegistration=open is a warning only (runbook 5.2 open)" || bad "open registration handling"
for c in "jwksPins=2|jwksPins=3" "allowedVerifiers=5|allowedVerifiers=50" "issuer=https://$D_API_HOST|issuer=https://$D_API_HOST.evil" "web3authVerify=enforce|web3authVerify=log" "legacyFallback=false|legacyFallback=true" "jwksPinMode=enforce|jwksPinMode=log" "consentOrigin=https://$D_APP_HOST|consentOrigin=https://app.datadance.ai" "nodeEnv=production|nodeEnv=development" "jwksPins=2 |" "sessionSecretSeparate=true|sessionSecretSeparate=false" "sessionSecretSeparate=true |" "issuer=https://$D_API_HOST|issuer=https://api-coexist.datadance.ai"; do
  from="${c%%|*}"; to="${c#*|}"; bad_line="${GOOD/"$from"/$to}"
  [ "$bad_line" != "$GOOD" ] || { bad "test setup: '$from' not replaced"; continue; }
  if out=$(mp "$bad_line" 2); then bad "accepted a line with '$to' instead of '$from'"
  else printf '%s\n' "$out" | grep -q '^FAIL the money-path log line lacks:' && ok "stops when '$from' is '${to:-absent}'" || { echo "$out"; bad "wrong failure for $from"; }; fi
done
# The issuer and consent origin follow the settings: with API_HOST / APP_HOST overrides the overridden hosts are required.
GOODB="${GOOD/issuer=https:\/\/$D_API_HOST/issuer=https://api-coexist.datadance.ai}"; GOODB="${GOODB/consentOrigin=https:\/\/$D_APP_HOST/consentOrigin=https://app-coexist.datadance.ai}"
out=$( ( DDC_LOCAL_TEST=1; API_HOST=api-coexist.datadance.ai; APP_HOST=app-coexist.datadance.ai; . "$PKG/common.sh"; money_path_fields_check "$GOODB" 2 ) 2>&1) \
  && printf '%s\n' "$out" | grep -q '^PASS log: issuer=https://api-coexist.datadance.ai$' && ! ( ( DDC_LOCAL_TEST=1; API_HOST=api-coexist.datadance.ai; APP_HOST=app-coexist.datadance.ai; . "$PKG/common.sh"; money_path_fields_check "$GOOD" 2 ) >/dev/null 2>&1 ) \
  && ok "with API_HOST/APP_HOST overrides the money-path check requires issuer/consentOrigin of those hosts (and refuses the default ones)" || { echo "$out"; bad "money-path check with host overrides"; }
# Backend PR #38's startup line (40-up.sh step 5): checked whenever the image prints it; REQUIRED when 10-build.sh found
# PR #38's commit in the backend commit (OLD_APP_SWITCHES=1), otherwise its absence is said, not failed.
RL="api-1  | Old App update answer (426 APP_UPDATE_REQUIRED): WEB3AUTH_RETIRED_CLIENT_IDS count=1 first8=BGiGcxrX LOGIN_MISSING_IDTOKEN_MEANS_OLD_APP=on"
oal() { ( . "$PKG/common.sh"; old_app_line_check "$1" "$2" "$3" ) 2>&1 | tail -1 || true; }
r1=$(oal "$RL" BGiGcxrX 1); r2=$(oal "${RL/=on/=off}" BGiGcxrX 1); r3=$(oal "${RL/count=1/count=2}" BGiGcxrX 1); r4=$(oal "${RL/first8=BGiGcxrX/first8=BBpkxUTU}" BGiGcxrX 1)
r5=$(oal "api-1  | server started" BGiGcxrX 0); r6=$(oal "api-1  | server started" BGiGcxrX 1); r7=$(oal "$RL" BGiGcxrX 0)
case "$r1|$r2|$r3|$r4|$r5|$r6|$r7" in
  "PASS old-App switches (backend PR #38 in this image): WEB3AUTH_RETIRED_CLIENT_IDS count=1 first8=BGiGcxrX LOGIN_MISSING_IDTOKEN_MEANS_OLD_APP=on|FAIL "*"lacks: LOGIN_MISSING_IDTOKEN_MEANS_OLD_APP=on|FAIL "*"lacks: count=1|FAIL "*"lacks: first8=BGiGcxrX|old-App switches: no 'Old App update answer' line in the api log, and the backend commit does not contain PR #38 (OLD_APP_SWITCHES=0)"*"|FAIL the api log has no 'Old App update answer' line, but the backend commit contains PR #38"*"|PASS old-App switches"*)
    ok "old-App startup line: passes when exact, stops on =off, count=2 or another prefix; missing: said when the backend commit lacks PR #38, a STOP when it has it; a line printed anyway is still checked";;
  *) printf '    %s\n' "$r1" "$r2" "$r3" "$r4" "$r5" "$r6" "$r7"; bad "old_app_line_check cases";;
esac
grep -qF 'old_app_line_check "$LOG" "$(env_get_simple WEB3AUTH_RETIRED_CLIENT_IDS "$NEW_DIR/.env.api" | cut -c1-8)" "$OLD_APP_SWITCHES"' "$PKG/40-up.sh" \
  && grep -q 'OLD_APP_SWITCHES=$(env_get_simple OLD_APP_SWITCHES "$NEW_DIR/.env")' "$PKG/40-up.sh" \
  && grep -qF 'OLD_APP_SWITCHES=$(old_app_switches "$BE_DIR" "$BE_REPO" "$BE_SHA")' "$PKG/10-build.sh" && grep -qF 'OLD_APP_SWITCHES=%s' "$PKG/10-build.sh" \
  && ok "40-up.sh checks that line against the first 8 characters of WEB3AUTH_RETIRED_CLIENT_IDS, required per OLD_APP_SWITCHES, which 10-build.sh records from an ancestor check of PR #38's commit" || bad "40-up.sh / 10-build.sh old-App wiring"
# The ancestor check itself, on this repository: PR #38's commit is in HEAD (main has it since 8ebfe5b), not in its parent of 10-04.
REPO="$(cd "$PKG/../.." && pwd)"; OAC=$( . "$PKG/common.sh"; echo "$OLD_APP_COMMIT")
if git -C "$REPO" cat-file -e "$OAC^{commit}" 2>/dev/null && git -C "$REPO" merge-base --is-ancestor "$OAC" HEAD \
   && ! git -C "$REPO" merge-base --is-ancestor "$OAC" 6e61be2 2>/dev/null; then ok "OLD_APP_COMMIT ${OAC:0:12} is PR #38's commit: an ancestor of HEAD, not of 6e61be2 (the PR #37 merge, before #38)"
else bad "OLD_APP_COMMIT ${OAC:0:12} is not where this suite expects it in the history"; fi
# old_app_switches (10-build.sh) on this repository through file://, fetched the way 10-build.sh fetches from GitHub: the
# commit at depth 1, then the shallow history since 2026-10-01. A fetch that fails gives no answer (10-build.sh stops),
# unless the commit is older than 2026-10-01.
OAS="$T/oas"; mkdir -p "$OAS"
oas() { # <label> <sha> [<url>]: 1, 0, or unknown
  local g="$OAS/$1"
  git init -q "$g" && git -C "$g" fetch -q --depth 1 "file://$REPO" "$2" 2>/dev/null || { echo setup-failed; return 0; }
  ( . "$PKG/common.sh"; old_app_switches "$g" "${3:-file://$REPO}" "$2" ) 2>/dev/null || echo unknown
}
OAH=$(git -C "$REPO" rev-parse HEAD); OAP=$(git -C "$REPO" rev-parse 6e61be2 2>/dev/null || true); OAO=$(git -C "$REPO" rev-list -1 --before=2026-09-25 HEAD)
a1=$(oas head "$OAH"); a2=$(oas pre38 "$OAP"); a3=$(oas sept "$OAO"); a4=$(oas nofetch "$OAH" "file://$T/no-such-repo"); a5=$(oas nofetch-old "$OAO" "file://$T/no-such-repo")
[ "$a1|$a2|$a3|$a4|$a5" = "1|0|0|unknown|0" ] \
  && ok "old_app_switches (10-build.sh): HEAD (with PR #38) -> 1; 6e61be2 (before #38) -> 0; a commit of 09-24 (no history since 10-01) -> 0; a failing history fetch -> no answer (10-build.sh stops), 0 for a commit before 10-01" \
  || bad "old_app_switches answers $a1|$a2|$a3|$a4|$a5 (want 1|0|0|unknown|0)"

echo; echo "== 10c. SSH login guard (sshpw.sh, remote.sh, ro-ssh.sh) against a throwaway Ubuntu 22.04 sshd (password + keyboard-interactive via PAM)"
if docker info >/dev/null 2>&1; then
  SS="$T/ssh"; mkdir -p "$SS/img" "$SS/pkg"; C="sshpwtest-$RANDOM-$RUN_ID"; SSHD_IMG="ddcnew-sshtest:$RUN_ID"
  TESTPW="test-$(openssl rand -hex 12)"   # password of the throwaway container only
  if ! docker image inspect "$SSHD_IMG" >/dev/null 2>&1; then
    printf 'FROM ubuntu:jammy\nRUN export DEBIAN_FRONTEND=noninteractive && apt-get update -qq && apt-get -o Acquire::Retries=8 install -y -qq --no-install-recommends openssh-server >/dev/null && mkdir -p /run/sshd && rm -rf /var/lib/apt/lists/*\n' > "$SS/img/Dockerfile"
    timeout 600 docker build -q "${LT[@]}" -t "$SSHD_IMG" "$SS/img" >/dev/null || bad "could not build the sshd test image"
  fi
  C=$(docker run -d "${LT[@]}" --name "$C" -p 127.0.0.1::22 -e TESTPW="$TESTPW" "$SSHD_IMG" bash -c '
    printf "root:%s\n" "$TESTPW" | chpasswd
    exec /usr/sbin/sshd -D -e -o PermitRootLogin=yes -o PasswordAuthentication=yes -o KbdInteractiveAuthentication=yes -o UsePAM=yes -o LogLevel=VERBOSE -o MaxAuthTries=6')   # C = the id docker run returned
  PORT=$(docker port "$C" 22/tcp | head -1 | sed 's/.*://')
  end=$(( $(date +%s) + 90 )); while [ "$(date +%s)" -lt "$end" ]; do docker logs "$C" 2>&1 | grep -q 'Server listening' && break; sleep 1; done
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
  if docker run --rm "${LT[@]}" --name "devfull-$RANDOM-$RUN_ID" -v "$SS/pkg:/pkg:ro" ubuntu:jammy bash -c '. /pkg/sshpw.sh; sshpw_load_local_env || exit 9; if sshpw_make_askpass /dev/full; then echo accepted; else echo refused; fi' 2>/dev/null | grep -qx refused; then
    ok "disk full (/dev/full, ENOSPC on every write): sshpw_make_askpass fails"
  else bad "sshpw_make_askpass accepted /dev/full"; fi
  # remote.sh and ro-ssh.sh themselves, with an askpass that cannot be created: scratch COPIES whose test local.env points
  # at the throwaway sshd. remote.sh, common.sh (remote.sh checks the overrides with it before connecting) and
  # survey/ro-ssh.sh are byte-identical to the package's; sshpw.sh differs in two lines only (the op binary; port +
  # known_hosts appended), asserted below. The host comes from local.env alone.
  CP="$T/sshcopy/deploy/new-stack"; mkdir -p "$CP/survey"
  cp "$PKG/remote.sh" "$PKG/common.sh" "$PKG/00-preflight.sh" "$CP/"; cp "$PKG/survey/ro-ssh.sh" "$CP/survey/"; cp "$SS/pkg/local.env" "$CP/local.env"
  sed "s#^SSHPW_OP_BIN=/opt/homebrew/bin/op #SSHPW_OP_BIN=$SS/op-ok #" "$PKG/sshpw.sh" > "$CP/sshpw.sh"
  printf 'SSHPW_OPTS+=(-p %s -o UserKnownHostsFile=%s)\n' "$PORT" "$SS/known_hosts" >> "$CP/sshpw.sh"
  nd=$( { diff "$PKG/survey/ro-ssh.sh" "$CP/survey/ro-ssh.sh"; diff "$PKG/sshpw.sh" "$CP/sshpw.sh"; diff "$PKG/remote.sh" "$CP/remote.sh"; diff "$PKG/common.sh" "$CP/common.sh"; } | grep -c '^>' || true)
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
  cp "$PKG/remote.sh" "$PKG/common.sh" "$CP2/"; cp "$SS/pkg/local.env" "$CP2/local.env"
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
R="$T/remote"; mkdir -p "$R"; cp "$PKG/remote.sh" "$PKG/common.sh" "$R/"
printf '%s\n' 'SSHPW_OPTS=(-o BatchMode=yes)' 'sshpw_precheck() { echo "STUB: would connect now (stopped)"; return 1; }' 'sshpw_make_askpass() { :; }' > "$R/sshpw.sh"
for a in PATH=/tmp BASH_ENV=/tmp/x LD_PRELOAD=/tmp/x.so DDC_LOCAL_TEST=1 NEW_DIR=/tmp/x OLD_ENV=/tmp/x BACKUP_DIR=/tmp/x DDC_MEMINFO=/tmp/x BUILD_WATCH_INTERVAL=1 lower_case=1; do
  rc=0; out=$(DDC_APPROVED=yes bash "$R/remote.sh" run 40-up.sh "$a" 2>&1 < /dev/null) || rc=$?
  [ "$rc" = 2 ] && printf '%s\n' "$out" | grep -q "override ${a%%=*} is not allowed" && ! printf '%s\n' "$out" | grep -q STUB || bad "override ${a%%=*}: rc=$rc $out"
done
ok "10 non-allowlisted overrides (PATH, BASH_ENV, LD_PRELOAD, DDC_LOCAL_TEST, NEW_DIR, OLD_ENV, BACKUP_DIR, DDC_MEMINFO, BUILD_WATCH_INTERVAL, lower_case) refused before any connection"
# Every allowlisted override, with a ;, $(), backticks, a newline or a carriage return in its value: refused before
# anything connects (the server runs `env NAME=value ./script` in a root shell). The names come from remote.sh itself.
SERVER_NAMES=$(sed -n 's/^SERVER_ENV_ALLOWED="\(.*\)"$/\1/p' "$PKG/remote.sh"); NL=$'\n'; CR=$'\r'; n=0; through=""
for name in $SERVER_NAMES; do
  for v in 'a;id' 'a$(id)' 'a`id`' "a${NL}id" "a${CR}"; do
    n=$((n + 1)); rc=0; out=$(DDC_APPROVED=yes bash "$R/remote.sh" run 40-up.sh "$name=$v" 2>&1 < /dev/null) || rc=$?
    [ "$rc" = 2 ] && [ "$out" = "unsafe argument" ] || through="$through $name=$(printf '%q' "$v")"
  done
  for v in 'a;id' 'a$(id)' "a${NL}id"; do   # the same through preflight, for the five settings it takes
    case "$name" in API_HOST|APP_HOST|API_PORT|WEB_PORT|DB_PORT) ;; *) continue;; esac
    n=$((n + 1)); rc=0; out=$(bash "$R/remote.sh" preflight "$name=$v" 2>&1 < /dev/null) || rc=$?
    [ "$rc" = 2 ] && printf '%s\n' "$out" | grep -q '^preflight takes only' && ! printf '%s\n' "$out" | grep -q STUB || through="$through preflight:$name=$(printf '%q' "$v")"
  done
done
[ -n "$SERVER_NAMES" ] && [ -z "$through" ] && ok "$n refusals before any connection: each of the $(set -- $SERVER_NAMES; echo $#) allowlisted overrides with ;, \$(), backticks, a newline or a carriage return (run), and the five settings with ;, \$() or a newline (preflight)" \
  || bad "dangerous characters in an override got through to the (stubbed) connection:$through"
# run checks the settings, the client id and TAKE_OVER_VHOSTS with the server's own rules (common.sh), before connecting.
for c in "API_HOST=api.datadance.ai|is a production host" "APP_HOST=a.b.datadance.ai|is not a host name of the form" "API_PORT=10000|is a port of the old stack" \
         "WEB_PORT=10020|the three ports must differ" "TAKE_OVER_VHOSTS=YES|TAKE_OVER_VHOSTS must be yes" "REHEARSAL_CLIENT_ID=tge-rehearsal|is retired" \
         "REHEARSAL_CLIENT_ID=tge|is retired" "REHEARSAL_CLIENT_ID=$(printf 'x%.0s' $(seq 1 65))|must match"; do
  rc=0; out=$(DDC_APPROVED=yes bash "$R/remote.sh" run 30-nginx.sh apply "${c%%|*}" 2>&1 < /dev/null) || rc=$?
  [ "$rc" = 2 ] && printf '%s\n' "$out" | grep -q "^refusing before connecting: FAIL .*${c#*|}" && ! printf '%s\n' "$out" | grep -q STUB || bad "remote.sh run with ${c%%|*}: rc=$rc $out"
done
out=$(DDC_APPROVED=yes bash "$R/remote.sh" run 20-env.sh REHEARSAL_CLIENT_ID=lt-partner-client API_HOST=api-coexist.datadance.ai 2>&1 < /dev/null || true)
printf '%s\n' "$out" | grep -q STUB && ok "remote.sh run checks the settings, REHEARSAL_CLIENT_ID and TAKE_OVER_VHOSTS with the server's rules before connecting (8 refusals); valid ones pass through" || bad "valid overrides refused: $out"
rc=0; out=$(DDC_APPROVED=yes bash "$R/remote.sh" run 00-preflight.sh 2>&1 < /dev/null) || rc=$?
[ "$rc" = 2 ] && printf '%s\n' "$out" | grep -q '^refusing: run the preflight with ./remote.sh preflight' && ! printf '%s\n' "$out" | grep -q STUB \
  && ok "remote.sh run 00-preflight.sh is refused (the preflight only runs through ./remote.sh preflight)" || bad "run 00-preflight.sh: rc=$rc $out"
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
for a in PARTNER_CRYPT_IMAGE=node:22-alpine SRV_DIR=/tmp/x DDC_TEST_RUN_ID=lt1 NGINX_LOCAL_URL=http://x MAINNET_DIR=/tmp/x NGINX_CONFD=/tmp/x; do
  rc=0; out=$(DDC_APPROVED=yes bash "$R/remote.sh" run 50-partner-page.sh apply "$a" 2>&1 < /dev/null) || rc=$?
  [ "$rc" = 2 ] && printf '%s\n' "$out" | grep -q "override ${a%%=*} is not allowed" && ! printf '%s\n' "$out" | grep -q STUB || bad "override ${a%%=*} (50-partner-page.sh): rc=$rc $out"
done
ok "the local-test-only overrides (PARTNER_CRYPT_IMAGE, SRV_DIR, DDC_TEST_RUN_ID, NGINX_LOCAL_URL, MAINNET_DIR, NGINX_CONFD) refused before any connection"
# The settings and the take-over flag (10-05): allowlisted; restore changes the server, status does not.
out=$(DDC_APPROVED=yes bash "$R/remote.sh" run 30-nginx.sh apply API_HOST=api-coexist.datadance.ai APP_HOST=app-coexist.datadance.ai API_PORT=10031 WEB_PORT=9031 DB_PORT=15441 TAKE_OVER_VHOSTS=yes 2>&1 < /dev/null || true)
printf '%s\n' "$out" | grep -q STUB && ok "API_HOST, APP_HOST, API_PORT, WEB_PORT, DB_PORT and TAKE_OVER_VHOSTS are allowlisted and pass through to the (stubbed) connection" || bad "settings overrides refused: $out"
out=$(bash "$R/remote.sh" run 30-nginx.sh restore 2>&1 < /dev/null || true); printf '%s\n' "$out" | grep -q 'refusing: this call changes the server' && ok "30-nginx.sh restore without DDC_APPROVED=yes: refused" || bad "restore approval gate: $out"
out=$(bash "$R/remote.sh" run 30-nginx.sh status API_HOST=api-coexist.datadance.ai 2>&1 < /dev/null || true); printf '%s\n' "$out" | grep -q STUB && ok "30-nginx.sh status (read-only) needs no approval, also with a settings override" || bad "30-nginx.sh status: $out"
for a in "API_HOST=api.datadance.ai|is a production host" "FOO=1|preflight takes only" "API_HOST=a b|preflight takes only" "WEB_PORT=9001|is a port of the old stack"; do
  rc=0; out=$(bash "$R/remote.sh" preflight "${a%%|*}" 2>&1 < /dev/null) || rc=$?
  [ "$rc" = 2 ] && printf '%s\n' "$out" | grep -q -- "${a#*|}" && ! printf '%s\n' "$out" | grep -q STUB || bad "remote.sh preflight ${a%%|*}: rc=$rc $out"
done
ok "remote.sh preflight refuses a production host, an unknown name and an unsafe value before connecting"
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
  cp "$PKG/remote.sh" "$PKG/common.sh" "$PKG/00-preflight.sh" "$PKG/local.env.example" "$1/"; cp "$PKG/survey/ro-ssh.sh" "$1/survey/"
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
SETL="API_HOST=$D_API_HOST APP_HOST=$D_APP_HOST API_PORT=$D_API_PORT WEB_PORT=$D_WEB_PORT DB_PORT=$D_DB_PORT "
[ "$RC" = 0 ] && [ "$(head -1 "$LE/ssh.stdin")" = "GIT_APN_SHA=" ] && [ "$(sed -n 2,6p "$LE/ssh.stdin" | tr '\n' ' ')" = "$SETL" ] && cmp -s <(tail -n +7 "$LE/ssh.stdin") "$PKG/00-preflight.sh" \
  && ok "remote.sh preflight outside a git checkout: pipes GIT_APN_SHA= (empty), the five default settings and the unchanged 00-preflight.sh" || { sed 's/^/    /' "$LE/out"; bad "preflight outside git (rc=$RC)"; }
rm -f "$LE/calls" "$LE/ssh.stdin"; RC=0
PATH="$LE/bin:$PATH" bash "$LE/good/remote.sh" preflight API_HOST=api-coexist.datadance.ai WEB_PORT=9031 > "$LE/out" 2>&1 < /dev/null || RC=$?
[ "$RC" = 0 ] && [ "$(sed -n 2,6p "$LE/ssh.stdin" | tr '\n' ' ')" = "API_HOST=api-coexist.datadance.ai APP_HOST=$D_APP_HOST API_PORT=$D_API_PORT WEB_PORT=9031 DB_PORT=$D_DB_PORT " ] \
  && ok "remote.sh preflight API_HOST=... WEB_PORT=...: the overrides replace those two settings in the piped lines" || { sed 's/^/    /' "$LE/out"; bad "preflight with overrides (rc=$RC)"; }
# remote.sh preflight inside a git checkout: the sha256 of keys_fixed/apn_key.p8 at HEAD is computed at run time
G="$T/apnrepo"; mkdir -p "$G/keys_fixed"; lecopy "$G/deploy/new-stack" "$(printf 'DDC_SSH_TARGET=root@127.0.0.1\nDDC_OP_SECRET_REF=%s' "$TREF")"
printf 'synthetic apn key file for the preflight wiring test\n' > "$G/keys_fixed/apn_key.p8"
# a throwaway repository in the scratch directory; its one commit is not signed (a signing prompt would block the suite)
git -C "$G" init -q 2>/dev/null && git -C "$G" add keys_fixed/apn_key.p8 \
  && git -C "$G" -c user.name=ddcnew-local-test -c user.email=ddcnew-local-test@example.invalid commit -q --no-gpg-sign -m "throwaway repository of the local test" >/dev/null 2>&1 \
  || bad "could not set up the throwaway git repository"
want=$(shasum -a 256 < "$G/keys_fixed/apn_key.p8" | cut -c1-64)
le_run "$G/deploy/new-stack" preflight
[ "$RC" = 0 ] && [ "$(head -1 "$LE/ssh.stdin")" = "GIT_APN_SHA=$want" ] && cmp -s <(tail -n +7 "$LE/ssh.stdin") "$PKG/00-preflight.sh" \
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
# line reports yes / no / not checked and nothing else; the CORS counts use the neutral labels. With Race's stand-ins
# (a ddc-mainnet-* container, /root/ddc-mainnet, his vhost at the default API name, a clashing conf.d file): they are
# listed and fingerprinted, the foreign vhost is a WARN, the clash a FAIL; without the settings lines, a FAIL.
if docker info >/dev/null 2>&1; then
  PF="$T/preflight"; mkdir -p "$PF/bin"
  cat > "$PF/bin/docker" <<'STUB'
#!/bin/sh
# stub docker for 00-preflight.sh: six old containers and Race's ddc-mainnet-api, nothing else
case "$1" in ps) for n in api db app web admin business; do echo "ddc-$n-1|Up 1 day|"; done; echo "ddc-mainnet-api|Up 2 hours|";; esac
exit 0
STUB
  chmod 755 "$PF/bin/docker"
  pfrun() { # <GIT_APN_SHA value or -> [nosettings] -> output in $PF/out
    { [ "$1" = - ] || printf 'GIT_APN_SHA=%s\n' "$1"; [ "${2:-}" = nosettings ] || printf '%s' "$SETL" | tr ' ' '\n' | grep .; cat "$PKG/00-preflight.sh"; } > "$PF/script.sh"
    docker run --rm "${LT[@]}" --network none --name "preflight-$RANDOM-$RUN_ID" -e DAPI="$D_API_HOST" -e DAPP="$D_APP_HOST" -v "$PF:/pf:ro" -v "$PKG/test/fixtures:/fx:ro" ubuntu:jammy bash -c '
      set -e; export PATH="/pf/bin:$PATH"
      mkdir -p /root/ddc-backend/keys_fixed /root/ddc-backend/campaign-covers /root/ddc-backend/passes /root/ddc-backend/overlays /etc/nginx/sites-available /etc/nginx/sites-enabled /etc/nginx/conf.d /root/ddc-mainnet
      printf "A=1\n" > /root/ddc-backend/backend.env
      for k in apn_key.p8 wwdr.pem signerCert.pem signerKey.pem; do echo "synthetic $k" > "/root/ddc-backend/keys_fixed/$k"; done
      cp /fx/api.datadance.co /fx/app.datadance.co /etc/nginx/sites-available/
      printf "services: {}\n" > /root/ddc-mainnet/compose.yaml
      printf "server { server_name %s; location / { proxy_pass http://localhost:10010; } }\n" "$DAPI" > "/etc/nginx/sites-available/$DAPI"
      ln -s "../sites-available/$DAPI" "/etc/nginx/sites-enabled/$DAPI"
      printf "server { server_name other.datadance.ai %s; }\n" "$DAPP" > /etc/nginx/conf.d/extra.conf
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
  if grep -qF "settings: ${SETL% }" "$PF/out" && grep -q "^PASS API_PORT $D_API_PORT free" "$PF/out" && grep -q '^PASS 6 old containers running' "$PF/out" \
     && grep -q '^ddc-mainnet-\* containers: 1$' "$PF/out" && grep -q "^WARN /etc/nginx/sites-available/$D_API_HOST was NOT written by this package (server_name $D_API_HOST proxy_pass http://localhost:10010 )" "$PF/out" \
     && grep -q "^WARN /etc/nginx/sites-enabled/$D_API_HOST was NOT written by this package (symlink -> ../sites-available/$D_API_HOST)" "$PF/out" \
     && grep -q "^FAIL /etc/nginx/conf.d/extra.conf also declares server_name $D_APP_HOST" "$PF/out" \
     && grep -qE '^  [0-9a-f]{12} /root/ddc-mainnet/compose.yaml$' "$PF/out" && grep -qE "^  [0-9a-f]{12} /etc/nginx/sites-enabled/$D_API_HOST\$" "$PF/out"; then
    ok "00-preflight.sh: the settings, free ports, 6 old containers (ddc-mainnet-* listed apart), Race's vhost and link at the default API name (WARN: apply refuses without TAKE_OVER_VHOSTS), the conf.d clash (FAIL), /root/ddc-mainnet and the link fingerprinted"
  else sed 's/^/    /' "$PF/out" | grep -vE '^    (PASS|  )' | tail -40; bad "00-preflight.sh settings / Race's stand-ins"; fi
  pfrun - nosettings
  grep -q '^FAIL no settings were passed: run it with ./remote.sh preflight' "$PF/out" && ok "00-preflight.sh piped without the settings lines: FAIL, run it with ./remote.sh preflight" || bad "preflight without settings"
else bad "00-preflight.sh smoke run needs Docker Desktop"; fi

# ---------------------------------------------------------------------------
echo; echo "== 11. ROOT mode in ubuntu:22.04 (no DDC_LOCAL_TEST, the server's /root/ddcnew layout): write guard, require_server, run lock, server-side log"
# test/helpers/root-guard.sh: first-run and re-run targets allowed (existing files, in-tree symlinks); a symlink into
# /root/ddc-backend, .. traversal and paths outside the allowlist refused; one write run at a time; logs 600.
if docker info >/dev/null 2>&1; then
  if timeout 300 docker run --rm "${LT[@]}" --name "rootguard-$RANDOM-$RUN_ID" --platform linux/amd64 -v "$PKG:/pkg:ro" ubuntu:22.04 bash /pkg/test/helpers/root-guard.sh /pkg > "$T/rootguard.out" 2>&1; then
    cat "$T/rootguard.out"; ok "root-mode guard, lock and log suite (ubuntu:22.04 amd64, bash 5.1, GNU realpath)"
  else cat "$T/rootguard.out"; bad "root-mode guard suite"; fi
else bad "section 11 needs Docker Desktop"; fi

# ---------------------------------------------------------------------------
echo; echo "== 12. pass criteria that STOP the scripts (p1 verify, 30-nginx apply/undo, 40-up step 8) and the teardown fallback"
if docker info >/dev/null 2>&1; then
  if timeout 300 docker run --rm "${LT[@]}" --name "p1verify-$RANDOM-$RUN_ID" --user 1000:1000 -v "$PKG:/pkg:ro" ubuntu:jammy bash /pkg/test/helpers/p1-verify.sh /pkg /tmp/p1 > "$T/p1verify.out" 2>&1; then
    cat "$T/p1verify.out"; ok "p1-backup.sh verify: stops on pg_restore --list failures and on a restored user count that is not a number or below P1_USERS_MIN; warns only above live"
  else cat "$T/p1verify.out"; bad "p1-backup.sh verify stop cases"; fi
else bad "section 12 (p1) needs Docker Desktop"; fi
# 30-nginx.sh apply/undo with stub nginx/systemctl/curl/docker in scratch vhost directories (DDC_LOCAL_TEST=1)
ST="$T/stubs"; mkdir -p "$ST"
printf '#!/bin/sh\nexit 0\n' > "$ST/nginx"
printf '#!/bin/sh\n[ "$1 $2" = "reload nginx" ] && { touch "$STUB_DIR/reloaded"; echo reload >> "$STUB_DIR/reloads"; }\nexit 0\n' > "$ST/systemctl"
cp "$PKG/test/helpers/stub-curl.py" "$ST/curl"
# ss: something listens on the TLS port while $STUB_DIR/tls-on exists (nothing else is ever reported as listening)
printf '#!/bin/sh\ncase "$*" in *":${NGINX_LOCAL_TLS_PORT:-443}"*) [ -f "$STUB_DIR/tls-on" ] && echo "LISTEN 0 511 0.0.0.0:${NGINX_LOCAL_TLS_PORT:-443} 0.0.0.0:*";; esac\nexit 0\n' > "$ST/ss"
chmod 755 "$ST"/*
vhosts() { # <dir>: avail/ and enabled/ with the two synthetic vhost fixtures, conf.d/, a stub docker
  mkdir -p "$1/avail" "$1/enabled" "$1/confd" "$1/ddcnew" "$1/bin"
  cp "$PKG/test/fixtures/api.datadance.co" "$PKG/test/fixtures/app.datadance.co" "$1/avail/"
  ln -sfn "$1/avail/api.datadance.co" "$1/enabled/api.datadance.co"; ln -sfn "$1/avail/app.datadance.co" "$1/enabled/app.datadance.co"
  printf '#!/bin/sh\nexit 0\n' > "$1/bin/docker"; chmod 755 "$1/bin/docker"
}
NX="$T/nginx-stop"; vhosts "$NX"
ngx() { # <dir> <host whose code changes after the reload | none> <30-nginx.sh args...>; output in <dir>/out, status in $RC
  # NGX_TIMEOUT=<s>: stop the run after that long (timeout's exit 124 then shows that it hung)
  local d="$1" ch="$2"; shift 2; rm -f "$d/reloaded" "$d/reloads"; RC=0
  ${NGX_TIMEOUT:+timeout "$NGX_TIMEOUT"} env PATH="$d/bin:$ST:$PATH" STUB_DIR="$d" CHANGE_HOST="$ch" CHANGE_TLS_HOST="${CHANGE_TLS_HOST:-none}" OUR_HOSTS="${OUR_HOSTS:-$D_API_HOST $D_APP_HOST}" \
    STUB_API_HOST="${STUB_API_HOST:-$D_API_HOST}" STUB_API_PORT="${STUB_API_PORT:-$D_API_PORT}" STUB_WEB_PORT="${STUB_WEB_PORT:-$D_WEB_PORT}" \
    DDC_LOCAL_TEST=1 NEW_DIR="${NGX_NEW:-$d/ddcnew}" NGINX_AVAIL="$d/avail" NGINX_ENABLED="$d/enabled" NGINX_CONFD="$d/confd" MAINNET_DIR="$d/mainnet" \
    ${NGX_ENV:-} bash "$PKG/30-nginx.sh" "$@" > "$d/out" 2>&1 || RC=$?
}
ng() { ngx "$NX" "$1" "$2"; }
nreloads() { grep -c . "$1/reloads" 2>/dev/null || echo 0; }
HOSTS4="admin.datadance.ai=200 api.datadance.ai=200 app.datadance.ai=200 business.datadance.ai=200"
ng none apply
[ "$RC" = 0 ] && grep -q '^PASS every other host answers exactly as before (4 hosts)' "$NX/out" && [ -L "$NX/enabled/$D_API_HOST" ] \
  && [ "$(head -n 1 "$NX/avail/$D_API_HOST")" = "$MARKER" ] && grep -q "this stack does not answer yet (api on 127.0.0.1:$D_API_PORT answers 000 .*), so 40-up.sh runs the Host-header checks" "$NX/out" \
  && ok "30-nginx.sh apply, other hosts' codes unchanged -> passes; both files carry the marker line; the stack is not up, so the Host-header checks are left to 40-up.sh" || { cat "$NX/out"; bad "apply baseline (rc=$RC)"; }
touch "$NX/stack-up"; ng none apply
[ "$RC" = 0 ] && grep -q "^PASS $D_API_HOST answers 401 JSON$" "$NX/out" && grep -q "^PASS $D_APP_HOST serves the tge mainnet build for https://$D_API_HOST/api$" "$NX/out" \
  && grep -q "^PASS $D_API_HOST: the host nginx answers this package's vhost token" "$NX/out" && grep -q "^PASS $D_APP_HOST: the host nginx answers this package's vhost token" "$NX/out" \
  && ok "30-nginx.sh apply with the stack up: the Host-header checks run right after the reload (this package's vhost token for both hosts, 401 JSON through $D_API_HOST, the build marker through $D_APP_HOST)" || { cat "$NX/out"; bad "apply with the stack up (rc=$RC)"; }
NGX_ENV="STUB_VIA_NGINX_BROKEN=1" ng none apply
[ "$RC" = 1 ] && [ "$(tail -1 "$NX/out")" = "FAIL the Host-header checks failed after the reload — run ./30-nginx.sh undo now" ] \
  && ok "30-nginx.sh apply: a Host-header check that fails after the reload STOPS and says to undo" || { tail -5 "$NX/out"; bad "failing Host-header check (rc=$RC)"; }
rm -f "$NX/stack-up"
ng api.datadance.ai apply
[ "$RC" = 1 ] && grep -qF "FAIL status codes of other hosts changed: before [$HOSTS4] after [admin.datadance.ai=200 api.datadance.ai=502 app.datadance.ai=200" "$NX/out" \
  && grep -q '^PASS old-stack containers unchanged' "$NX/out" && [ "$(tail -1 "$NX/out")" = "FAIL status codes of other hosts changed after the reload — run ./30-nginx.sh undo now" ] \
  && ok "30-nginx.sh apply, old api vhost answers 502 after the reload -> integrity check printed, then STOPS: $(tail -1 "$NX/out")" || { cat "$NX/out"; bad "apply stop case (rc=$RC)"; }
# https with SNI on 443 joins the check whenever something listens there; a change on https alone is caught too.
touch "$NX/tls-on"; ng none apply
[ "$RC" = 0 ] && grep -qF "other hosts before: admin.datadance.ai=200/200 api.datadance.ai=200/200 app.datadance.ai=200/200 business.datadance.ai=200/200" "$NX/out" \
  && ! grep -q '^WARN https on' "$NX/out" \
  && ok "with a listener on 443 every other host is probed over http and over https with SNI (host=<http>/<https>)" || { grep 'other hosts' "$NX/out"; bad "https probe (rc=$RC)"; }
# stub-curl.py picks the https virtual server by the SNI name only (as nginx does for TLS): a probe without SNI misses this.
CHANGE_TLS_HOST=app.datadance.ai ng none apply
[ "$RC" = 1 ] && grep -qF "after [admin.datadance.ai=200/200 api.datadance.ai=200/200 app.datadance.ai=200/502" "$NX/out" \
  && ok "a host that changes only over https (SNI app.datadance.ai) after the reload STOPS apply" || { grep -E 'FAIL|other hosts' "$NX/out"; bad "https-only change (rc=$RC)"; }
# A listener on 443 that never completes TLS: every https probe stops at its time limit (curl -m; the stub hangs without
# one), so apply ends, and a WARN says that the https half of the comparison proved nothing (000 everywhere, both times).
NGX_TIMEOUT=120 NGX_ENV="STUB_TLS_HANG=1" ng none apply
[ "$RC" = 0 ] && grep -qF "other hosts before: admin.datadance.ai=200/000 api.datadance.ai=200/000 app.datadance.ai=200/000 business.datadance.ai=200/000" "$NX/out" \
  && grep -q '^WARN https on 127.0.0.1:443 answered no host (000 for every host, before and after)' "$NX/out" \
  && ok "a listener on 443 that never answers: each https probe ends at its time limit (000), apply finishes, and a WARN says that the comparison covered http only" \
  || { tail -4 "$NX/out"; bad "https probe against a listener that never answers (rc=$RC; 124 = hung)"; }
rm -f "$NX/tls-on"
ng app.datadance.ai undo
[ "$RC" = 1 ] && grep -q "FAIL status codes of other hosts changed after the reload — this package's vhosts are already removed" "$NX/out" && [ ! -e "$NX/avail/$D_API_HOST" ] \
  && ok "30-nginx.sh undo, old app vhost changed after the reload -> STOPS (this package's vhosts already removed)" || { cat "$NX/out"; bad "undo stop case (rc=$RC)"; }
ng none apply; ng none undo
[ "$RC" = 0 ] && grep -q '^PASS every other host answers exactly as before' "$NX/out" && [ -f "$NX/reloaded" ] && ok "30-nginx.sh undo, other hosts' codes unchanged -> passes" || { cat "$NX/out"; bad "undo baseline (rc=$RC)"; }
ng none undo
[ "$RC" = 0 ] && grep -q "^PASS nothing of this package's at $D_API_HOST / $D_APP_HOST: nothing removed, nginx not reloaded" "$NX/out" && [ ! -f "$NX/reloaded" ] \
  && ok "30-nginx.sh undo with nothing of this package's left: no change and no reload" || { cat "$NX/out"; bad "undo with nothing to remove (rc=$RC)"; }
for f in 30-nginx.sh 40-up.sh; do grep -qE 'warn "old (vhost )?(status )?codes|warn "status codes' "$PKG/$f" && bad "$f still only warns on changed codes"; done
grep -q 'die "status codes of other hosts changed while 40-up.sh ran' "$PKG/40-up.sh" && ok "40-up.sh step 8: changed codes of other hosts STOP the script (same pattern as 30-nginx.sh; no warn left in either)" || bad "40-up.sh step 8 still warns"
# 40-up.sh step 7 runs the Host-header checks only through this package's own vhosts, else it defers them to 30-nginx.sh.
grep -q '^if vhosts_ours; then$' "$PKG/40-up.sh" && grep -q '^  host_checks$' "$PKG/40-up.sh" && grep -q 'DEFERRED: the vhost entries at' "$PKG/40-up.sh" \
  && ( DDC_LOCAL_TEST=1; NEW_DIR="$NX/ddcnew"; NGINX_AVAIL="$NX/avail"; NGINX_ENABLED="$NX/enabled"; . "$PKG/common.sh"; ! vhosts_ours ) \
  && ok "40-up.sh step 7: the Host-header checks run only while this package's vhosts serve both hosts (vhosts_ours), otherwise they are DEFERRED to 30-nginx.sh apply" || bad "40-up.sh step 7 wiring"

echo; echo "== 12b. 30-nginx.sh and the vhosts it did not write (Race's at the default names): refusal, take-over with backup, rollback, restore, limits, clash, port, outcome B"
NR="$T/nginx-race"; vhosts "$NR"
mainnet_docker() { # <dir> [port]: stub docker with Race's two containers, ddc-mainnet-api (host port 10010) and
  # ddc-mainnet-app (9011), and two of the old production stack, ddc-ddc-app-1 (9001) and ddc-backend-ddc-backend-api-1
  # (10000): only Race's ports may count as his. With <port>, ddc-mainnet-api also publishes 127.0.0.1:<port> (a port held
  # by another container). ddc-mainnet-api's restart count is $STUB_DIR/restarts when that file exists (else 0).
  cat > "$1/bin/docker" <<STUB
#!/bin/sh
HELD="${2:-}"
STUB
  cat >> "$1/bin/docker" <<'STUB'
case "$1" in
  ps) case "$*" in *"{{.Names}} {{.Ports}}"*) [ -z "$HELD" ] || echo "ddc-mainnet-api 127.0.0.1:$HELD->3000/tcp";; *"{{.Names}}"*) printf '%s\n' ddc-mainnet-api ddc-mainnet-app ddc-ddc-app-1 ddc-backend-ddc-backend-api-1;; esac;;
  inspect) for c; do :; done
           case "$*" in
             *PortBindings*) case "$c" in ddc-mainnet-api) echo "10010 ";; ddc-mainnet-app) echo "9011 ";; ddc-ddc-app-1) echo "9001 ";; ddc-backend-ddc-backend-api-1) echo "10000 ";; esac;;
             *"{{.Name}}|{{.Id}}"*) r=0; if [ "$c" = ddc-mainnet-api ] && [ -f "$STUB_DIR/restarts" ]; then r=$(cat "$STUB_DIR/restarts"); fi
                                   echo "/$c|id-$c|running|2026-10-05T04:00:00Z|$r|unless-stopped";;
           esac;;
esac
exit 0
STUB
  chmod 755 "$1/bin/docker"
}
mainnet_docker "$NR"
race_entries() { # <dir>: Race's rehearsal entries as on 10-05 (synthetic): his two vhosts at the default names (a link,
  # and a regular file in sites-enabled), and his older tge-api / tge files, enabled by links
  printf 'server {\n    server_name %s;\n    location / { proxy_pass http://localhost:10010; }\n    listen 80;\n}\n' "$D_API_HOST" > "$1/avail/$D_API_HOST"
  printf 'server {\n    server_name %s;\n    location / { proxy_pass http://localhost:9011; }\n    listen 80;\n}\n' "$D_APP_HOST" > "$1/avail/$D_APP_HOST"
  printf 'server {\n    server_name tge-api.datadance.ai;\n    location / { proxy_pass http://localhost:10010; }\n    listen 80;\n}\n' > "$1/avail/tge-api.datadance.ai"
  printf 'server {\n    server_name tge.datadance.ai;\n    location / { proxy_pass http://localhost:9011; }\n    listen 80;\n}\n' > "$1/avail/tge.datadance.ai"
  ln -sfn "../avail/$D_API_HOST" "$1/enabled/$D_API_HOST"; cp -p "$1/avail/$D_APP_HOST" "$1/enabled/$D_APP_HOST"
  ln -sfn "../avail/tge-api.datadance.ai" "$1/enabled/tge-api.datadance.ai"; ln -sfn "../avail/tge.datadance.ai" "$1/enabled/tge.datadance.ai"
}
race_entries "$NR"
vsnap() { local d="${1:-$NR}"; (cd "$d" && find avail enabled confd -mindepth 1 \( -type f -o -type l \) | LC_ALL=C sort | while IFS= read -r f; do
  if [ -L "$f" ]; then echo "L $f -> $(readlink "$f")"; else echo "F $f $(shasum -a 256 < "$f" | cut -c1-16) $(stat -f %Lp "$f")"; fi; done); }
vsnap > "$NR/orig.snap"
nr() { ngx "$NR" "$@"; }
backups() { find "$1/ddcnew/vhost-takeover" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | LC_ALL=C sort; }
nr none apply
[ "$RC" = 1 ] && grep -q "^FAIL refusing: 4 vhost entry(s) at the names $D_API_HOST / $D_APP_HOST were not written by this package" "$NR/out" \
  && [ "$(grep -c '^  not written by this package: ' "$NR/out")" = 4 ] && [ ! -f "$NR/reloaded" ] && vsnap | cmp -s - "$NR/orig.snap" \
  && ok "apply with Race's vhost and link (and a regular file in sites-enabled) at the default names: STOPS, names all 4, changes nothing, no reload" || { cat "$NR/out"; bad "refusal of Race's entries (rc=$RC)"; }
# S3: never point the other party's hosts at a stack that has not booted.
NGX_ENV="TAKE_OVER_VHOSTS=yes" nr none apply
[ "$RC" = 1 ] && grep -q "^FAIL refusing TAKE_OVER_VHOSTS=yes until this stack answers on its own ports: api on 127.0.0.1:$D_API_PORT answers 000" "$NR/out" \
  && vsnap | cmp -s - "$NR/orig.snap" && [ -z "$(backups "$NR")" ] && [ ! -f "$NR/reloaded" ] \
  && ok "TAKE_OVER_VHOSTS=yes while this stack does not answer on 127.0.0.1:$D_API_PORT: refused before any backup or change (40-up.sh first)" || { cat "$NR/out"; bad "take-over before the stack is up (rc=$RC)"; }
touch "$NR/stack-up"
# S3: the api port must answer exactly 401 (not merely something).
NGX_ENV="TAKE_OVER_VHOSTS=yes STUB_API_CODE=200" nr none apply
[ "$RC" = 1 ] && grep -q "^FAIL refusing TAKE_OVER_VHOSTS=yes until this stack answers on its own ports: api on 127.0.0.1:$D_API_PORT answers 200 for /partner/tge/me, not 401" "$NR/out" \
  && vsnap | cmp -s - "$NR/orig.snap" && [ -z "$(backups "$NR")" ] && [ ! -f "$NR/reloaded" ] \
  && ok "TAKE_OVER_VHOSTS=yes while the api on 127.0.0.1:$D_API_PORT answers 200 instead of 401: refused before any backup or change" || { cat "$NR/out"; bad "take-over with the api answering 200 (rc=$RC)"; }
NGX_ENV="TAKE_OVER_VHOSTS=yes" nr none apply
bk=$(backups "$NR" | tail -n 1)
copies_ok=0
if [ -n "$bk" ] && [ -f "$bk/MANIFEST" ] && [ ! -e "$bk/MANIFEST.part" ] && [ "$(grep -c . "$bk/MANIFEST")" = 4 ]; then
  copies_ok=1
  while read -r t k nm x; do
    if [ "$t" = file ]; then [ "$(shasum -a 256 < "$bk/$k/$nm" | cut -c1-64)" = "$x" ] || copies_ok=0; else [ "$x" = "../avail/$D_API_HOST" ] || copies_ok=0; fi
  done < "$bk/MANIFEST"
fi
[ "$RC" = 0 ] && [ "$copies_ok" = 1 ] && [ "$(head -n 1 "$NR/avail/$D_API_HOST")" = "$MARKER" ] && [ "$(head -n 1 "$NR/avail/$D_APP_HOST")" = "$MARKER" ] \
  && [ "$(readlink "$NR/enabled/$D_APP_HOST")" = "$NR/avail/$D_APP_HOST" ] && grep -q '^PASS every other host answers exactly as before (6 hosts)' "$NR/out" \
  && grep -q "^PASS $D_API_HOST answers 401 JSON$" "$NR/out" && grep -q '^PASS take-over complete: ' "$NR/out" && grep -q '^PASS old-stack files unchanged' "$NR/out" \
  && grep -q "^PASS $D_API_HOST: the host nginx answers this package's vhost token" "$NR/out" && grep -q "^PASS $D_APP_HOST: the host nginx answers this package's vhost token" "$NR/out" \
  && [ "$(vsnap | grep -E 'tge(-api)?\.datadance\.ai' | tr '\n' ' ')" = "$(grep -E 'tge(-api)?\.datadance\.ai' "$NR/orig.snap" | tr '\n' ' ')" ] \
  && ok "TAKE_OVER_VHOSTS=yes with this stack up: the 4 entries backed up first (complete MANIFEST: sha256 of each copy, the link target), replaced, and the Host-header checks pass through the new vhosts (their token first); Race's other vhosts untouched" \
  || { cat "$NR/out"; bad "take-over (rc=$RC copies_ok=$copies_ok)"; }
# Recovery order: restore first (one reload swaps the entries back), never undo first (the names would have no vhost).
nr none undo
[ "$RC" = 1 ] && grep -q "^FAIL refusing: the take-over backup(s) $(basename "$bk") under .* were never restored. Run ./30-nginx.sh restore first" "$NR/out" \
  && [ "$(head -n 1 "$NR/avail/$D_API_HOST")" = "$MARKER" ] && [ -L "$NR/enabled/$D_APP_HOST" ] && [ ! -f "$NR/reloaded" ] \
  && ok "undo after a take-over refuses while its backup is not restored (restore first); nothing changed, no reload" || { cat "$NR/out"; bad "undo after take-over (rc=$RC)"; }
nr none restore
[ "$RC" = 0 ] && vsnap | cmp -s - "$NR/orig.snap" && [ -f "$bk/RESTORED" ] && grep -q '^PASS restored 4 entries from ' "$NR/out" && grep -q '^PASS old-stack files unchanged' "$NR/out" \
  && [ "$(nreloads "$NR")" = 1 ] && [ -z "$(ls -A "$NR/ddcnew/vhost-restore-hold" 2>/dev/null)" ] \
  && ok "restore right after the take-over: this package's entries set aside, Race's 4 put back exactly (content, modes, the link target, the regular file in sites-enabled) in one reload, the backup marked RESTORED" || { cat "$NR/out"; vsnap | diff "$NR/orig.snap" - || true; bad "restore (rc=$RC)"; }
nr none undo
[ "$RC" = 0 ] && grep -q "^PASS nothing of this package's at $D_API_HOST / $D_APP_HOST: nothing removed, nginx not reloaded" "$NR/out" && vsnap | cmp -s - "$NR/orig.snap" \
  && ok "after the restore, undo (and so 99-teardown.sh) finds nothing of this package's at the names: no change, no reload" || { cat "$NR/out"; bad "undo after the restore (rc=$RC)"; }
nr none restore "$(basename "$bk")"
[ "$RC" = 1 ] && grep -q 'was already restored' "$NR/out" && vsnap | cmp -s - "$NR/orig.snap" && ok "a second restore of the same backup is refused" || { cat "$NR/out"; bad "second restore (rc=$RC)"; }
# E3: restore when nginx -t fails with the restored entries: this package's entries come back, never neither.
NGX_ENV="TAKE_OVER_VHOSTS=yes" nr none apply; vsnap > "$NR/ours.snap"
mkdir -p "$NR/bin-e3"; cp "$NR/bin/docker" "$NR/bin-e3/docker"
printf '#!/bin/sh\n[ "$1" = -t ] && grep -q "localhost:10010" "%s/avail/%s" 2>/dev/null && { echo "nginx: [emerg] stub failure" >&2; exit 1; }\nexit 0\n' "$NR" "$D_API_HOST" > "$NR/bin-e3/nginx"
chmod 755 "$NR/bin-e3/nginx"; mv "$NR/bin" "$NR/bin-ok"; mv "$NR/bin-e3" "$NR/bin"
nr none restore
mv "$NR/bin" "$NR/bin-e3"; mv "$NR/bin-ok" "$NR/bin"
bk=$(backups "$NR" | tail -n 1)
[ "$RC" = 1 ] && grep -q 'nginx -t fails with the restored entries' "$NR/out" && vsnap | cmp -s - "$NR/ours.snap" && [ ! -f "$NR/reloaded" ] && [ ! -e "$bk/RESTORED" ] \
  && grep -q "put back .*(this package's)" "$NR/out" \
  && ok "restore with nginx -t failing on the restored entries: they go again and this package's come back exactly (set aside, not deleted); no reload, the backup is not marked RESTORED" || { cat "$NR/out"; vsnap | diff "$NR/ours.snap" - || true; bad "restore when nginx -t fails (rc=$RC)"; }
nr none restore
[ "$RC" = 0 ] && vsnap | cmp -s - "$NR/orig.snap" && ok "the same restore with a working nginx -t then puts Race's entries back exactly" || { cat "$NR/out"; bad "restore after the failed one (rc=$RC)"; }
# E1: a failure after Race's entries were removed and before nginx -t (here: chmod of the new file fails).
mkdir -p "$NR/bin-e1"; cp "$NR/bin/docker" "$NR/bin-e1/docker"
printf '#!/bin/sh\nfor a in "$@"; do case "$a" in *.new) echo "chmod: stub failure (disk full)" >&2; exit 1;; esac; done\nexec /bin/chmod "$@"\n' > "$NR/bin-e1/chmod"
chmod 755 "$NR/bin-e1/chmod"; mv "$NR/bin" "$NR/bin-ok"; mv "$NR/bin-e1" "$NR/bin"
NGX_ENV="TAKE_OVER_VHOSTS=yes" nr none apply
mv "$NR/bin" "$NR/bin-e1"; mv "$NR/bin-ok" "$NR/bin"
bk=$(backups "$NR" | tail -n 1)
[ "$RC" != 0 ] && vsnap | cmp -s - "$NR/orig.snap" && [ -f "$bk/RESTORED" ] && grep -q '^FAIL the take-over did not complete: putting the taken-over entries back' "$NR/out" \
  && grep -q "rolled back: the other party's entries are back; nginx was not reloaded" "$NR/out" && [ ! -f "$NR/reloaded" ] \
  && ok "a failure after Race's entries were removed (before nginx -t) puts them back at once from the backup (RESTORED), exactly; nothing reloaded" || { cat "$NR/out"; vsnap | diff "$NR/orig.snap" - || true; bad "rollback before nginx -t (rc=$RC)"; }
# E1 + E5: a failure after the reload (another host changed): the take-over is rolled back and nginx reloaded again;
# the message names restore in case the rollback could not finish. The rollback compares the other hosts again after its
# reload, and says so when one still answers differently (the stub's host stays changed).
NGX_ENV="TAKE_OVER_VHOSTS=yes" nr api.datadance.ai apply
bk=$(backups "$NR" | tail -n 1)
[ "$RC" = 1 ] && grep -qF "the take-over is rolled back now, the other party's entries go back from the backup (if that fails: ./30-nginx.sh restore)" "$NR/out" \
  && vsnap | cmp -s - "$NR/orig.snap" && [ -f "$bk/RESTORED" ] && [ "$(nreloads "$NR")" = 2 ] && grep -q "rolled back: the other party's entries are back and nginx is reloaded with them" "$NR/out" \
  && grep -q '^FAIL after the rollback the other hosts do not answer as before apply: before \[.*api.datadance.ai=200 .*\] after \[.*api.datadance.ai=502 ' "$NR/out" \
  && ok "another host changing after a take-over's reload: STOP that names restore, then the rollback puts Race's entries back, reloads nginx again (2 reloads) and reports the host that still answers differently" || { cat "$NR/out"; bad "rollback after the reload (rc=$RC reloads=$(nreloads "$NR"))"; }
# S3 + E1: the Host-header checks run through the new vhosts right after a take-over's reload; when they fail there, the
# take-over is rolled back the same way, and the other hosts answer as before apply again.
NGX_ENV="TAKE_OVER_VHOSTS=yes STUB_VIA_NGINX_BROKEN=1" nr none apply
bk=$(backups "$NR" | tail -n 1)
[ "$RC" = 1 ] && grep -qF "FAIL the Host-header checks failed after the reload — the take-over is rolled back now" "$NR/out" \
  && vsnap | cmp -s - "$NR/orig.snap" && [ -f "$bk/RESTORED" ] && [ "$(nreloads "$NR")" = 2 ] && grep -q "rolled back: the other party's entries are back and nginx is reloaded with them" "$NR/out" \
  && grep -q '^PASS after the rollback every other host answers exactly as before apply (6 hosts)' "$NR/out" \
  && ok "the Host-header checks failing through the new vhosts after a take-over's reload: STOP, Race's entries put back exactly, nginx reloaded again (2 reloads), every other host answers as before apply" || { cat "$NR/out"; bad "rollback after failing Host-header checks (rc=$RC reloads=$(nreloads "$NR"))"; }
# A rollback that cannot finish (here: the backup copy no longer matches its MANIFEST when the install fails) says to run
# restore, with the backup's name.
mkdir -p "$NR/bin-e1b"; cp "$NR/bin/docker" "$NR/bin-e1b/docker"
cat > "$NR/bin-e1b/chmod" <<STUB
#!/bin/sh
for a in "\$@"; do case "\$a" in *.new)
  for b in "$NR"/ddcnew/vhost-takeover/*/; do [ -e "\$b/RESTORED" ] || printf 'damaged\\n' >> "\$b/avail/$D_API_HOST"; done
  echo "chmod: stub failure" >&2; exit 1;; esac; done
exec /bin/chmod "\$@"
STUB
chmod 755 "$NR/bin-e1b/chmod"; mv "$NR/bin" "$NR/bin-ok"; mv "$NR/bin-e1b" "$NR/bin"
NGX_ENV="TAKE_OVER_VHOSTS=yes" nr none apply
mv "$NR/bin" "$NR/bin-e1b"; mv "$NR/bin-ok" "$NR/bin"
bk=$(backups "$NR" | tail -n 1)
[ "$RC" != 0 ] && grep -qF "FAIL could not put the taken-over entries back: run ./30-nginx.sh restore $(basename "$bk")" "$NR/out" && [ ! -e "$bk/RESTORED" ] \
  && ok "a rollback that cannot finish (the backup no longer matches its MANIFEST) says to run ./30-nginx.sh restore $(basename "$bk")" || { tail -6 "$NR/out"; bad "rollback that cannot finish (rc=$RC)"; }
rm -rf -- "$bk"; rm -f "$NR/avail/$D_API_HOST" "$NR/avail/$D_APP_HOST" "$NR/enabled/$D_API_HOST" "$NR/enabled/$D_APP_HOST"; race_entries "$NR"
vsnap | cmp -s - "$NR/orig.snap" || bad "test setup: Race's entries not back to the original after the damaged-backup case"
# nginx -t fails with the new files: the taken-over entries go back at once, nothing is reloaded.
mkdir -p "$NR/bin-ntf"; printf '#!/bin/sh\nif grep -lq "^# ddcnew-vhost:" "%s"/avail/* 2>/dev/null; then echo "nginx: [emerg] stub failure" >&2; exit 1; fi\nexit 0\n' "$NR" > "$NR/bin-ntf/nginx"; chmod 755 "$NR/bin-ntf/nginx"
cp "$NR/bin/docker" "$NR/bin-ntf/docker"; mv "$NR/bin" "$NR/bin-ok"; mv "$NR/bin-ntf" "$NR/bin"
NGX_ENV="TAKE_OVER_VHOSTS=yes" nr none apply
mv "$NR/bin" "$NR/bin-ntf"; mv "$NR/bin-ok" "$NR/bin"
[ "$RC" = 1 ] && grep -q "rolled back: the other party's entries are back" "$NR/out" && grep -q '^FAIL nginx -t failed with the new vhosts' "$NR/out" && [ ! -f "$NR/reloaded" ] \
  && vsnap | cmp -s - "$NR/orig.snap" && [ -z "$(for b in $(backups "$NR"); do [ -f "$b/RESTORED" ] || echo "$b"; done)" ] \
  && ok "nginx -t failing after a take-over: Race's entries are put back at once (every backup marked RESTORED), nothing reloaded" || { cat "$NR/out"; bad "take-over rollback on nginx -t (rc=$RC)"; }
# M1: the stack answered before the take-over, then stops answering before the checks after the reload (a crash loop, an
# OOM kill): after a take-over those checks always run, fail, and the take-over is rolled back (never "complete").
printf '#!/bin/sh\n[ "$1 $2" = "reload nginx" ] && { touch "$STUB_DIR/reloaded"; echo reload >> "$STUB_DIR/reloads"; rm -f "$STUB_DIR/stack-up"; }\nexit 0\n' > "$NR/bin/systemctl"; chmod 755 "$NR/bin/systemctl"
NGX_ENV="TAKE_OVER_VHOSTS=yes" nr none apply
rm -f "$NR/bin/systemctl"; touch "$NR/stack-up"
bk=$(backups "$NR" | tail -n 1)
[ "$RC" = 1 ] && ! grep -q '^PASS take-over complete' "$NR/out" && grep -q "^FAIL $D_API_HOST check failed (502" "$NR/out" \
  && grep -qF "FAIL the Host-header checks failed after the reload — the take-over is rolled back now" "$NR/out" \
  && vsnap | cmp -s - "$NR/orig.snap" && [ -f "$bk/RESTORED" ] && [ "$(nreloads "$NR")" = 2 ] \
  && ok "the stack stops answering between the check before a take-over and the checks after its reload: the checks run anyway and fail, the take-over is rolled back exactly (2 reloads), never reported complete" \
  || { cat "$NR/out"; bad "take-over with a stack that stops answering after the pre-check (rc=$RC reloads=$(nreloads "$NR"))"; }
# The checks after the reload prove that nginx serves THIS package's vhosts (their token): a host nginx that still serves
# the other party's vhosts (a configuration that was not reloaded) answers the same 401 and build marker, not the token.
NGX_ENV="TAKE_OVER_VHOSTS=yes STUB_NGINX_STALE=1" nr none apply
bk=$(backups "$NR" | tail -n 1)
[ "$RC" = 1 ] && grep -q "^FAIL $D_API_HOST: the host nginx does not answer this package's vhost token" "$NR/out" && ! grep -q '^PASS take-over complete' "$NR/out" \
  && vsnap | cmp -s - "$NR/orig.snap" && [ -f "$bk/RESTORED" ] && [ "$(nreloads "$NR")" = 2 ] \
  && ok "a host nginx that still serves the other party's stack after the reload (same 401, same build marker): no vhost token, so the take-over is rolled back exactly" \
  || { cat "$NR/out"; bad "take-over with a host nginx that did not switch (rc=$RC)"; }
# A reload that reports a failure may still have reloaded nginx: the rollback then reloads it again (RELOADED is set first).
printf '#!/bin/sh\n[ "$1 $2" = "reload nginx" ] && { touch "$STUB_DIR/reloaded"; echo reload >> "$STUB_DIR/reloads"; [ -f "$STUB_DIR/failed-once" ] || { touch "$STUB_DIR/failed-once"; exit 1; }; }\nexit 0\n' > "$NR/bin/systemctl"; chmod 755 "$NR/bin/systemctl"
rm -f "$NR/failed-once"; NGX_ENV="TAKE_OVER_VHOSTS=yes" nr none apply
rm -f "$NR/bin/systemctl" "$NR/failed-once"
bk=$(backups "$NR" | tail -n 1)
[ "$RC" != 0 ] && vsnap | cmp -s - "$NR/orig.snap" && [ -f "$bk/RESTORED" ] && [ "$(nreloads "$NR")" = 2 ] && grep -q "rolled back: the other party's entries are back and nginx is reloaded with them" "$NR/out" \
  && ok "systemctl reload reports a failure during a take-over (nginx may have reloaded anyway): the rollback puts Race's entries back and reloads nginx again (2 reloads)" \
  || { cat "$NR/out"; bad "rollback after a reload that reported a failure (rc=$RC reloads=$(nreloads "$NR"))"; }
# The rollback says so when its own reload fails (the entries are back on disk; nginx may still serve this package's).
printf '#!/bin/sh\n[ "$1 $2" = "reload nginx" ] && { echo reload >> "$STUB_DIR/reloads"; [ -f "$STUB_DIR/reloaded" ] && exit 1; touch "$STUB_DIR/reloaded"; }\nexit 0\n' > "$NR/bin/systemctl"; chmod 755 "$NR/bin/systemctl"
NGX_ENV="TAKE_OVER_VHOSTS=yes STUB_VIA_NGINX_BROKEN=1" nr none apply
rm -f "$NR/bin/systemctl"
bk=$(backups "$NR" | tail -n 1)
[ "$RC" = 1 ] && grep -q "^FAIL the rollback put the other party's entries back, but systemctl reload nginx failed" "$NR/out" \
  && vsnap | cmp -s - "$NR/orig.snap" && [ -f "$bk/RESTORED" ] && [ "$(nreloads "$NR")" = 2 ] \
  && ok "a rollback whose own reload fails says so (the entries are back on disk; reload nginx by hand)" || { cat "$NR/out"; bad "rollback with a failing reload (rc=$RC)"; }
# Nothing stops a rollback once it runs: a second TERM, sent while the rollback runs nginx -t (the 3rd nginx -t of the run),
# is ignored; the rollback still reloads nginx and compares the other hosts.
cat > "$NR/bin/nginx" <<STUB
#!/bin/sh
n=\$(cat "$NR/nginxn" 2>/dev/null || echo 0); n=\$((n + 1)); echo \$n > "$NR/nginxn"
if [ "\$1" = -t ] && [ \$n = 3 ]; then kill -TERM \$PPID; fi
exit 0
STUB
chmod 755 "$NR/bin/nginx"; rm -f "$NR/nginxn"
NGX_ENV="TAKE_OVER_VHOSTS=yes STUB_VIA_NGINX_BROKEN=1" nr none apply
rm -f "$NR/bin/nginx" "$NR/nginxn"
bk=$(backups "$NR" | tail -n 1)
[ "$RC" = 1 ] && vsnap | cmp -s - "$NR/orig.snap" && [ -f "$bk/RESTORED" ] && [ "$(nreloads "$NR")" = 2 ] \
  && grep -q "rolled back: the other party's entries are back and nginx is reloaded with them" "$NR/out" && grep -q '^PASS after the rollback every other host answers exactly as before apply' "$NR/out" \
  && ok "a second TERM while the rollback runs (during its nginx -t) is ignored: Race's entries back, nginx reloaded again, the other hosts compared" \
  || { cat "$NR/out"; bad "rollback with a second signal (rc=$RC reloads=$(nreloads "$NR"))"; }
# The last check of apply (the old stack, Race's containers included, unchanged) fails after a take-over: rolled back too.
printf '#!/bin/sh\n[ "$1 $2" = "reload nginx" ] && { touch "$STUB_DIR/reloaded"; echo reload >> "$STUB_DIR/reloads"; echo 1 > "$STUB_DIR/restarts"; }\nexit 0\n' > "$NR/bin/systemctl"; chmod 755 "$NR/bin/systemctl"
NGX_ENV="TAKE_OVER_VHOSTS=yes" nr none apply
rm -f "$NR/bin/systemctl" "$NR/restarts"
bk=$(backups "$NR" | tail -n 1)
[ "$RC" = 1 ] && grep -q '^FAIL old-stack containers changed during this script' "$NR/out" && ! grep -q '^PASS take-over complete' "$NR/out" \
  && vsnap | cmp -s - "$NR/orig.snap" && [ -f "$bk/RESTORED" ] && [ "$(nreloads "$NR")" = 2 ] \
  && ok "a ddc-mainnet container restarting during a take-over fails apply's final old-stack check: the take-over is rolled back exactly (2 reloads), never reported complete" \
  || { cat "$NR/out"; bad "rollback on the final old-stack check (rc=$RC)"; }
# A rollback that stops half way (putting back Race's file at sites-available/<APP_HOST> fails) says to run restore, and
# restore then keeps the entries already back exactly as their MANIFEST lines say and puts back the missing one.
cat > "$NR/bin/chmod" <<STUB
#!/bin/sh
for a in "\$@"; do case "\$a" in *.new) echo "chmod: stub failure" >&2; exit 1;; esac; done
exec /bin/chmod "\$@"
STUB
cat > "$NR/bin/cp" <<STUB
#!/bin/sh
for last; do :; done
case "\$last" in *vhost-takeover*) ;; */avail/$D_APP_HOST) case "\$*" in *vhost-takeover*) echo "cp: stub failure" >&2; exit 1;; esac;; esac
exec /bin/cp "\$@"
STUB
chmod 755 "$NR/bin/chmod" "$NR/bin/cp"
NGX_ENV="TAKE_OVER_VHOSTS=yes" nr none apply
rm -f "$NR/bin/chmod" "$NR/bin/cp"
bk=$(backups "$NR" | tail -n 1); half=0
[ "$RC" != 0 ] && grep -qF "FAIL could not put the taken-over entries back: run ./30-nginx.sh restore $(basename "$bk")" "$NR/out" && [ ! -e "$NR/avail/$D_APP_HOST" ] && [ -f "$NR/enabled/$D_APP_HOST" ] && half=1
nr none restore
[ "$half" = 1 ] && [ "$RC" = 0 ] && [ "$(grep -c '^  already back exactly as in the backup: ' "$NR/out")" = 3 ] && grep -q '^PASS restored 1 entries from ' "$NR/out" \
  && vsnap | cmp -s - "$NR/orig.snap" && [ -f "$bk/RESTORED" ] \
  && ok "a rollback that stops half way says to run restore; restore keeps the 3 entries already back (each exactly its MANIFEST line) and puts back the missing one: Race's 4 entries exactly" \
  || { cat "$NR/out"; vsnap | diff "$NR/orig.snap" - || true; bad "restore after a rollback that stopped half way (half=$half rc=$RC)"; }
# A take-over refuses while this package already has an entry at the names next to Race's (a leftover .new here): its
# rollback must only ever remove what that run wrote itself.
cp "$NG/$D_APP_HOST" "$NR/avail/$D_APP_HOST.new"; nb=$(backups "$NR" | grep -c . || true)
NGX_ENV="TAKE_OVER_VHOSTS=yes" nr none apply
rm -f "$NR/avail/$D_APP_HOST.new"
[ "$RC" = 1 ] && grep -q "^FAIL refusing TAKE_OVER_VHOSTS=yes while this package already has entries at these names" "$NR/out" \
  && grep -qF "written by this package earlier: $NR/avail/$D_APP_HOST.new" "$NR/out" && [ "$(backups "$NR" | grep -c . || true)" = "$nb" ] && [ ! -f "$NR/reloaded" ] \
  && vsnap | cmp -s - "$NR/orig.snap" \
  && ok "TAKE_OVER_VHOSTS=yes refuses while an entry of this package's sits at the names next to Race's (undo first): nothing backed up or changed, no reload" || { cat "$NR/out"; bad "take-over next to this package's own entry (rc=$RC)"; }
# E3: restore arms its rollback before it sets anything aside: when setting this package's 2nd entry aside fails, the 1st
# comes back too.
NGX_ENV="TAKE_OVER_VHOSTS=yes" nr none apply; vsnap > "$NR/ours2.snap"; bk=$(backups "$NR" | tail -n 1)
cat > "$NR/bin/mv" <<STUB
#!/bin/sh
case "\$*" in *vhost-restore-hold*) n=\$(cat "$NR/mvn" 2>/dev/null || echo 0); n=\$((n + 1)); echo \$n > "$NR/mvn"; [ \$n = 2 ] && { echo "mv: stub failure" >&2; exit 1; };; esac
exec /bin/mv "\$@"
STUB
chmod 755 "$NR/bin/mv"; rm -f "$NR/mvn"
nr none restore
rm -f "$NR/bin/mv" "$NR/mvn"
[ "$RC" = 1 ] && grep -q '^FAIL cannot set .* aside' "$NR/out" && vsnap | cmp -s - "$NR/ours2.snap" && [ ! -e "$bk/RESTORED" ] && [ ! -f "$NR/reloaded" ] \
  && ok "restore failing while it sets this package's entries aside (the 2nd move): the 1st comes back, this package's entries are exactly as before, nothing reloaded" \
  || { cat "$NR/out"; vsnap | diff "$NR/ours2.snap" - || true; bad "restore with a failing set-aside (rc=$RC)"; }
nr none restore
[ "$RC" = 0 ] && vsnap | cmp -s - "$NR/orig.snap" || { cat "$NR/out"; bad "test setup: restore after the failing set-aside (rc=$RC)"; }
# S4 takes over the usual shape of a certbot-managed rehearsal vhost: an https server block that includes certbot's
# options and proxy_params and proxies to a ddc-mainnet-* port, and a port-80 block that only redirects.
NC="$T/nginx-certbot"; vhosts "$NC"; mainnet_docker "$NC"; race_entries "$NC"; touch "$NC/stack-up"
for hp in "$D_API_HOST:10010" "$D_APP_HOST:9011"; do
  h=${hp%%:*}; pt=${hp#*:}
  printf 'server {\n    server_name %s;\n    location / {\n        include proxy_params;\n        proxy_pass http://127.0.0.1:%s/;\n    }\n    listen 443 ssl; # managed by Certbot\n    ssl_certificate /etc/letsencrypt/live/%s/fullchain.pem; # managed by Certbot\n    include /etc/letsencrypt/options-ssl-nginx.conf; # managed by Certbot\n}\nserver {\n    if ($host = %s) {\n        return 301 https://$host$request_uri;\n    } # managed by Certbot\n    listen 80;\n    server_name %s;\n    return 404; # managed by Certbot\n}\n' "$h" "$pt" "$h" "$h" "$h" > "$NC/avail/$h"
done
rm -f "$NC/enabled/$D_APP_HOST"; ln -s "../avail/$D_APP_HOST" "$NC/enabled/$D_APP_HOST"; vsnap "$NC" > "$NC/orig.snap"
NGX_ENV="TAKE_OVER_VHOSTS=yes" ngx "$NC" none apply
[ "$RC" = 0 ] && grep -q '^PASS take-over complete' "$NC/out" \
  && ok "TAKE_OVER_VHOSTS=yes takes over certbot-style rehearsal vhosts (include proxy_params and certbot's options, proxy_pass to 127.0.0.1:<ddc-mainnet port>/, a port-80 redirect block)" \
  || { grep '^FAIL' "$NC/out"; bad "certbot-style take-over (rc=$RC)"; }
ngx "$NC" none restore
[ "$RC" = 0 ] && vsnap "$NC" | cmp -s - "$NC/orig.snap" && ok "restore puts the certbot-style vhosts back exactly" || { cat "$NC/out"; bad "certbot-style restore (rc=$RC)"; }
# E2: an interrupted backup (the process killed mid-way, so no trap runs) leaves no MANIFEST, only MANIFEST.part, and
# then blocks neither restore, nor undo, nor 99-teardown.sh --delete-dir.
NE="$T/nginx-e2"; vhosts "$NE"; mainnet_docker "$NE"; race_entries "$NE"; touch "$NE/stack-up"; vsnap "$NE" > "$NE/orig.snap"
cat > "$NE/bin/cp" <<STUB
#!/bin/sh
# kills the script (SIGKILL: no trap runs) while it copies Race's regular file in sites-enabled into the backup
for a; do :; done
case "\$a" in */vhost-takeover/*/enabled/$D_APP_HOST) ls "\$(dirname "\$(dirname "\$a")")" > "$NE/at-kill.ls"; kill -9 \$PPID; exit 1;; esac
exec /bin/cp "\$@"
STUB
chmod 755 "$NE/bin/cp"
NGX_ENV="TAKE_OVER_VHOSTS=yes" ngx "$NE" none apply
rm -f "$NE/bin/cp"
e2b=$(backups "$NE" | tail -n 1)
[ "$RC" != 0 ] && [ -n "$e2b" ] && grep -qx 'MANIFEST.part' "$NE/at-kill.ls" && ! grep -qx MANIFEST "$NE/at-kill.ls" && [ ! -e "$e2b/MANIFEST" ] && vsnap "$NE" | cmp -s - "$NE/orig.snap" \
  && ok "a backup interrupted by SIGKILL half way holds MANIFEST.part only (no MANIFEST), and nothing was taken over" || { cat "$NE/out" "$NE/at-kill.ls" 2>/dev/null; bad "interrupted backup (rc=$RC)"; }
ngx "$NE" none restore
[ "$RC" = 1 ] && grep -q '^FAIL no take-over backup to restore' "$NE/out" && ok "restore ignores the interrupted backup (no complete backup to restore)" || { cat "$NE/out"; bad "restore with an interrupted backup (rc=$RC)"; }
ngx "$NE" none undo
[ "$RC" = 0 ] && ! grep -q 'were never restored' "$NE/out" && ok "undo does not count the interrupted backup as one to restore (it is not refused)" || { cat "$NE/out"; bad "undo with an interrupted backup (rc=$RC)"; }
printf 'name: ddcnew\n' > "$NE/ddcnew/compose.yaml"
printf '#!/bin/sh\ncase "$1" in compose) exit 1;; esac\nexit 0\n' > "$NE/bin/docker"; chmod 755 "$NE/bin/docker"
RC=0; env PATH="$NE/bin:$ST:$PATH" STUB_DIR="$NE" OUR_HOSTS="$D_API_HOST $D_APP_HOST" DDC_LOCAL_TEST=1 NEW_DIR="$NE/ddcnew" NGINX_AVAIL="$NE/avail" NGINX_ENABLED="$NE/enabled" \
  NGINX_CONFD="$NE/confd" MAINNET_DIR="$NE/mainnet" bash "$PKG/99-teardown.sh" --delete-dir > "$NE/td.out" 2>&1 || RC=$?
! grep -q 'never restored' "$NE/td.out" && grep -q 'is not the real /root/ddcnew directory' "$NE/td.out" \
  && ok "99-teardown.sh --delete-dir is not blocked by the interrupted backup (it stops later, at the local-test guard of the real /root/ddcnew)" || { tail -3 "$NE/td.out"; bad "teardown with an interrupted backup (rc=$RC)"; }
# S4: what TAKE_OVER_VHOSTS takes over: only the other party's rehearsal vhost of exactly that host, every upstream a
# ddc-mainnet-* port (the stub docker also lists two old-stack containers, on 9001 and 10000). Each variant stays refused
# with the flag and changes nothing. (%b: a variant's \n is a line break inside the file.)
cp -p "$NR/avail/$D_APP_HOST" "$NR/race-app.keep"; cp -p "$NR/enabled/$D_APP_HOST" "$NR/race-app-en.keep"
for v in "static|server_name $D_APP_HOST; root /opt/ddc/docs;|it proxies to nothing (a static site, not a rehearsal stack)" \
         "otherport|server_name $D_APP_HOST; location / { proxy_pass http://localhost:9500; }|it proxies to port 9500, which no ddc-mainnet-* container binds (they bind: 9011 10010)" \
         "oldport|server_name $D_APP_HOST; location / { proxy_pass http://localhost:10000; }|it proxies to port 10000, which no ddc-mainnet-* container binds" \
         "oldapp|server_name $D_APP_HOST; location / { proxy_pass http://127.0.0.1:9001/; }|it proxies to port 9001, which no ddc-mainnet-* container binds" \
         "remote|server_name $D_APP_HOST; location / { proxy_pass https://upstream.example.invalid; }|it proxies to https://upstream.example.invalid, not to a local port" \
         "remote-port|server_name $D_APP_HOST; location / { proxy_pass http://198.51.100.9:9011; }|it proxies to http://198.51.100.9:9011, not to a local port" \
         "second-name|server_name $D_APP_HOST other-rehearsal.datadance.ai; location / { proxy_pass http://localhost:9011; }|it declares server_name $D_APP_HOST other-rehearsal.datadance.ai instead of only $D_APP_HOST" \
         "wildcard|server_name $D_APP_HOST *.rehearsal.datadance.ai; location / { proxy_pass http://localhost:9011; }|it declares server_name *.rehearsal.datadance.ai $D_APP_HOST instead of only $D_APP_HOST" \
         "regex|server_name $D_APP_HOST ~^app-r; location / { proxy_pass http://localhost:9011; }|it declares server_name $D_APP_HOST ~^app-r instead of only $D_APP_HOST" \
         "underscore|server_name $D_APP_HOST _; location / { proxy_pass http://localhost:9011; }|it declares server_name _ $D_APP_HOST instead of only $D_APP_HOST" \
         "default-server|listen 443 default_server; server_name $D_APP_HOST; location / { proxy_pass http://localhost:9011; }|it is a default server (listen 443 default_server)" \
         "include|include /etc/nginx/snippets/more-sites.conf; server_name $D_APP_HOST; location / { proxy_pass http://localhost:9011; }|it includes /etc/nginx/snippets/more-sites.conf, which may declare more" \
         "fastcgi|server_name $D_APP_HOST; location / { proxy_pass http://localhost:9011; } location ~ [.]php$ { fastcgi_pass 127.0.0.1:9000; }|it hands requests on with fastcgi_pass" \
         "multiline|server_name $D_APP_HOST; location / { proxy_pass http://localhost:9011; }\n    location /x { proxy_pass\n        http://localhost:10000; }|it proxies to port 10000, which no ddc-mainnet-* container binds" \
         "commented|server_name $D_APP_HOST; root /opt/static; # location / { proxy_pass http://localhost:9011; }|it proxies to nothing (a static site, not a rehearsal stack)"; do
  lbl=${v%%|*}; r=${v#*|}; body=${r%%|*}; why=${r#*|}
  printf 'server {\n    %b\n    listen 80;\n}\n' "$body" > "$NR/avail/$D_APP_HOST"; cp -p "$NR/avail/$D_APP_HOST" "$NR/enabled/$D_APP_HOST"
  vsnap > "$NR/variant.snap"; nb=$(backups "$NR" | grep -c . || true)
  NGX_ENV="TAKE_OVER_VHOSTS=yes" nr none apply
  [ "$RC" = 1 ] && grep -qF "refusing to take over $NR/" "$NR/out" && grep -qF -- "$why" "$NR/out" && vsnap | cmp -s - "$NR/variant.snap" && [ ! -f "$NR/reloaded" ] && [ "$(backups "$NR" | grep -c . || true)" = "$nb" ] \
    || { grep '^FAIL' "$NR/out" | head -2; bad "take-over limit ($lbl, rc=$RC)"; }
done
cp -p "$NR/race-app.keep" "$NR/avail/$D_APP_HOST"; cp -p "$NR/race-app-en.keep" "$NR/enabled/$D_APP_HOST"; vsnap | cmp -s - "$NR/orig.snap" || bad "test setup: Race's entries not back to the original"
ok "TAKE_OVER_VHOSTS=yes refuses, before any backup or change: a static site (also one with a commented-out proxy_pass), an upstream on a port no ddc-mainnet-* container binds (another port, the old stack's api and app ports), a remote upstream (also one on a ddc-mainnet-* port number), a file that also serves another name (exact, wildcard, regex or _), a default server, an include outside certbot's options and proxy_params, a fastcgi_pass, and a proxy_pass to the old stack written over two lines"
printf '#!/bin/sh\nexit 0\n' > "$NR/bin/docker"
NGX_ENV="TAKE_OVER_VHOSTS=yes" nr none apply
mainnet_docker "$NR"
[ "$RC" = 1 ] && grep -qF "no ddc-mainnet-* container binds a host port, so its upstream cannot be shown to be the other party's rehearsal" "$NR/out" && vsnap | cmp -s - "$NR/orig.snap" \
  && ok "with no ddc-mainnet-* container (none bound to a port), nothing is taken over" || { grep '^FAIL' "$NR/out"; bad "take-over without ddc-mainnet containers (rc=$RC)"; }
# A hypothetical case: APP_HOST names a static site (docs.datadance.ai, say) that the same nginx serves.
DOCS=docs.datadance.ai; printf 'server {\n    server_name %s;\n    root /opt/ddc/docs;\n    listen 80;\n}\n' "$DOCS" > "$NR/avail/$DOCS"; ln -sfn "../avail/$DOCS" "$NR/enabled/$DOCS"; vsnap > "$NR/docs.snap"
OUR_HOSTS="$D_API_HOST $DOCS" NGX_NEW="$NR/ddcnew-docs" NGX_ENV="TAKE_OVER_VHOSTS=yes APP_HOST=$DOCS" nr none apply
[ "$RC" = 1 ] && grep -qF "refusing to take over $NR/enabled/$DOCS: it proxies to nothing (a static site, not a rehearsal stack)" "$NR/out" && vsnap | cmp -s - "$NR/docs.snap" \
  && ok "APP_HOST=docs.datadance.ai (a static site in this test) with TAKE_OVER_VHOSTS=yes: refused, the docs vhost stays as it is" || { grep -E '^(FAIL|PASS TAKE)' "$NR/out"; bad "docs take-over (rc=$RC)"; }
rm -f "$NR/avail/$DOCS" "$NR/enabled/$DOCS"
# A server_name clash in another loaded file stops apply, even with TAKE_OVER_VHOSTS=yes.
printf 'server { server_name other.datadance.ai %s; }\n' "$D_APP_HOST" > "$NR/confd/extra.conf"; vsnap > "$NR/clash.snap"
nbk=$(backups "$NR" | grep -c . || true)
NGX_ENV="TAKE_OVER_VHOSTS=yes" nr none apply
[ "$RC" = 1 ] && grep -q "^FAIL refusing: another file that nginx loads declares $D_API_HOST or $D_APP_HOST as a server_name" "$NR/out" && grep -q "$D_APP_HOST declared by $NR/confd/extra.conf" "$NR/out" \
  && vsnap | cmp -s - "$NR/clash.snap" && [ "$(backups "$NR" | grep -c . || true)" = "$nbk" ] \
  && ok "a clashing server_name in conf.d stops apply before anything is backed up or changed (TAKE_OVER_VHOSTS does not cover it)" || { cat "$NR/out"; bad "server_name clash (rc=$RC)"; }
rm -f "$NR/confd/extra.conf"
# A port of the settings held by another container (Race's) stops apply.
printf '#!/bin/sh\ncase "$*" in *":%s"*) echo "LISTEN 0 4096 127.0.0.1:%s 0.0.0.0:*";; esac\n' "$D_API_PORT" "$D_API_PORT" > "$NR/bin/ss"; chmod 755 "$NR/bin/ss"
mainnet_docker "$NR" "$D_API_PORT"
NGX_ENV="TAKE_OVER_VHOSTS=yes" nr none apply
[ "$RC" = 1 ] && grep -q "^FAIL port $D_API_PORT (API_PORT) is in use by ddc-mainnet-api: choose another one" "$NR/out" && vsnap | cmp -s - "$NR/orig.snap" \
  && ok "API_PORT held by another container (ddc-mainnet-api) stops apply, nothing changed" || { cat "$NR/out"; bad "port held (rc=$RC)"; }
rm -f "$NR/bin/ss"; mainnet_docker "$NR"
# Outcome B: this stack on other names next to Race's; his entries stay as they are, and his hosts must answer as before.
rm -f "$NR/stack-up"
OUR_HOSTS="api-coexist.datadance.ai app-coexist.datadance.ai" NGX_NEW="$NR/ddcnew-b" NGX_ENV="API_HOST=api-coexist.datadance.ai APP_HOST=app-coexist.datadance.ai API_PORT=10031 WEB_PORT=9031" nr none apply
[ "$RC" = 0 ] && [ "$(vsnap | grep -v coexist)" = "$(cat "$NR/orig.snap")" ] && [ "$(head -n 1 "$NR/avail/api-coexist.datadance.ai")" = "$MARKER" ] \
  && grep -q '^PASS every other host answers exactly as before (8 hosts)' "$NR/out" && grep -q "other hosts after: .*$D_API_HOST=200 .*$D_APP_HOST=200" "$NR/out" \
  && ok "outcome B (other names and ports): apply leaves all of Race's entries as they were; his rehearsal hosts are among the 8 other hosts that answer as before" || { cat "$NR/out"; bad "outcome B apply (rc=$RC)"; }
OUR_HOSTS="api-coexist.datadance.ai app-coexist.datadance.ai" NGX_NEW="$NR/ddcnew-b" NGX_ENV="API_HOST=api-coexist.datadance.ai APP_HOST=app-coexist.datadance.ai API_PORT=10031 WEB_PORT=9031" nr "$D_API_HOST" apply
[ "$RC" = 1 ] && grep -q '^FAIL status codes of other hosts changed: ' "$NR/out" && grep -q "after \[.*$D_API_HOST=502" "$NR/out" \
  && ok "outcome B: if Race's host answers differently after the reload, apply STOPS" || { cat "$NR/out"; bad "outcome B stop (rc=$RC)"; }
OUR_HOSTS="api-coexist.datadance.ai app-coexist.datadance.ai" NGX_NEW="$NR/ddcnew-b" nr none undo
[ "$RC" = 0 ] && vsnap | cmp -s - "$NR/orig.snap" && ok "outcome B undo (hosts from the settings record): removes only this package's coexist entries; Race's exactly as before" || { cat "$NR/out"; bad "outcome B undo (rc=$RC)"; }
# 99-teardown.sh when docker compose cannot run (e.g. .env missing): removal by the ddcnew compose label only. The record
# holds NON-default hosts and ports, with this package's vhosts written at those names: teardown must undo the vhosts
# with the recorded hosts BEFORE it forgets the record (else undo would look at the defaults and leave them).
TD="$T/teardown"; vhosts "$TD"; mkdir -p "$TD/bin"
TDH="API_HOST=api-tdtest.datadance.ai APP_HOST=app-tdtest.datadance.ai API_PORT=10041 WEB_PORT=9041 DB_PORT=15441"
OUR_HOSTS="api-tdtest.datadance.ai app-tdtest.datadance.ai" NGX_ENV="$TDH" ngx "$TD" none apply
[ "$RC" = 0 ] && [ -f "$TD/avail/api-tdtest.datadance.ai" ] && [ -L "$TD/enabled/app-tdtest.datadance.ai" ] && grep -qx 'API_HOST=api-tdtest.datadance.ai' "$TD/ddcnew/settings.env" || bad "teardown setup: apply with non-default settings (rc=$RC)"
printf 'name: ddcnew\n' > "$TD/ddcnew/compose.yaml"
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
  PATH="$TD/bin:$ST:$PATH" STUB_DIR="$TD" STUB_BAD="$1" CHANGE_HOST=none OUR_HOSTS="api-tdtest.datadance.ai app-tdtest.datadance.ai" DDC_LOCAL_TEST=1 NEW_DIR="$TD/ddcnew" \
    NGINX_AVAIL="$TD/avail" NGINX_ENABLED="$TD/enabled" NGINX_CONFD="$TD/confd" MAINNET_DIR="$TD/mainnet" bash "$PKG/99-teardown.sh" ${2:-} > "$TD/out" 2>&1 || RC=$?; }
td 0
rmc=$(grep -E '^(rm|network rm)' "$TD/calls" | tr '\n' ';')
[ "$RC" = 0 ] && grep -q '^WARN docker compose down is not possible or failed' "$TD/out" && [ "$rmc" = "rm -f 1111 2222;network rm net1;" ] \
  && grep -q 'ps -aq --filter label=com.docker.compose.project=ddcnew' "$TD/calls" && grep -q 'network ls -q --filter label=com.docker.compose.project=ddcnew' "$TD/calls" \
  && grep -q '^PASS no ddcnew containers left' "$TD/out" && grep -q '^PASS old-stack containers unchanged (1 containers' "$TD/out" \
  && ok "99-teardown.sh, compose down fails -> removes only the ddcnew-labelled containers, then the ddcnew network; the old container untouched" || { cat "$TD/out"; cat "$TD/calls"; bad "teardown fallback (rc=$RC rm calls: $rmc)"; }
[ "$RC" = 0 ] && [ ! -e "$TD/avail/api-tdtest.datadance.ai" ] && [ ! -e "$TD/avail/app-tdtest.datadance.ai" ] && [ ! -e "$TD/enabled/api-tdtest.datadance.ai" ] && [ ! -e "$TD/enabled/app-tdtest.datadance.ai" ] \
  && [ ! -e "$TD/ddcnew/settings.env" ] && grep -q '^settings record .* removed: the next run may choose other hosts' "$TD/out" && grep -q "^settings: API_HOST=api-tdtest.datadance.ai .*(recorded in " "$TD/out" \
  && ok "99-teardown.sh undoes this package's vhosts at the RECORDED non-default hosts, then removes the record" || { cat "$TD/out"; bad "teardown with non-default recorded settings"; }
mkdir -p "$TD/ddcnew/vhost-takeover/20261005-170000-1"; : > "$TD/ddcnew/vhost-takeover/20261005-170000-1/MANIFEST"
tdr=0
for mode in "" --delete-dir; do
  td 0 $mode
  [ "$RC" = 1 ] && grep -q "FAIL refusing: .*vhost-takeover holds the backup of vhosts this package took over and never restored ( 20261005-170000-1). Run ./30-nginx.sh restore first" "$TD/out" \
    && [ -d "$TD/ddcnew" ] && ! grep -qE '^(compose|rm|network)' "$TD/calls" && tdr=$((tdr + 1)) || { tail -3 "$TD/out"; bad "99-teardown.sh ${mode:-without options} with an unrestored backup (rc=$RC)"; }
done
[ "$tdr" = 2 ] && ok "99-teardown.sh, with and without --delete-dir, refuses while a take-over backup was never restored, before it changes anything (no compose, rm or network call): restore first"
rm -rf "$TD/ddcnew/vhost-takeover"
td 1
[ "$RC" = 1 ] && grep -q 'FAIL refusing: container(s) labelled project ddcnew without the ddcnew- name prefix: ddc-backend-ddc-backend-api-1' "$TD/out" && ! grep -qE '^(rm|network rm)' "$TD/calls" \
  && ok "teardown fallback refuses when a ddcnew-labelled container has another name: nothing removed" || { cat "$TD/out"; bad "teardown fallback name check (rc=$RC)"; }

echo; echo "== 12c. a signal right after a take-over removed the other party's entries (TERM to the script; TERM, HUP, INT to its whole process group): bash 3.2 (macOS) and bash 5.1 (ubuntu:jammy)"
# test/helpers/takeover-signals.sh: a group signal also reaches the run_begin wrapper and the log's tee; the rollback must
# still put the entries back exactly and its lines must reach the server-side log.
sig_results() { # <label> <helper output file> <helper exit status>
  local l n=0
  while IFS= read -r l; do
    case "$l" in "PASS "*) ok "${l#PASS }"; n=$((n + 1));; "FAIL "*) bad "${l#FAIL }"; n=$((n + 1));; esac
  done < "$2"
  [ "$n" -ge 4 ] || { cat "$2"; bad "$1: takeover-signals.sh printed $n results, not 4 (exit $3)"; }
}
rc=0; timeout 300 bash "$PKG/test/helpers/takeover-signals.sh" "$PKG" "$T/sig-local" > "$T/sig-local.out" 2>&1 || rc=$?
sig_results "local bash" "$T/sig-local.out" "$rc"
if docker info >/dev/null 2>&1; then
  SIG_IMG="ddcnew-bash5test:$RUN_ID"; mkdir -p "$T/bash5-img"
  printf 'FROM ubuntu:jammy\nRUN export DEBIAN_FRONTEND=noninteractive && apt-get update -qq && apt-get -o Acquire::Retries=8 install -y -qq --no-install-recommends python3 >/dev/null && rm -rf /var/lib/apt/lists/*\n' > "$T/bash5-img/Dockerfile"
  if timeout 600 docker build -q "${LT[@]}" -t "$SIG_IMG" "$T/bash5-img" >/dev/null; then
    rc=0; timeout 300 docker run --rm --init "${LT[@]}" --name "sigtest-$RANDOM-$RUN_ID" --user 1000:1000 -v "$PKG:/pkg:ro" "$SIG_IMG" \
      bash /pkg/test/helpers/takeover-signals.sh /pkg /tmp/sig > "$T/sig-bash5.out" 2>&1 || rc=$?
    sig_results "bash 5.1 (ubuntu:jammy)" "$T/sig-bash5.out" "$rc"
  else bad "could not build $SIG_IMG (ubuntu:jammy with python3)"; fi
else bad "section 12c (bash 5.1) needs Docker Desktop"; fi

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
  env DDC_LOCAL_TEST=1 NEW_DIR="$PP/ddcnew" SRV_DIR="$PP/srv/ddcnew" PARTNER_CRYPT_IMAGE=node:22-alpine DDC_TEST_RUN_ID="$RUN_ID" "$@" \
    bash "$PKG/50-partner-page.sh" "$c" < "$in" > "$PP/out" 2>&1 || RC=$?
}
# ps sampler: every process's arguments AND environment (ps -E: the Mac's processes, the docker CLI included), plus the
# configuration of this run's throwaway container (entrypoint, command, environment, ulimits; found by this run's label,
# so another session's containers are never looked at). Only counts are kept: the samples (which hold other processes'
# environments) never touch the disk.
pp_sampler() { # <counts file> <stop file>
  local snap
  while [ ! -e "$2" ]; do
    snap=$(ps -axwwE -o pid=,command= 2>/dev/null || true
           for id in $(docker ps -q --filter "label=ddcnew-localtest=$RUN_ID" --filter name=ddcnew-partner-crypt- 2>/dev/null || true); do
             docker inspect --format 'CONTAINER {{.Name}} env={{json .Config.Env}} entrypoint={{json .Config.Entrypoint}} cmd={{json .Config.Cmd}} ulimits={{json .HostConfig.Ulimits}}' "$id" 2>/dev/null || true
           done)
    printf 'cli=%s cliu=%s ctr=%s core0=%s secret=%s pw=%s wrong=%s\n' \
      "$(printf '%s\n' "$snap" | grep -c -- "--name ddcnew-partner-crypt-[0-9]*-$RUN_ID " || true)" \
      "$(printf '%s\n' "$snap" | grep -- "--name ddcnew-partner-crypt-[0-9]*-$RUN_ID " | grep -c -- '--ulimit core=0 ' || true)" \
      "$(printf '%s\n' "$snap" | grep -c '^CONTAINER /ddcnew-partner-crypt-' || true)" \
      "$(printf '%s\n' "$snap" | grep '^CONTAINER /ddcnew-partner-crypt-' | grep -c '"Name":"core","Hard":0,"Soft":0' || true)" \
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
ps_sum=$(awk '{ for (i = 1; i <= NF; i++) { split($i, kv, "="); s[kv[1]] += kv[2] } } END { printf "samples=%d cli=%d cliu=%d ctr=%d core0=%d secret=%d pw=%d wrong=%d", NR, s["cli"], s["cliu"], s["ctr"], s["core0"], s["secret"], s["pw"], s["wrong"] }' "$PP/ps-counts")
case "$ps_sum" in
  *" secret=0 pw=0 wrong=0") case "$ps_sum" in *" cli=0 "*) bad "ps sampler never saw the throwaway container's docker run: inconclusive ($ps_sum)";;
                                                *) ok "ps during apply and both verify runs ($ps_sum: arguments and environment of every process; cli = samples showing the throwaway container's docker run, ctr = its configuration): neither the secret nor a password";; esac;;
  *) bad "ps showed the secret or a password ($ps_sum)";;
esac
cl=$(printf '%s' "$ps_sum" | sed -n 's/.* cli=\([0-9]*\) cliu=\([0-9]*\) ctr=\([0-9]*\) core0=\([0-9]*\) .*/\1 \2 \3 \4/p')
c1=0; c2=0; c3=0; c4=0; [ -z "$cl" ] || read -r c1 c2 c3 c4 <<< "$cl"
if [ "$c1" -gt 0 ] && [ "$c1" = "$c2" ] && [ "$c3" = "$c4" ]; then
  ok "every sampled docker run of the throwaway container carried --ulimit core=0 ($c2 of $c1), and every sampled container configuration had the core ulimit 0 ($c4 of $c3)"
else bad "--ulimit core=0 at run time: docker run samples $c2 of $c1, container configurations $c4 of $c3"; fi
grep -q -- '--pids-limit 64 --ulimit core=0 --log-driver none' "$PKG/50-partner-page.sh" && ok "the crypt container is started with --ulimit core=0 (no core file can hold the password or the secret)" || bad "--ulimit core=0 missing from the crypt container"

[ "$rc_right" = 0 ] && [ "$(tail -1 "$PP/verify-right.out")" = match=yes ] && [ "$rc_wrong" = 1 ] && [ "$(tail -1 "$PP/verify-wrong.out")" = match=no ] \
  && ok "verify: match=yes with the password (exit 0); match=no with a wrong one (exit 1)" || bad "verify (right rc=$rc_right, wrong rc=$rc_wrong)"
miss=""
for s in "issuer</span>: <span class=\"s\">\"https://$D_API_HOST\"" "client_id</span>: <span class=\"s\">\"$CID\"" "redirect_uri</span>: <span class=\"s\">\"$REDIR1\"" \
         "<span class=\"val\">$REDIR1</span><span class=\"val\">https://203.0.113.7/pages/oauth/cb2?env=test&amp;v=2</span>" "<span class=\"val\">$INIT</span>" \
         '<span class="val">203.0.113.7</span>' '（北京时间）' "<code>$D_API_HOST</code> 和 <code>$D_APP_HOST</code>"; do
  grep -qF -- "$s" "$PAGE/index.html" || miss="$miss [$s]"
done
[ -z "$miss" ] && ! grep -q '{{[A-Z_]*}}' "$PAGE/index.html" && ! grep -qF '&v=2' "$PAGE/index.html" \
  && ok "index.html: issuer, client_id, both redirect URIs (& escaped), start-login URI, the allowed IP, the two hosts (API_HOST, APP_HOST) and the time filled in; no placeholder left" || bad "index.html values; missing:$miss"
# The password cannot leave by a native submit: no <form>, a field without a name, a box that only the script shows.
pwline=$(grep -E '<input[^>]* id="unlock-pw"' "$PAGE/index.html" || true)
[ -n "$pwline" ] && ! printf '%s' "$pwline" | grep -q 'name=' && ! grep -qi '<form' "$PAGE/index.html" \
  && grep -qF '<div class="unlock" id="unlock" role="group" aria-labelledby="unlock-label" hidden>' "$PAGE/index.html" \
  && grep -qF '<button type="button" id="unlock-btn">' "$PAGE/index.html" && grep -qF 'id="secret-value" translate="no"' "$PAGE/index.html" \
  && ok "index.html: the password field has no name, there is no <form>, the unlock box is hidden until the script shows it, the button is type=button; the secret's element has translate=\"no\"" \
  || bad "index.html unlock markup (field name, form, hidden box, translate)"
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
: > "$PP/empty"; head -c 31 "$PP/pw" > "$PP/pw-short"; { cat "$PP/pw"; printf 'x\n'; } > "$PP/pw-long"; { head -c 31 "$PP/pw"; printf '!\n'; } > "$PP/pw-symbol"
{ cat "$PP/pw"; printf ' \n'; } > "$PP/pw-blank"; { cat "$PP/pw"; printf '\r\n'; } > "$PP/pw-crlf"
refuse "empty stdin" "no page password on stdin" apply "$PP/empty" PARTNER_ALLOWED_IP=203.0.113.7
SHAPE="must be exactly 32 letters and digits"
refuse "a 31-character password" "$SHAPE" apply "$PP/pw-short" PARTNER_ALLOWED_IP=203.0.113.7
refuse "a 33-character password" "$SHAPE" apply "$PP/pw-long" PARTNER_ALLOWED_IP=203.0.113.7
refuse "32 characters with a symbol in them" "$SHAPE" apply "$PP/pw-symbol" PARTNER_ALLOWED_IP=203.0.113.7
refuse "a password with a trailing blank" "$SHAPE" apply "$PP/pw-blank" PARTNER_ALLOWED_IP=203.0.113.7
refuse "a password with a carriage return (CRLF)" "$SHAPE" apply "$PP/pw-crlf" PARTNER_ALLOWED_IP=203.0.113.7
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
# The client id in the env: one the api refuses at boot, and one that is not the recorded REHEARSAL_CLIENT_ID.
inplace() { local f="$1"; shift; sed "$@" "$f" > "$f.tmp" && cat "$f.tmp" > "$f" && rm -f "$f.tmp"; }   # keeps the file's mode
mkdir -p "$PP/cidret" "$PP/cidrec"; cp -Rp "$PP/ddcnew" "$PP/cidret/ddcnew"; cp -Rp "$PP/ddcnew" "$PP/cidrec/ddcnew"; rm -rf "$PP/cidret/ddcnew/logs" "$PP/cidrec/ddcnew/logs"
inplace "$PP/cidret/ddcnew/.env.rehearsal" 's/^SSO_TGE_CLIENT_ID=.*/SSO_TGE_CLIENT_ID="tge-rehearsal"/'
refuse "SSO_TGE_CLIENT_ID=tge-rehearsal in the env (the api refuses it at boot)" "is tge-rehearsal, which the api refuses at boot" apply "$PP/pw.nl" \
  PARTNER_ALLOWED_IP=203.0.113.7 NEW_DIR="$PP/cidret/ddcnew" SRV_DIR="$PP/cidret/srv"
inplace "$PP/cidrec/ddcnew/settings.env" 's/^REHEARSAL_CLIENT_ID=.*/REHEARSAL_CLIENT_ID=lt-other-client/'
refuse "an env whose SSO_TGE_CLIENT_ID is not the recorded REHEARSAL_CLIENT_ID" "is not the recorded REHEARSAL_CLIENT_ID (lt-other-client)" apply "$PP/pw.nl" \
  PARTNER_ALLOWED_IP=203.0.113.7 NEW_DIR="$PP/cidrec/ddcnew" SRV_DIR="$PP/cidrec/srv"
refuse "an image that is not on this host (the script never pulls)" "is not on this host" apply "$PP/pw.nl" PARTNER_ALLOWED_IP=203.0.113.7 PARTNER_CRYPT_IMAGE="ddcnew-absent:x-$RUN_ID"
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
  && [ ! -e "$PP/placeholder/srv/partner-info" ] && [ ! -e "$PP/mismatch/srv/partner-info" ] && [ ! -e "$PP/cidret/srv/partner-info" ] && [ ! -e "$PP/cidrec/srv/partner-info" ] \
  && ok "every refusal left the installed page unchanged and created no other page" || bad "a refusal changed or created page files"

echo "-- status (read-only)"
nl0=$(ls "$PP/ddcnew/logs" | wc -l | tr -d ' ')
pprun status /dev/null; sed 's/^/  /' "$PP/out"
[ "$RC" = 0 ] && grep -qF "$PAGE/secret.json mode $pp_fmode bytes" "$PP/out" && grep -qF "sha256=$(sha_of "$PAGE/secret.json")" "$PP/out" \
  && [ "$(ls "$PP/ddcnew/logs" | wc -l | tr -d ' ')" = "$nl0" ] && ok "status: both files with mode and sha256; read-only (no run log)" || bad "status (rc=$RC)"

echo "-- the page behind nginx:stable (the section 4 render of the app vhost), driven by headless Chromium"
if docker info >/dev/null 2>&1; then
  W="$PP/web"; mkdir -p "$W/sites"; cp "$NG/$D_APP_HOST" "$W/sites/"
  printf 'events {}\nhttp {\n  include /etc/nginx/mime.types;\n  include /etc/nginx/sites/*;\n}\n' > "$W/nginx.conf"
  WC="partnerweb-$RANDOM-$RUN_ID"
  if WCID=$(docker run -d "${LT[@]}" --name "$WC" -p 127.0.0.1::80 -v "$W/nginx.conf:/etc/nginx/nginx.conf:ro" -v "$W/sites:/etc/nginx/sites:ro" \
       -v "$PAGE:/srv/ddcnew/partner-info:ro" nginx:stable); then
    WPORT=$(docker port "$WCID" 80/tcp | head -1 | sed 's/.*://'); URL="http://127.0.0.1:$WPORT/partner-info/"
    end=$(( $(date +%s) + 30 )); while [ "$(date +%s)" -lt "$end" ]; do curl -s -o /dev/null "$URL" && break; sleep 0.25; done
    curl -s -D "$W/h-page" -o "$W/page.html" "$URL" || true; curl -s -D "$W/h-json" -o "$W/secret.json" "${URL}secret.json" || true
    miss=""
    for h in 'Cache-Control: no-store' 'X-Robots-Tag: noindex, nofollow' 'Referrer-Policy: no-referrer' 'X-Frame-Options: DENY' 'X-Content-Type-Options: nosniff' "Content-Security-Policy: $CSP"; do
      grep -qiF -- "$h" "$W/h-page" && grep -qiF -- "$h" "$W/h-json" || miss="$miss [$h]"
    done
    head -1 "$W/h-page" | grep -q ' 200' && grep -qi '^Content-Type: text/html' "$W/h-page" && grep -qi '^Content-Type: application/json' "$W/h-json" \
      && cmp -s "$W/page.html" "$PAGE/index.html" && cmp -s "$W/secret.json" "$PAGE/secret.json" && [ -z "$miss" ] \
      && ok "nginx:stable with the rendered app vhost serves both files unchanged (text/html, application/json), each with no-store, noindex, no-referrer, DENY, nosniff and the CSP (form-action 'none', base-uri 'none', no Google Fonts)" \
      || { sed 's/^/    /' "$W/h-page"; bad "nginx serving; missing headers:$miss"; }
    # status: what the local nginx serves, compared with the files (NGINX_LOCAL_URL points the check at this container)
    nl0=$(ls "$PP/ddcnew/logs" | wc -l | tr -d ' ')
    pprun status /dev/null NGINX_LOCAL_URL="http://127.0.0.1:$WPORT"; sed 's/^/  /' "$PP/out" | grep 'local nginx' || true
    [ "$RC" = 0 ] && grep -q '^PASS local nginx: /partner-info/ -> 200, served body = index.html' "$PP/out" \
      && grep -q '^PASS local nginx: /partner-info/secret.json -> 200, served body = secret.json' "$PP/out" && [ "$(ls "$PP/ddcnew/logs" | wc -l | tr -d ' ')" = "$nl0" ] \
      && ok "status: the sha256 of each served body equals its file's (read-only, no run log)" || bad "status served-body comparison (rc=$RC)"
    mkdir -p "$PP/other/partner-info"; cp -p "$PAGE/index.html" "$PP/other/partner-info/"; printf '{"v":1}\n' > "$PP/other/partner-info/secret.json"
    pprun status /dev/null NGINX_LOCAL_URL="http://127.0.0.1:$WPORT" SRV_DIR="$PP/other"
    [ "$RC" = 0 ] && grep -q '^PASS local nginx: /partner-info/ -> 200, served body = index.html' "$PP/out" \
      && grep -q '^WARN local nginx: /partner-info/secret.json -> 200, served body sha256 .* is not the sha256 of ' "$PP/out" \
      && ok "status: a file that differs from what nginx serves is named (WARN), the matching one still passes" || { sed 's/^/    /' "$PP/out"; bad "status mismatch case (rc=$RC)"; }
    PWM="$T/playwright"
    if npm install --prefix "$PWM" --no-audit --no-fund --no-save --prefer-offline --loglevel=error "playwright-core@$PW_VERSION" > "$PP/npm.out" 2>&1; then
      printf '{"issuer":"https://%s","client_id":"%s","redirects":["%s","%s"],"initiate":"%s","ips":["203.0.113.7"]}\n' \
        "$D_API_HOST" "$CID" "$REDIR1" "$REDIR2" "$INIT" > "$PP/expect.json"
      if NODE_PATH="$PWM/node_modules" timeout 300 node "$PKG/test/helpers/partner-browser.js" "$URL" "$SECF" "$PP/pw" "$PP/pw-wrong" "$PP/expect.json" "$PP/shots" > "$PP/browser.out" 2>&1; then
        sed 's/^/  /' "$PP/browser.out"; ok "headless Chromium: a wrong password shows the error, the right one reveals exactly the dummy secret; copy, hide; no other origin; without JavaScript no field and no request with the password (screenshots: $PP/shots)"
      else sed 's/^/  /' "$PP/browser.out"; bad "headless Chromium test"; fi
      [ "$(leak_count "$SECF" "$PP/browser.out")$(leak_count "$PP/pw" "$PP/browser.out")" = 00 ] && ok "the browser test printed neither the secret nor a password" || bad "the browser test output carries a secret"
    else tail -5 "$PP/npm.out"; bad "could not install playwright-core@$PW_VERSION (npm)"; fi
    docker rm -f "$WCID" > /dev/null 2>&1 || true   # by the id this run got back from docker run
  else bad "could not start the nginx container $WC"; fi
else bad "section 14 (nginx + browser) needs Docker Desktop"; fi

echo "-- remove"
pprun remove /dev/null; sed 's/^/  /' "$PP/out" | grep -vE '^  (run|lock|old-stack)' || true
[ "$RC" = 0 ] && [ ! -e "$PAGE" ] && [ ! -e "$PP/srv/ddcnew" ] && grep -q '^PASS partner info page removed' "$PP/out" \
  && ok "remove: the page directory and the then-empty /srv/ddcnew are gone; old stack unchanged" || bad "remove (rc=$RC)"
pprun remove /dev/null
[ "$RC" = 0 ] && grep -q 'does not exist' "$PP/out" && ok "remove again: nothing to do" || bad "second remove (rc=$RC)"
left=$(docker ps -aq --filter "label=ddcnew-localtest=$RUN_ID" --filter name=ddcnew-partner-crypt- | grep -c . || true)
[ "$left" = 0 ] && ok "no throwaway crypt container of this run left (docker run --rm; counted by this run's label)" || bad "$left ddcnew-partner-crypt-* container(s) of this run left"

# ---------------------------------------------------------------------------
cleanup_run

echo; echo "== summary: fails=$fails"
[ "$fails" = 0 ]
