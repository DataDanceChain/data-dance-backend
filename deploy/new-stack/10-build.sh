#!/usr/bin/env bash
# 10-build.sh <backend-sha> <frontend-sha> --overlays-reconciled | --infra-only
# Build the new stack's two images ON the server (no image registry is used, so no registry credentials are needed)
# and prepare the runtime files the backend needs.
#
# CHANGES ON THE SERVER
#   /root/ddcnew/src/backend-<sha12>/     clean clone of the PUBLIC backend repo at the pinned commit (git fetch by sha)
#   /root/ddcnew/src/frontend-<sha12>/    the uploaded git-archive tarball of the PRIVATE frontend repo, unpacked
#                                         (tarball uploaded beforehand by `remote.sh upload-web`; no credentials here)
#   /root/ddcnew/src/frontend-current     symlink to the above (20-env.sh reads .env.tge from it)
#   images ddcnew/backend:<sha12> (ddcnew/backend:<sha12>-infra with --infra-only) and ddcnew/web:tge-<sha12>
#                                         (+ the build cache they leave)
#   /root/ddcnew/keys_fixed/              dir 700, files 400: a read-only COPY of wwdr.pem (Apple's public WWDR
#                                         intermediate certificate), a THROWAWAY pass signer (signerKey.pem + a
#                                         self-signed signerCert.pem, generated here) and a THROWAWAY apn_key.p8.
#                                         The production signerKey.pem (the PRIVATE key that signs Apple Wallet passes
#                                         as DataDance) and apn_key.p8 are never copied into the rehearsal: pass
#                                         creation fails or yields a pass Wallet rejects, and Apple rejects every push.
#                                         Boot needs neither (passController reads the signer at request time; the
#                                         apn.Provider only needs a valid key file). The cutover copies the production
#                                         files in under its own approval (APPROVAL item L).
#   /root/ddcnew/assets/campaigns|passes/ COPIES of /root/ddc-backend/campaign-covers and /root/ddc-backend/passes
#   /root/ddcnew/.env                     compose interpolation only: API_IMAGE, WEB_IMAGE tags and INFRA_ONLY=0|1 (no secrets)
#   /root/ddcnew/settings.env             the hosts and ports (common.sh settings), if no earlier script recorded them
#   /root/ddcnew/.lock, /root/ddcnew/logs/<ts>-10-build-<pid>.log (600) and logs/build-*.log: run lock and output copies
#   The old directories are only read (cp/rsync source); nothing under /root/ddc-backend is written.
# UNDO
#   docker image rm ddcnew/backend:<sha12> ddcnew/web:tge-<sha12>; rm -rf /root/ddcnew/src /root/ddcnew/keys_fixed /root/ddcnew/assets
#   (or ./99-teardown.sh --delete-dir --remove-images). Build cache: docker builder prune -f.
#
# GATE: exactly one of
#   --overlays-reconciled  The live backend runs overlay files and container-layer changes on top of its image
#                          (00-preflight lists them). Code that exists only on the server must be merged into the
#                          backend repo (or consciously dropped) BEFORE the pinned commit is chosen. Pass this flag
#                          only after that audit.
#   --infra-only           Build anyway to prove the infrastructure (empty stack). The backend image is tagged
#                          ddcnew/backend:<sha12>-infra and /root/ddcnew/.env gets INFRA_ONLY=1: 40-up.sh prints a
#                          banner and every data step refuses (refuse_if_infra_only in common.sh).
# WEB BUILD FOR API_HOST: the frontend compiles its tge API in (src/config/environment.ts API_BASE_URLS.tge;
#   https://api-rehearsal.datadance.ai/api since frontend a3ee809). Before any build, the uploaded source must name
#   https://<API_HOST>/api (common.sh fe_api_base_check); after the web build, ddc-build.json must say apiBaseUrl
#   https://<API_HOST>/api (web_marker_check). A frontend commit for another host stops the script.
# MEMORY AND DISK: each docker build runs under a watchdog (common.sh run_build_watched): MemAvailable and the free
#   space on / are polled every 2 s and the build is killed (client, then any BuildKit RUN-step process) if MemAvailable
#   falls below 1000 MB or the free disk below 3 GB; the script then fails. RUN-step processes get oom_score_adj=1000 on
#   every poll; the watchdog prints the docker cgroup driver and warns if it never found a step process to mark.
#   It keeps working when the SSH session ends (SIGPIPE ignored during the build).
set -euo pipefail
HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
. "$HERE/common.sh"
require_server

