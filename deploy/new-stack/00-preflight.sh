#!/usr/bin/env bash
# 00-preflight.sh - READ-ONLY checks before building the new production stack (compose project ddcnew).
# CHANGES ON THE SERVER: nothing. No file is written (not even /tmp), no container is started,
#   nothing is pulled or pruned. Reads: df, /proc/meminfo, ss, docker ps/inspect/system df/info,
#   docker buildx inspect, journalctl --disk-usage, getent, a size query on the old database, the NAMES in backend.env.
# UNDO: nothing to undo.
# Self-contained (no common.sh) so it can be piped to the server: ./remote.sh preflight prepends GIT_APN_SHA=<sha256>
#   (for the apn_key.p8 comparison below; piped without it, that comparison reports "not checked") and the settings
#   API_HOST, APP_HOST, API_PORT, WEB_PORT, DB_PORT (common.sh defaults, or the overrides given to remote.sh preflight).
#   It checks those ports and host names, our vhost entries at those names, and server_name clashes.
# Race's mainnet rehearsal (ddc-mainnet-* containers, /root/ddc-mainnet) is listed and fingerprinted like the old stack,
#   read only.
# Prints names, counts, sizes and PASS/WARN/FAIL only - never a secret value.
set -euo pipefail
API_HOST="${API_HOST:-}"; APP_HOST="${APP_HOST:-}"; API_PORT="${API_PORT:-}"; WEB_PORT="${WEB_PORT:-}"; DB_PORT="${DB_PORT:-}"
# The first line of every vhost file 30-nginx.sh writes: the same string as VHOST_MARKER in common.sh (the local test
# checks that the two copies are identical).
VHOST_MARKER='# ddcnew-vhost: written by deploy/new-stack/30-nginx.sh, which replaces or removes only files that start with this line.'
MAINNET_DIR=/root/ddc-mainnet

fails=0; warns=0
sec()  { printf '\n===== %s =====\n' "$1"; }
pass() { printf 'PASS %s\n' "$*"; }
warn() { printf 'WARN %s\n' "$*"; warns=$((warns+1)); }
fail() { printf 'FAIL %s\n' "$*"; fails=$((fails+1)); }

[ "$(id -u)" = 0 ] || { echo "FAIL run as root"; exit 1; }

sec "host"
date '+%Y-%m-%d %H:%M:%S %Z'; uptime
timedatectl 2>/dev/null | awk -F': ' '/Time zone/ {print "timezone=" $2}' || true
AVAIL_G=$(df -BG --output=avail / | tail -1 | tr -dc '0-9')
SIZE_G=$(df -BG --output=size / | tail -1 | tr -dc '0-9')
MEM_AV=$(awk '/^MemAvailable:/ {print int($2/1024)}' /proc/meminfo)
MEM_TOT=$(awk '/^MemTotal:/ {print int($2/1024)}' /proc/meminfo)
SWAP=$(awk '/^SwapTotal:/ {print int($2/1024)}' /proc/meminfo)
echo "disk_size_gb=$SIZE_G disk_avail_gb=$AVAIL_G mem_total_mb=$MEM_TOT mem_avail_mb=$MEM_AV swap_mb=$SWAP"
[ "$MEM_AV" -ge 3000 ] && pass "memory available ${MEM_AV}MB >= 3000MB" || fail "memory available ${MEM_AV}MB < 3000MB"
if   [ "$AVAIL_G" -ge 20 ]; then pass "disk avail ${AVAIL_G}G >= 20G"
elif [ "$AVAIL_G" -ge 10 ]; then warn "disk avail ${AVAIL_G}G: run p2-disk.sh preview for need_gb before building"
else warn "disk avail ${AVAIL_G}G < 10G: p2-disk.sh apply (and probably a disk expansion) is required before 10-build.sh"; fi

