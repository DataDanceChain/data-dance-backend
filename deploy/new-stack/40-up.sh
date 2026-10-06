#!/usr/bin/env bash
# 40-up.sh - start the new stack on an EMPTY rehearsal database and check it end to end (runbook 4.1 step 8,
# 4.2 step 2-3 without the data). Copying production data in is a later, separate approval.
#
# CHANGES ON THE SERVER
#   /root/ddcnew/compose.yaml   installed from this package (a differing previous one kept as compose.yaml.prev), only
#                               after the JWKS pin gate (step 1a) passed
#   /root/ddcnew/.lock, /root/ddcnew/logs/<ts>-40-up-<pid>.log   run lock and server-side copy of the output (common.sh run_begin)
#   /root/ddcnew/.env.api       .env.rehearsal with WEB3AUTH_JWKS_PINNED_THUMBPRINTS replaced by the thumbprints Web3Auth
#                               serves now, computed INSIDE the new image (runbook 5.0: scripts/web3authJwksThumbprints.js,
#                               `docker run --rm` with only the two public JWKS URLs, no env file, no secret). Refuses to
#                               start the api if none of the pins configured in .env.rehearsal is served; a served key
#                               that was never pinned must be confirmed from a second network first
#                               (JWKS_NEW_PINS_VERIFIED=<thumbprint,...>). Previous file kept as .env.api.prev.
#   /root/ddcnew/pgdata/        new Postgres cluster (container ddcnew-db-1, 127.0.0.1:<DB_PORT>)
#   database ddc_rehearsal      created EMPTY in the new cluster, then `prisma migrate deploy` creates the schema
#   containers ddcnew-api-1 (127.0.0.1:<API_PORT>), ddcnew-web-1 (127.0.0.1:<WEB_PORT>), network ddcnew_default,
#   plus short-lived `docker compose run --rm api` containers.
#   /root/ddcnew/settings.env   the hosts and ports (common.sh settings), if no earlier script recorded them
#   Never touches the old containers (Race's ddc-mainnet-* included), their ports or the database ddc (asserted
#   before/after).
# PORTS (settings API_PORT, WEB_PORT, DB_PORT; defaults 10020, 9021, 15434): each must be free or published by this
#   stack's own container (a re-run); anything else listening on it stops the script before a container starts.
# KEYS: refuses to start if keys_fixed/apn_key.p8, signerKey.pem or signerCert.pem equals the production file, and checks
#   that the running api sees the mounted throwaway apn_key.p8 and signerKey.pem.
# OLD APP SWITCHES (backend PR #38): when the image prints the "Old App update answer (426 APP_UPDATE_REQUIRED)" line,
#   count=1, first8=<the old WEB3AUTH_CLIENT_ID's first 8 characters> and LOGIN_MISSING_IDTOKEN_MEANS_OLD_APP=on must be in
#   it, or the script STOPS. 10-build.sh records whether the backend commit contains PR #38's commit (OLD_APP_SWITCHES in
#   /root/ddcnew/.env, an ancestor check); when it does, a missing line STOPS too.
# HOST-HEADER CHECKS (step 7): only when this package's vhosts serve API_HOST and APP_HOST. Before 30-nginx.sh apply has
#   written them (outcome A runs 40-up.sh first, then the take-over), step 7 says it is deferred, and 30-nginx.sh apply
#   runs the same checks (common.sh host_checks) right after its reload.
# MONEY PATH: every field of the "Partner SSO money-path assertions OK" line (nodeEnv, allowedVerifiers=5,
#   issuer=https://<API_HOST>, consentOrigin=https://<APP_HOST>, web3authVerify, legacyFallback, jwksPinMode,
#   jwksPins=<served>, sessionSecretSeparate=true) must match
#   exactly, or the script STOPS (common.sh money_path_fields_check); publicClientRegistration=open is a warning while
#   runbook 5.2 is open. The line is read from the api log since the api container's last start (State.StartedAt), so a
#   re-run that leaves the container as it is still finds it.
# OTHER HOSTS: the production api/app/business/admin hosts and every other host nginx serves (Race's included) must
#   answer with the same status codes at the end as at the start, or the script STOPS (after printing the old-stack
#   integrity check).
# UNDO
#   ./99-teardown.sh            (compose down + vhosts removed; --delete-dir also removes /root/ddcnew)
# Note for the later data step: ddc_rehearsal now holds the migrated EMPTY schema, so the restore must
#   drop and recreate it first (dropdb/createdb ddc_rehearsal, pg_restore, migrate deploy, db_target check), add the
#   ./public:/app/public mount and the runbook 4.1 step-5 seeding, and call refuse_if_infra_only first.
# INFRA_ONLY=1 in /root/ddcnew/.env (10-build.sh --infra-only): a loud banner at start and end; the stack may only
#   prove that the empty infrastructure boots.
set -euo pipefail
HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
. "$HERE/common.sh"
require_server
REHEARSAL_DB="${REHEARSAL_DB:-ddc_rehearsal}"
guard_db_name "$REHEARSAL_DB"
case "$REHEARSAL_DB" in ddc_rehearsal|ddc_rehearsal2) ;; *) die "REHEARSAL_DB must be ddc_rehearsal or ddc_rehearsal2";; esac
for p in "$NEW_DIR/compose.yaml" "$NEW_DIR/.env.api" "$NEW_DIR/.env.api.new" "$NEW_DIR/pgdata"; do guard_write_path "$p"; done
run_begin 40-up "$@"
settings_say
for f in .env .env.rehearsal .env.db keys_fixed/apn_key.p8 keys_fixed/signerKey.pem keys_fixed/signerCert.pem keys_fixed/wwdr.pem assets/passes; do [ -e "$NEW_DIR/$f" ] || die "$NEW_DIR/$f missing (run 10-build.sh and 20-env.sh first)"; done
API_IMAGE=$(env_get_simple API_IMAGE "$NEW_DIR/.env"); INFRA_ONLY=$(infra_only_value)
# Whether the backend commit contains PR #38's old-App line (10-build.sh, an ancestor check of OLD_APP_COMMIT).
OLD_APP_SWITCHES=$(env_get_simple OLD_APP_SWITCHES "$NEW_DIR/.env")
case "$OLD_APP_SWITCHES" in 0|1) ;; *) die "OLD_APP_SWITCHES in $NEW_DIR/.env is '${OLD_APP_SWITCHES}', not 0 or 1: re-run 10-build.sh (it records whether the backend commit contains PR #38)";; esac
case "$API_IMAGE" in
  ddcnew/backend:*-infra) [ "$INFRA_ONLY" = 1 ] || die "$API_IMAGE is an infra-only tag but INFRA_ONLY=${INFRA_ONLY:-unset}";;
  ddcnew/backend:*) [ "$INFRA_ONLY" = 0 ] || die "INFRA_ONLY=${INFRA_ONLY:-unset} does not match $API_IMAGE (expected 0)";;
  *) die "unexpected API_IMAGE $API_IMAGE";;