BE_SHA="${1:-}"; FE_SHA="${2:-}"
[[ "$BE_SHA" =~ ^[0-9a-f]{40}$ ]] || die "backend sha must be a full 40-hex commit id"
[[ "$FE_SHA" =~ ^[0-9a-f]{40}$ ]] || die "frontend sha must be a full 40-hex commit id"
shift 2
RECONCILED=0; INFRA_ONLY=0
for a in "$@"; do
  case "$a" in
    --overlays-reconciled) RECONCILED=1;;
    --infra-only) INFRA_ONLY=1;;
    *) die "unknown argument '$a' (expected --overlays-reconciled or --infra-only)";;
  esac
done
[ "$RECONCILED$INFRA_ONLY" != 11 ] || die "--overlays-reconciled and --infra-only together is an error: pick one"
[ "$RECONCILED$INFRA_ONLY" != 00 ] || die "refusing to build: reconcile the production overlays first (see header) and pass --overlays-reconciled, or pass --infra-only for an image that must never see production data"
BE12=${BE_SHA:0:12}; FE12=${FE_SHA:0:12}
BE_REPO=https://github.com/DataDanceChain/data-dance-backend.git
if [ "$INFRA_ONLY" = 1 ]; then API_IMAGE="ddcnew/backend:$BE12-infra"; else API_IMAGE="ddcnew/backend:$BE12"; fi
WEB_IMAGE="ddcnew/web:tge-$FE12"
SRC="$NEW_DIR/src"; LOGS="$NEW_DIR/logs"
FE_TGZ="$SRC/ddc-frontend-$FE_SHA.tar.gz"
if ddc_local_test && [ "${DDC_ARGS_ONLY:-0}" = 1 ]; then say "args ok: INFRA_ONLY=$INFRA_ONLY API_IMAGE=$API_IMAGE WEB_IMAGE=$WEB_IMAGE"; exit 0; fi

for p in "$NEW_DIR" "$SRC" "$LOGS" "$NEW_DIR/keys_fixed" "$NEW_DIR/assets" "$NEW_DIR/.env"; do guard_write_path "$p"; done
run_begin 10-build "$BE_SHA" "$FE_SHA" "$@"
settings_say
[ "$INFRA_ONLY" = 0 ] || say "!!!!! $INFRA_ONLY_BANNER"
old_snapshot_begin
install -d -m 700 "$NEW_DIR" "$SRC" "$LOGS"
settings_record
# The frontend tarball first: a web build for another API host would only fail after the backend build (30 min).
[ -f "$FE_TGZ" ] && [ -f "$FE_TGZ.sha256" ] || die "upload first: remote.sh upload-web $FE_SHA (expects $FE_TGZ and .sha256)"
[ "$(sha256sum < "$FE_TGZ" | cut -c1-64)" = "$(cut -c1-64 "$FE_TGZ.sha256")" ] || die "tarball sha256 mismatch"
fe_api_base_check "$FE_TGZ"

check_resources() {
  local mem disk; mem=$(mem_avail_mb); disk=$(disk_avail_gb)
  say "mem_avail_mb=$mem disk_avail_gb=$disk"
  [ -n "$mem" ] && [ "$mem" -ge 3000 ] || die "MemAvailable ${mem:-unreadable}MB < 3000MB (no swap on this host): not building now"
  [ "$disk" -ge "${1:-6}" ] || die "disk avail ${disk}G < ${1:-6}G: run p2-disk.sh apply / expand the disk first"
}