sec "disk layout (input for p2-disk.sh expand-check)"
ROOT_SRC=$(findmnt -n -o SOURCE / || true); RDEV=$(basename "$(readlink -f "$ROOT_SRC")")
PK=$(lsblk -no PKNAME "/dev/$RDEV" 2>/dev/null | head -1 || true)
echo "root_source=$ROOT_SRC fstype=$(findmnt -n -o FSTYPE / || true) disk=/dev/${PK:-?} partition=$(cat "/sys/class/block/$RDEV/partition" 2>/dev/null || echo ?)"
[ -n "$PK" ] && lsblk -b -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINT "/dev/$PK" 2>/dev/null || true
echo "growpart=$(command -v growpart >/dev/null && echo yes || echo no) resize2fs=$(command -v resize2fs >/dev/null && echo yes || echo no)"

sec "docker disk"
docker system df --format '{{.Type}}|{{.TotalCount}}|{{.Active}}|{{.Size}}|{{.Reclaimable}}'
journalctl --disk-usage 2>/dev/null | sed -E 's/.*take up ([^ ]+).*/journal=\1/' || true
docker image ls --format '{{.Repository}}:{{.Tag}}|{{.ID}}|{{.Size}}'

sec "settings and ports (the new stack's must be free, the old stack must hold its own)"
if [ -n "$API_HOST" ] && [ -n "$APP_HOST" ] && [ -n "$API_PORT" ] && [ -n "$WEB_PORT" ] && [ -n "$DB_PORT" ]; then
  echo "settings: API_HOST=$API_HOST APP_HOST=$APP_HOST API_PORT=$API_PORT WEB_PORT=$WEB_PORT DB_PORT=$DB_PORT"
  if [ -f /root/ddcnew/settings.env ]; then
    rec=$(tr '\n' ' ' < /root/ddcnew/settings.env); echo "recorded in /root/ddcnew/settings.env: $rec"
    [ "$rec" = "API_HOST=$API_HOST APP_HOST=$APP_HOST API_PORT=$API_PORT WEB_PORT=$WEB_PORT DB_PORT=$DB_PORT " ] && pass "the recorded settings are these" \
      || warn "the stack was set up with the recorded settings: the write scripts refuse other values until 99-teardown.sh removes the record"
  else echo "no settings recorded yet (/root/ddcnew/settings.env absent)"; fi
  for pp in "API_PORT:$API_PORT:api" "DB_PORT:$DB_PORT:db" "WEB_PORT:$WEB_PORT:web"; do
    n=${pp%%:*}; r=${pp#*:}; p=${r%%:*}; svc=${r#*:}
    if ss -Htln "sport = :$p" | grep -q .; then
      who=$(docker ps --format '{{.Names}} {{.Ports}}' | awk -v p="$p" '{ for (i = 2; i <= NF; i++) if (index($i, ":" p "->") > 0) { print $1; break } }' | tr '\n' ' ')
      if [ "$who" = "ddcnew-$svc-1 " ]; then pass "$n $p: held by this stack's own ddcnew-$svc-1 (a re-run)"
      else fail "$n $p is in use by ${who:-a process that is not a container}: choose another port ($n=<port>)"; fi
    else pass "$n $p free"; fi
  done
else fail "no settings were passed: run it with ./remote.sh preflight (it prepends API_HOST, APP_HOST and the three ports)"; fi
for p in 10000 9000 9001 9002 9003 15432 80; do
  if ss -Htln "sport = :$p" | grep -q .; then echo "old port $p listening"; else warn "old port $p NOT listening"; fi
done

sec "names (containers, compose projects, images, networks)"
n=$(docker ps -a --format '{{.Names}}' | grep -c '^ddcnew' || true)
[ "$n" = 0 ] && pass "no container named ddcnew*" || warn "$n container(s) named ddcnew* already exist: $(docker ps -a --format '{{.Names}}' | grep '^ddcnew' | tr '\n' ' ')"
{ docker compose ls -a --format json 2>/dev/null | grep -o '"Name":"[^"]*"' | tr '\n' ' ' || true; }; echo
docker compose ls -a --format json 2>/dev/null | grep -q '"Name":"ddcnew"' && warn "compose project ddcnew exists" || pass "no compose project ddcnew"
docker image ls --format '{{.Repository}}:{{.Tag}}' | grep -E '^ddcnew/' && warn "ddcnew/* images exist (listed above)" || pass "no ddcnew/* image yet"
docker network ls --format '{{.Name}}' | grep -E '^ddcnew' && warn "ddcnew network exists" || pass "no ddcnew network"

sec "old stack (must stay as it is)"
docker ps -a --format '{{.Names}}|{{.Status}}|{{.Ports}}' | { grep -E '^ddc-' || true; } | { grep -v '^ddc-mainnet-' || true; } | sort
up=$(docker ps --format '{{.Names}}' | { grep -E '^ddc-' || true; } | { grep -vc '^ddc-mainnet-' || true; })
[ "$up" -ge 6 ] && pass "$up old containers running" || fail "only $up old containers running (expected 6)"
docker inspect --format '{{.Name}} restart={{.HostConfig.RestartPolicy.Name}} started={{.State.StartedAt}}' ddc-backend-ddc-backend-api-1 ddc-backend-ddc-backend-db-1 2>/dev/null
DB_BYTES=$(docker exec ddc-backend-ddc-backend-db-1 sh -c 'psql -U "$POSTGRES_USER" -d ddc -tAc "SELECT pg_database_size(current_database())"' 2>/dev/null | tr -dc '0-9' || true)
PGV=$(docker exec ddc-backend-ddc-backend-db-1 sh -c 'psql -U "$POSTGRES_USER" -d ddc -tAc "SHOW server_version"' 2>/dev/null | awk '{print $1}' || true)
echo "old_db=ddc size_bytes=${DB_BYTES:-?} size_gb=$(awk -v b="${DB_BYTES:-0}" 'BEGIN{printf "%.2f", b/1024^3}') server_version=${PGV:-?}"

sec "Race's mainnet rehearsal (read only; the write scripts fingerprint it like the old stack)"
docker ps -a --format '{{.Names}}|{{.Status}}|{{.Ports}}' | { grep -E '^ddc-mainnet-' || true; } | sort
for c in $(docker ps -a --format '{{.Names}}' | { grep -E '^ddc-mainnet-' || true; }); do
  docker inspect --format '{{.Name}} restart={{.HostConfig.RestartPolicy.Name}} started={{.State.StartedAt}}' "$c" 2>/dev/null || true
done
echo "ddc-mainnet-* containers: $(docker ps -a --format '{{.Names}}' | { grep -cE '^ddc-mainnet-' || true; })"
# Directories under /root/ddc-mainnet that a container mounts read-write hold data it writes itself: not fingerprinted.
RW_MOUNTS=$(for id in $(docker ps -aq 2>/dev/null || true); do docker inspect --format '{{range .Mounts}}{{if and (eq .Type "bind") .RW}}{{.Source}}{{"\n"}}{{end}}{{end}}' "$id" 2>/dev/null || true; done \
  | awk -v d="$MAINNET_DIR" '$0 == d || index($0, d "/") == 1' | LC_ALL=C sort -u)
if [ -d "$MAINNET_DIR" ]; then
  echo "$MAINNET_DIR exists; mounted read-write by a container (not fingerprinted): ${RW_MOUNTS:-none}" | tr '\n' ' '; echo
else echo "$MAINNET_DIR absent"; fi

sec "existing new-stack dirs"
for d in /root/ddcnew /root/mainnet-switch /root/backup /root/backup/pg /root/ddcnew/vhost-takeover; do
  if [ -e "$d" ]; then echo "$d exists ($(find "$d" -mindepth 1 -maxdepth 1 | wc -l) entries)"; else echo "$d absent"; fi
done
[ -e /etc/cron.d/ddc-pgdump ] && echo "/etc/cron.d/ddc-pgdump exists" || echo "/etc/cron.d/ddc-pgdump absent"

sec "nginx entries at the rehearsal names, and server_name clashes"
ours_file() { [ -f "$1" ] && [ ! -L "$1" ] && [ "$(head -n 1 -- "$1" 2>/dev/null)" = "$VHOST_MARKER" ]; }
names_in() { sed -e 's/#.*//' -- "$1" 2>/dev/null | tr '\n' ' ' | tr ';{}' '\n\n\n' | awk '{ for (i = 1; i <= NF; i++) if ($i == "server_name") { for (j = i + 1; j <= NF; j++) print tolower($j); break } }' | tr -d '"'; }
ours_entry() { # <path in sites-available or sites-enabled>: written by 30-nginx.sh for one of the two names
  local d b; d=$(dirname -- "$1"); b=$(basename -- "$1")
  case "$b" in "$API_HOST"|"$APP_HOST"|"$API_HOST.new"|"$APP_HOST.new") ;; *) return 1;; esac
  case "$d" in
    /etc/nginx/sites-available) ours_file "$1";;
    /etc/nginx/sites-enabled) [ -L "$1" ] && ours_file "/etc/nginx/sites-available/$b" && [ "$(readlink -f -- "$1")" = "/etc/nginx/sites-available/$b" ];;
    *) return 1;;
  esac
}
if [ -n "$API_HOST" ] && [ -n "$APP_HOST" ]; then
  for h in "$API_HOST" "$APP_HOST"; do
    for f in "/etc/nginx/sites-available/$h" "/etc/nginx/sites-available/$h.new" "/etc/nginx/sites-enabled/$h"; do
      if [ ! -e "$f" ] && [ ! -L "$f" ]; then echo "$f absent"
      elif ours_entry "$f"; then echo "$f written by this package"
      else
        if [ -L "$f" ]; then what="symlink -> $(readlink -- "$f")"; else what="server_name $(names_in "$f" | tr '\n' ' ')proxy_pass $( { grep -oE 'proxy_pass[[:space:]]+[^;]+' "$f" || true; } | awk '{print $2}' | tr '\n' ' ')"; fi
        warn "$f was NOT written by this package ($what): 30-nginx.sh apply refuses it; only after Sloan and Race agree, TAKE_OVER_VHOSTS=yes backs it up and takes it over"
      fi
    done
    for f in /etc/nginx/sites-enabled/* /etc/nginx/conf.d/*.conf; do
      [ -e "$f" ] || continue
      [ "$f" != "/etc/nginx/sites-enabled/$API_HOST" ] && [ "$f" != "/etc/nginx/sites-enabled/$APP_HOST" ] || continue
      if names_in "$f" | grep -qxF -- "$h"; then fail "$f also declares server_name $h: 30-nginx.sh apply refuses until its owner removes or renames it"; fi
    done
  done
else fail "no settings were passed: the vhost names are not checked"; fi

sec "old env file (names only)"
F=/root/ddc-backend/backend.env
if [ -f "$F" ]; then
  pass "$F present ($(stat -c '%a %U %s bytes' "$F"))"
  awk '/^[[:space:]]*(export[[:space:]]+)?[A-Za-z_][A-Za-z0-9_]*[[:space:]]*=/ {n++} END {print "assignment_lines=" n+0}' "$F"
  for k in DATABASE_URL JWT_SECRET WEB3AUTH_CLIENT_ID WEB3AUTH_JWKS_PINNED_THUMBPRINTS SSO_SESSION_SECRET BSC_PAYOUT_PRIVATE_KEY DISBURSEMENT_PAUSED; do
    if grep -qE "^[[:space:]]*(export[[:space:]]+)?${k}[[:space:]]*=" "$F"; then echo "name $k: present"; else echo "name $k: absent"; fi
  done
  echo "SMTP_* names: $(grep -cE '^[[:space:]]*(export[[:space:]]+)?SMTP_' "$F" || true)"
else fail "$F missing"; fi
for d in keys_fixed campaign-covers passes overlays; do
  [ -d "/root/ddc-backend/$d" ] && echo "/root/ddc-backend/$d files=$(find "/root/ddc-backend/$d" -type f | wc -l) kb=$(du -sk "/root/ddc-backend/$d" | cut -f1)" || fail "/root/ddc-backend/$d missing"
done
for k in apn_key.p8 wwdr.pem signerCert.pem signerKey.pem; do
  [ -f "/root/ddc-backend/keys_fixed/$k" ] && echo "keys_fixed/$k present" || fail "keys_fixed/$k missing"
done
# keys_fixed/apn_key.p8 compared with the copy tracked in the backend repository: remote.sh preflight computes that
# copy's sha256 at HEAD of its checkout and prepends GIT_APN_SHA=<sha256>. Only whether the two are identical is
# reported (yes/no); what follows from either answer is in the private runbook.
GIT_APN_SHA="${GIT_APN_SHA:-}"
if [ -f /root/ddc-backend/keys_fixed/apn_key.p8 ]; then
  if [[ "$GIT_APN_SHA" =~ ^[0-9a-f]{64}$ ]]; then
    if [ "$(sha256sum < /root/ddc-backend/keys_fixed/apn_key.p8 | cut -c1-64)" = "$GIT_APN_SHA" ]; then same=yes; else same=no; fi
    echo "keys_fixed/apn_key.p8 identical to the git-tree copy: $same"
  else echo "keys_fixed/apn_key.p8 identical to the git-tree copy: not checked (no git-tree hash passed: run it with ./remote.sh preflight)"; fi
fi

echo "old-stack files the write scripts fingerprint (path, short sha256; common.sh old_files: a symlink counts with its target):"
{ printf '%s\n' /root/ddc-backend/backend.env /root/ddc-backend/docker-compose.yaml /root/ddc/docker-compose.yml
  find /root/ddc-backend/overlays -type f 2>/dev/null | LC_ALL=C sort
  for d in /etc/nginx/sites-available /etc/nginx/sites-enabled; do
    find "$d" -mindepth 1 -maxdepth 1 ! -type d 2>/dev/null | LC_ALL=C sort | while IFS= read -r f; do ours_entry "$f" || printf '%s\n' "$f"; done
  done
  if [ -d "$MAINNET_DIR" ]; then
    find "$MAINNET_DIR" \( -name .git -o -name node_modules \) -prune -o ! -type d -print | LC_ALL=C sort | while IFS= read -r f; do
      skip=0; for m in $RW_MOUNTS; do case "$f/" in "$m"/*) skip=1;; esac; done
      [ "$skip" = 1 ] || printf '%s\n' "$f"
    done
  else printf '%s/\n' "$MAINNET_DIR"; fi
} | while IFS= read -r f; do
  if [ -L "$f" ]; then printf '  %s %s\n' "$( { printf 'symlink %s\n' "$(readlink -- "$f")"; cat -- "$f" 2>/dev/null || true; } | sha256sum | cut -c1-12)" "$f"
  elif [ -f "$f" ]; then printf '  %s %s\n' "$(sha256sum < "$f" | cut -c1-12)" "$f"; else printf '  MISSING %s\n' "$f"; fi
done

sec "production-only code in the old api (input for the overlay reconcile step)"
docker inspect --format '{{range .Mounts}}{{if eq .Type "bind"}}{{.Source}}{{"\n"}}{{end}}{{end}}' ddc-backend-ddc-backend-api-1 | grep -c '/overlays/' | sed 's/^/overlay_file_mounts=/' || true
echo "container-layer files changed under /app/src (docker cp or edits, not in any mount):"
docker diff ddc-backend-ddc-backend-api-1 | awk '$2 ~ /^\/app\/src\/.*\.js$/ {print "  " $1 " " $2}'
echo "container-layer files under /app/public (runtime uploads outside the mounts): $(docker diff ddc-backend-ddc-backend-api-1 | awk '$1!="D" && $2 ~ /^\/app\/public\/.*\.[A-Za-z0-9]+$/' | wc -l)"
docker diff ddc-backend-ddc-backend-api-1 | awk '$1!="D" && $2 ~ /^\/app\/public\/.*\.[A-Za-z0-9]+$/ {n=split($2,a,"/"); d=""; for(i=2;i<n;i++) d=d "/" a[i]; c[d]++} END {for (k in c) print "  " c[k] " " k}'

sec "DNS for the rehearsal hosts (settings API_HOST, APP_HOST)"
for h in ${API_HOST:-} ${APP_HOST:-} api.datadance.ai app.datadance.ai; do
  r=$(getent hosts "$h" | awk '{print $1}' | tr '\n' ' ' || true)
  echo "$h -> ${r:-<no record>}"
done
for h in ${API_HOST:-} ${APP_HOST:-}; do
  getent hosts "$h" >/dev/null && pass "$h resolves" || warn "$h has no DNS record yet (Cloudflare A record needed)"
done

sec "outbound (image builds pull base images and packages)"
chk() { local c; c=$(curl -s -o /dev/null -m 10 -w '%{http_code}' "$1" || true); echo "$c $1"; case "$c" in "$2") pass "$1 reachable";; *) fail "$1 answered $c (expected $2)";; esac; }
chk https://registry-1.docker.io/v2/ 401
chk https://github.com/DataDanceChain/data-dance-backend 200
chk https://registry.npmjs.org/ 200
chk https://registry.yarnpkg.com/ 200
docker image inspect postgres:17 >/dev/null 2>&1 && pass "postgres:17 present locally (no pull needed)" || warn "postgres:17 not present locally"

sec "host tools"
for t in git openssl sha256sum zcat rsync python3 curl ss getent crontab journalctl nginx; do
  command -v "$t" >/dev/null && printf '%s=yes ' "$t" || { printf '%s=NO ' "$t"; fails=$((fails+1)); }
done; echo
docker version --format 'docker={{.Server.Version}}'; docker compose version --short | sed 's/^/compose=/'
# Which cgroup layout the build watchdog's RUN-step selector meets here (common.sh buildkit_step_rows):
# cgroupfs -> /docker/buildkit/<id>, systemd -> /system.slice/system.slice:docker:<id>.
docker info --format 'cgroup_driver={{.CgroupDriver}} cgroup_version={{.CgroupVersion}}' || echo "cgroup_driver=? (docker info failed)"
echo "buildx_driver=$(docker buildx inspect 2>/dev/null | awk '/^Driver:/ {print $2; exit}') (the build watchdog accepts only: docker)"

sec "nginx vhost layout (no file contents)"
ls -1 /etc/nginx/sites-enabled/
grep -c 'map \$http_upgrade \$connection_upgrade' /etc/nginx/sites-available/app.datadance.co | sed 's/^/map_connection_upgrade_in_app_vhost=/' || true
grep -cE "Access-Control-Allow-Origin' +'?https?://" /etc/nginx/sites-available/api.datadance.co | sed 's/^/api_vhost_hardcoded_cors_origins=/' || true
grep -cE "Access-Control-Allow-Origin' +\\\$http_origin" /etc/nginx/sites-available/api.datadance.co | sed 's/^/api_vhost_http_origin_lines=/' || true

sec "summary"
echo "fails=$fails warns=$warns"
[ "$fails" = 0 ] && echo "PREFLIGHT PASS" || echo "PREFLIGHT FAIL"