esac
banner() { [ "$INFRA_ONLY" = 1 ] || return 0; printf '\n%s\n!!!!! %s\n%s\n\n' '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!' "$INFRA_ONLY_BANNER" '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!'; }
banner
# No production private key in the rehearsal's key mount (10-build.sh writes throwaway ones).
for k in apn_key.p8 signerKey.pem signerCert.pem; do
  [ "$(sha256 < "$NEW_DIR/keys_fixed/$k")" != "$(sha256 < "$OLD_BACKEND_DIR/keys_fixed/$k")" ] || die "keys_fixed/$k is the production file: the rehearsal must use the throwaway one from 10-build.sh (re-run 10-build.sh)"
done
pass_signer_ok "$NEW_DIR/keys_fixed/signerKey.pem" "$NEW_DIR/keys_fixed/signerCert.pem" "$OLD_BACKEND_DIR/keys_fixed/signerKey.pem" "$OLD_BACKEND_DIR/keys_fixed/signerCert.pem" \
  && pass "keys_fixed: apn_key.p8, signerKey.pem and signerCert.pem differ from production (throwaway pass signer: cert matches key)" || die "keys_fixed pass signer is not a valid throwaway pair"
old_snapshot_begin
OTHER_HOSTS=(); while IFS= read -r h; do OTHER_HOSTS+=("$h"); done < <(other_hosts "$API_HOST" "$APP_HOST")
OLD_BEFORE=$(host_codes "${OTHER_HOSTS[@]}"); say "other hosts before: $OLD_BEFORE"

install_copy() { # src dst
  if [ -f "$2" ] && ! cmp -s "$1" "$2"; then cp -p "$2" "$2.prev"; fi
  cp "$1" "$2"
}