# ---------------------------------------------------------------------------
step "1. backend source: clean clone of $BE_REPO at $BE_SHA"
BE_DIR="$SRC/backend-$BE12"
if [ -d "$BE_DIR/.git" ] && [ "$(git -C "$BE_DIR" rev-parse HEAD)" = "$BE_SHA" ] && [ -z "$(git -C "$BE_DIR" status --porcelain --ignored)" ]; then
  say "reusing clean checkout $BE_DIR"
else
  rm -rf "$BE_DIR"; mkdir -p "$BE_DIR"
  git -C "$BE_DIR" init -q
  git -C "$BE_DIR" fetch -q --depth 1 "$BE_REPO" "$BE_SHA"
  git -C "$BE_DIR" -c advice.detachedHead=false checkout -q FETCH_HEAD
fi
[ "$(git -C "$BE_DIR" rev-parse HEAD)" = "$BE_SHA" ] || die "checkout is not at $BE_SHA"
[ -z "$(git -C "$BE_DIR" status --porcelain --ignored)" ] || die "checkout is not clean"
pass "backend HEAD=$BE12 \"$(git -C "$BE_DIR" log -1 --format=%s | cut -c1-80)\""
[ -f "$BE_DIR/.dockerignore" ] && grep -qx '\*\*/.env' "$BE_DIR/.dockerignore" || die ".dockerignore with **/.env missing: PR #25 is not in this commit"
[ -f "$BE_DIR/scripts/mainnetSwitch.js" ] || die "scripts/mainnetSwitch.js missing: PR #27 is not in this commit"
grep -q 'CHAIN_SIGNER_PRIVATE_KEY' "$BE_DIR/env.example" && say "PR #19 (env-config) present" || warn "PR #19 (env-config) not in this commit"
n=$(find "$BE_DIR" -path "$BE_DIR/.git" -prune -o -name '.env*' -print | wc -l); [ "$n" = 0 ] || die "$n .env* files in the clone"
pass "PR #25 (.dockerignore) and #27 (mainnetSwitch.js) present; no .env* in the clone"

# ---------------------------------------------------------------------------
step "2. build $API_IMAGE"
check_resources 12
t0=$(date +%s)
if ! run_build_watched "$LOGS/build-backend-$BE12.log" --label "org.opencontainers.image.revision=$BE_SHA" --label "ai.datadance.infra-only=$INFRA_ONLY" -t "$API_IMAGE" "$BE_DIR"; then
  tail -25 "$LOGS/build-backend-$BE12.log"; die "backend build failed (log: $LOGS/build-backend-$BE12.log)"
fi
pass "backend image built in $(( $(date +%s)-t0 ))s, size $(docker image ls --format '{{.Size}}' "$API_IMAGE")"
n=$(docker run --rm --network none --entrypoint sh "$API_IMAGE" -c 'find /app -path /app/node_modules -prune -o -name ".env*" -print | wc -l' | tr -dc '0-9')
[ "$n" = 0 ] && pass "no .env* file inside the image (count=0)" || die "$n .env* files inside $API_IMAGE"
docker run --rm --network none --entrypoint sh "$API_IMAGE" -c 'printf "node=%s keys_fixed_in_image=%s\n" "$(node -v)" "$(ls /app/keys_fixed 2>/dev/null | tr "\n" " ")"'
# The image the old api container runs, by its id (never pulled).
old_img=$(docker inspect --format '{{.Image}}' "$OLD_API_CTR" 2>/dev/null || true)
say "old image node: $(docker run --rm --pull never --network none --entrypoint node "$old_img" -v 2>/dev/null || echo '?')"
docker run --rm --network none --entrypoint sh "$API_IMAGE" -c 'ls /app/prisma/migrations | grep -E "^2026(09|10)" | tail -10 | sed "s/^/migration: /"'

# ---------------------------------------------------------------------------
step "3. runtime files: wwdr copy, throwaway pass signer, throwaway APNs key"
install -d -m 700 "$NEW_DIR/keys_fixed"
# wwdr.pem is Apple's public WWDR intermediate certificate: a read-only copy.
src="$OLD_BACKEND_DIR/keys_fixed/wwdr.pem"; dst="$NEW_DIR/keys_fixed/wwdr.pem"
[ -f "$src" ] || die "missing $src"
if [ ! -f "$dst" ] || ! cmp -s "$src" "$dst"; then [ -f "$dst" ] && chmod 600 "$dst"; cp "$src" "$dst"; fi
chmod 400 "$dst"
[ "$(sha256sum < "$src")" = "$(sha256sum < "$dst")" ] && say "keys_fixed/wwdr.pem copied (public certificate), sha256 match, mode $(stat -c %a "$dst")" || die "keys_fixed/wwdr.pem hash mismatch"
# Pass signer: the production signerKey.pem is a PRIVATE key (signs Apple Wallet passes as DataDance's Pass Type ID)
# and stays out of the rehearsal. src/controllers/passController.js reads signerCert/signerKey only when a pass is
# requested (origin/main 47e6f74, lines 405-416), so a throwaway RSA key with a self-signed certificate keeps the
# boot and the code path intact while no pass signed with the production identity can be produced.
# Regenerated when missing, unreadable, mismatched (cert vs key) or equal to the production files.
rehearsal_pass_signer "$NEW_DIR/keys_fixed" "$OLD_BACKEND_DIR/keys_fixed"
# APNs: src/controllers/passWebServiceController.js builds an apn.Provider when it is loaded, so a missing key file,
# APNS_KEY_ID or APNS_TEAM_ID stops the backend from booting. The rehearsal gets a freshly generated P-256 key
# instead of the production one: the provider starts, and Apple answers 403 InvalidProviderToken to every push.
# The mount covers /app/keys_fixed, so no key file that the image itself carries is used.
APN="$NEW_DIR/keys_fixed/apn_key.p8"; PROD_APN="$OLD_BACKEND_DIR/keys_fixed/apn_key.p8"
[ -f "$PROD_APN" ] || die "missing $PROD_APN"
if [ ! -f "$APN" ] || cmp -s "$APN" "$PROD_APN" || ! openssl pkey -in "$APN" -noout 2>/dev/null; then
  if [ -f "$APN" ]; then chmod 600 "$APN"; fi
  rm -f "$APN.tmp"
  ( umask 077; openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$APN.tmp" 2>/dev/null ) \
    || { rm -f "$APN.tmp"; die "openssl genpkey could not generate the throwaway APNs key (keys_fixed/apn_key.p8 left as it was)"; }
  openssl pkey -in "$APN.tmp" -noout 2>/dev/null || { rm -f "$APN.tmp"; die "the generated APNs key does not parse"; }
  mv -f "$APN.tmp" "$APN" || die "could not install the generated APNs key"
  say "keys_fixed/apn_key.p8: generated a throwaway P-256 key"
fi
chmod 400 "$APN"
[ "$(sha256sum < "$APN")" != "$(sha256sum < "$PROD_APN")" ] && pass "keys_fixed/apn_key.p8 is a throwaway key (sha256 differs from production), mode $(stat -c %a "$APN")" || die "apn_key.p8 equals the production key"
install -d -m 755 "$NEW_DIR/assets" "$NEW_DIR/assets/campaigns" "$NEW_DIR/assets/passes"
rsync -a "$OLD_BACKEND_DIR/campaign-covers/" "$NEW_DIR/assets/campaigns/"
rsync -a "$OLD_BACKEND_DIR/passes/" "$NEW_DIR/assets/passes/"
for pair in "campaign-covers:assets/campaigns" "passes:assets/passes"; do
  a=$(find "$OLD_BACKEND_DIR/${pair%%:*}" -type f | wc -l); b=$(find "$NEW_DIR/${pair#*:}" -type f | wc -l)
  [ "$b" -ge "$a" ] && pass "${pair%%:*}: old=$a new=$b files" || die "${pair%%:*}: copy incomplete ($b < $a)"
done

# ---------------------------------------------------------------------------
step "4. frontend source: uploaded git-archive tarball of $FE_SHA"
[ -f "$FE_TGZ" ] && [ -f "$FE_TGZ.sha256" ] || die "upload first: remote.sh upload-web $FE_SHA (expects $FE_TGZ and .sha256)"
[ "$(sha256sum < "$FE_TGZ" | cut -c1-64)" = "$(cut -c1-64 "$FE_TGZ.sha256")" ] || die "tarball sha256 mismatch"
tid=$(zcat "$FE_TGZ" | git get-tar-commit-id 2>/dev/null || true)
[ "$tid" = "$FE_SHA" ] || die "tarball commit id is '$tid', expected $FE_SHA"
FE_DIR="$SRC/frontend-$FE12"
rm -rf "$FE_DIR"; mkdir -p "$FE_DIR"; tar -xzf "$FE_TGZ" -C "$FE_DIR"
ln -sfn "frontend-$FE12" "$SRC/frontend-current"
[ -f "$FE_DIR/.env.tge" ] || die ".env.tge missing: frontend PR #18 is not in this commit"
grep -q 'ARG VITE_MODE' "$FE_DIR/Dockerfile" && grep -q 'ARG VITE_API_ENV' "$FE_DIR/Dockerfile" || die "Dockerfile lacks the VITE_MODE / VITE_API_ENV build args"
pass "frontend tarball sha256 ok, commit id $FE12, .env.tge and build args present"

step "5. build $WEB_IMAGE (VITE_MODE=tge, VITE_API_ENV=tge)"
check_resources 7
t0=$(date +%s)
if ! run_build_watched "$LOGS/build-web-$FE12.log" --build-arg VITE_MODE=tge --build-arg VITE_API_ENV=tge --label "org.opencontainers.image.revision=$FE_SHA" \
      -t "$WEB_IMAGE" "$FE_DIR"; then
  tail -25 "$LOGS/build-web-$FE12.log"; die "web build failed (log: $LOGS/build-web-$FE12.log)"
fi
pass "web image built in $(( $(date +%s)-t0 ))s, size $(docker image ls --format '{{.Size}}' "$WEB_IMAGE")"
docker run --rm --network none --entrypoint cat "$WEB_IMAGE" /var/www/ddc-build.json | web_marker_check || die "build marker check failed (the web image must call https://$API_HOST/api)"
pass "ddc-build.json: tge / tge / https://$API_HOST/api / sapphire_mainnet / BBpkxUTUr / 44508"
n=$(docker run --rm --network none --entrypoint sh "$WEB_IMAGE" -c 'grep -rl "BGiGcxrX" /var/www 2>/dev/null | wc -l' | tr -dc '0-9')
[ "$n" = 0 ] && pass "no devnet client id (BGiGcxrX...) anywhere in /var/www" || die "$n files in the tge bundle carry the devnet client id"

# ---------------------------------------------------------------------------
step "6. image tags for compose"
umask 077
printf 'API_IMAGE=%s\nWEB_IMAGE=%s\nINFRA_ONLY=%s\n' "$API_IMAGE" "$WEB_IMAGE" "$INFRA_ONLY" > "$NEW_DIR/.env"
say "$NEW_DIR/.env: API_IMAGE=$API_IMAGE WEB_IMAGE=$WEB_IMAGE INFRA_ONLY=$INFRA_ONLY"
[ "$INFRA_ONLY" = 0 ] || say "!!!!! $INFRA_ONLY_BANNER"
df -h / | tail -1; docker system df --format '{{.Type}} {{.Size}} {{.Reclaimable}}' | grep -E 'Images|Build'
say "optional: docker builder prune -f   (frees the build cache these builds left; images stay)"
old_snapshot_assert