step "1a. Web3Auth JWKS pins, computed inside $API_IMAGE (runbook 5.0); nothing is installed before this gate passes"
url_ok() { [ -z "$1" ] || [[ "$1" =~ ^https://[A-Za-z0-9.-]+(/[A-Za-z0-9._~/-]*)?$ ]]; }
JW=$(env_get_simple WEB3AUTH_JWKS_URL "$NEW_DIR/.env.rehearsal"); JWX=$(env_get_simple WEB3AUTH_EXTERNAL_JWKS_URL "$NEW_DIR/.env.rehearsal")
url_ok "$JW" && url_ok "$JWX" || die "WEB3AUTH_JWKS_URL / WEB3AUTH_EXTERNAL_JWKS_URL are not plain https URLs"
say "jwks urls: ${JW:-<default>} ${JWX:-<default>} (blank = the script's default, same as the server)"
jout=$(docker run --rm --pull never --name "ddcnew-jwks-pins-$$" -e WEB3AUTH_JWKS_URL="$JW" -e WEB3AUTH_EXTERNAL_JWKS_URL="$JWX" \
        --entrypoint node "$API_IMAGE" scripts/web3authJwksThumbprints.js 2>&1) || { printf '%s\n' "$jout" | grep -vE 'thumbprint=' | tail -5; die "web3authJwksThumbprints.js failed: a JWKS could not be read, so the pins cannot be computed (not starting the api)"; }
configured=$(env_get_simple WEB3AUTH_JWKS_PINNED_THUMBPRINTS "$NEW_DIR/.env.rehearsal")
jwks_pins_decide "$jout" "$configured" "${JWKS_NEW_PINS_VERIFIED:-}"   # sets JWKS_SERVED and JWKS_PINS, or dies
served="$JWKS_SERVED"; PINS="$JWKS_PINS"
cnt() { printf '%s\n' "$1" | grep -c . || true; }

step "1b. compose file and the api env (the pin gate passed)"
settings_record
install_copy "$HERE/compose.yaml" "$NEW_DIR/compose.yaml"
umask 077
# The temporary file never outlives the script, also when a check below stops it.
trap 'rm -f "$NEW_DIR/.env.api.new"' EXIT
grep -vE '^[[:space:]]*(export[[:space:]]+)?WEB3AUTH_JWKS_PINNED_THUMBPRINTS[[:space:]]*=' "$NEW_DIR/.env.rehearsal" > "$NEW_DIR/.env.api.new" || true
printf '\n# 40-up.sh: Web3Auth JWKS pins computed in %s (runbook 5.0)\nWEB3AUTH_JWKS_PINNED_THUMBPRINTS="%s"\n' "$API_IMAGE" "$PINS" >> "$NEW_DIR/.env.api.new"
chmod 600 "$NEW_DIR/.env.api.new"
[ "$(env_get_simple WEB3AUTH_JWKS_PINNED_THUMBPRINTS "$NEW_DIR/.env.api.new")" = "$PINS" ] || die "pins were not written correctly"
[ "$(grep -cE '^[[:space:]]*(export[[:space:]]+)?WEB3AUTH_JWKS_PINNED_THUMBPRINTS[[:space:]]*=' "$NEW_DIR/.env.api.new")" = 1 ] || die "more than one pins line in .env.api"
install_copy "$NEW_DIR/.env.api.new" "$NEW_DIR/.env.api"; rm -f "$NEW_DIR/.env.api.new"; trap - EXIT; chmod 600 "$NEW_DIR/.env.api"
[ "$(sed '/WEB3AUTH_JWKS_PINNED_THUMBPRINTS/d; /^# 40-up.sh .*JWKS pins/d' "$NEW_DIR/.env.api" | grep -v '^$' | sha256)" = "$(sed '/WEB3AUTH_JWKS_PINNED_THUMBPRINTS/d' "$NEW_DIR/.env.rehearsal" | grep -v '^$' | sha256)" ] \
  && pass ".env.api = .env.rehearsal except WEB3AUTH_JWKS_PINNED_THUMBPRINTS ($(cnt "$served") pins), mode $(stat -c %a "$NEW_DIR/.env.api")" || die ".env.api differs from .env.rehearsal beyond the pins line"
dc config -q || die "compose config invalid"
ports=$(dc config --format json | python3 -c '
import json, sys
c = json.load(sys.stdin)
print(" ".join(sorted("%s:%s" % (p.get("host_ip"), p.get("published")) for s in c["services"].values() for p in s.get("ports", []))))
bad = [v["source"] for s in c["services"].values() for v in s.get("volumes", []) if not v["source"].startswith("/root/ddcnew/")]
sys.exit("FAIL bind source outside /root/ddcnew: %s" % bad if bad else 0)')
want_ports=$(printf '127.0.0.1:%s\n' "$API_PORT" "$DB_PORT" "$WEB_PORT" | LC_ALL=C sort | tr '\n' ' ' | sed 's/ $//')
[ "$ports" = "$want_ports" ] && pass "published ports: $ports (API_PORT, DB_PORT, WEB_PORT); every mount under /root/ddcnew" || die "unexpected ports: $ports (expected $want_ports)"
port_check "$API_PORT" api API_PORT; port_check "$DB_PORT" db DB_PORT; port_check "$WEB_PORT" web WEB_PORT
pass "ports $API_PORT, $DB_PORT and $WEB_PORT are free or published by this stack's own containers"
say "images: $(grep -E '^(API|WEB)_IMAGE=' "$NEW_DIR/.env" | tr '\n' ' ')"

step "2. database container"
install -d -m 700 "$NEW_DIR/pgdata"
dc up -d db
for _ in $(seq 1 60); do [ "$(docker inspect --format '{{.State.Health.Status}}' ddcnew-db-1 2>/dev/null)" = healthy ] && break; sleep 2; done
[ "$(docker inspect --format '{{.State.Health.Status}}' ddcnew-db-1)" = healthy ] || die "ddcnew-db-1 not healthy"
pass "ddcnew-db-1 healthy, $(dc exec -T db postgres --version)"
psqlq() { dc exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "$0"' "$1"; }
if [ "$(psqlq "SELECT 1 FROM pg_database WHERE datname='$REHEARSAL_DB'")" = 1 ]; then say "$REHEARSAL_DB exists"
else dc exec -T db sh -c 'createdb -U "$POSTGRES_USER" "$0"' "$REHEARSAL_DB"; pass "created $REHEARSAL_DB"; fi
say "databases in the NEW cluster: $(psqlq "SELECT string_agg(datname, ',' ORDER BY datname) FROM pg_database WHERE NOT datistemplate")"

step "3. db_target check (must pass before any migration)"
DBT=$(dc run --rm --no-deps -T api node -e 'require("dotenv").config(); const u=new URL(process.env.DATABASE_URL); console.log("db_target="+u.hostname+":"+(u.port||"5432")+u.pathname+" schema="+(u.searchParams.get("schema")||"public"))' 2>/dev/null | grep '^db_target=' || true)
say "$DBT"
[ "$DBT" = "db_target=db:5432/$REHEARSAL_DB schema=public" ] && pass "api points at the new stack's $REHEARSAL_DB" || die "db_target is not db:5432/$REHEARSAL_DB - STOP, fix .env.rehearsal"

step "4. prisma migrate status / deploy on the empty database"
tables=$(dc exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$0" -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema='"'"'public'"'"'"' "$REHEARSAL_DB")
say "tables before: $tables"
dc run --rm --no-deps -T api npx prisma migrate status 2>&1 | grep -vE '^\s*$' | grep -viE 'postgres(ql)?://' | tail -8 || true
dc run --rm --no-deps -T api npx prisma migrate deploy 2>&1 | grep -viE 'postgres(ql)?://' | grep -E 'migrations? (found|applied)|All migrations|Error|error' | tail -5 || true
st=$(dc run --rm --no-deps -T api npx prisma migrate status 2>&1 || true)
printf '%s\n' "$st" | grep -qi 'Database schema is up to date' && pass "migrate status: Database schema is up to date ($(printf '%s\n' "$st" | grep -oE '[0-9]+ migrations? found' | head -1))" || die "migrate status is not up to date"
say "tables after: $(dc exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$0" -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema='"'"'public'"'"'"' "$REHEARSAL_DB") users=$(dc exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$0" -tAc "SELECT count(*) FROM \"User\""' "$REHEARSAL_DB")"

step "5. start api and web"
dc up -d api web
for _ in $(seq 1 60); do c=$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://127.0.0.1:$API_PORT/partner/tge/me" || true); [ "$c" = 401 ] && break; sleep 2; done
dc ps --format '{{.Name}} {{.Status}} {{.Ports}}'
API_CID=$(dc ps -q api); [ -n "$API_CID" ] || die "the api container is not running"
API_STARTED=$(docker inspect --format '{{.State.StartedAt}}' "$API_CID")
say "api container started at $API_STARTED (log read from there)"
LOG=$(dc logs --no-color --since "$API_STARTED" api 2>&1)
printf '%s\n' "$LOG" | grep -E 'Partner SSO (enabled|disabled)' | tail -1 | sed 's/^[^|]*| //'
line=$(printf '%s\n' "$LOG" | grep 'Partner SSO money-path assertions OK' | tail -1 | sed 's/^[^|]*| //' || true)
[ -n "$line" ] && { say "$line"; pass "startup log has 'Partner SSO money-path assertions OK'"; } || { printf '%s\n' "$LOG" | grep -iE 'error|invalid|refus' | grep -viE 'postgres(ql)?://|secret|password|token' | tail -10; printf '%s\n' "$LOG" | sed 's/^[^|]*| //' | grep -E '^ - (SSO_|WEB3AUTH_|NODE_ENV|PUBLIC_BASE_URL|APP_PUBLIC_URL)' | tail -20; die "no money-path assertion line in the api log"; }
money_path_fields_check "$line" "$(cnt "$served")"   # dies on any missing or different field (APPROVAL section 4, row 10)
old_app_line_check "$LOG" "$(env_get_simple WEB3AUTH_RETIRED_CLIENT_IDS "$NEW_DIR/.env.api" | cut -c1-8)" "$OLD_APP_SWITCHES"

step "6. running api: JWKS pins, APNs key and pass signer"
pinned=$(dc exec -T api node -e 'console.log(String(process.env.WEB3AUTH_JWKS_PINNED_THUMBPRINTS||"").split(",").map(s=>s.trim()).filter(Boolean).join("\n"))' | LC_ALL=C sort -u)
[ "$pinned" = "$served" ] && pass "the running api carries exactly the $(cnt "$served") pins computed in step 1a" || die "the running api's pins differ from the ones written to .env.api"
capn=$(dc exec -T api sh -c 'sha256sum /app/keys_fixed/apn_key.p8' | cut -c1-64)
[ "$capn" = "$(sha256 < "$NEW_DIR/keys_fixed/apn_key.p8")" ] && pass "api sees the throwaway apn_key.p8 from the mount (not a key file baked into the image)" || die "api's /app/keys_fixed/apn_key.p8 is not the mounted throwaway key"
csk=$(dc exec -T api sh -c 'sha256sum /app/keys_fixed/signerKey.pem' | cut -c1-64)
[ "$csk" = "$(sha256 < "$NEW_DIR/keys_fixed/signerKey.pem")" ] && pass "api sees the throwaway signerKey.pem from the mount (not the production pass-signing key)" || die "api's /app/keys_fixed/signerKey.pem is not the mounted throwaway key"

step "7. local checks through host nginx (Host headers $API_HOST and $APP_HOST)"
if vhosts_ours; then
  host_checks
else
  say "DEFERRED: the vhost entries at $API_HOST / $APP_HOST are not this package's yet (sites-available: $(vhost_state avail "$API_HOST") / $(vhost_state avail "$APP_HOST")), so the host nginx does not route these hosts to this stack. 30-nginx.sh apply runs these checks right after it has written them (outcome A: TAKE_OVER_VHOSTS=yes, APPROVAL.md section 9)"
fi

step "8. old stack untouched"
OLD_AFTER=$(host_codes "${OTHER_HOSTS[@]}")
if [ "$OLD_BEFORE" = "$OLD_AFTER" ]; then pass "every other host answers as before ($OLD_AFTER)"; tls_probe_note "$OLD_BEFORE" "$OLD_AFTER"
else
  printf 'FAIL status codes of other hosts changed: before [%s] after [%s]\n' "$OLD_BEFORE" "$OLD_AFTER" >&2
  ( old_snapshot_assert ) || true   # report containers and old files too, then stop
  die "status codes of other hosts changed while 40-up.sh ran — check the old stack now; ./99-teardown.sh stops the new stack if it is the cause"
fi
old_snapshot_assert
docker stats --no-stream --format '{{.Name}} cpu={{.CPUPerc}} mem={{.MemUsage}}' | grep -E '^ddcnew-' || true
say "mem_avail_mb=$(mem_avail_mb) disk_avail_gb=$(disk_avail_gb)"
banner
