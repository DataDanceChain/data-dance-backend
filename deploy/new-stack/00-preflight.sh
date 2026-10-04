#!/usr/bin/env bash
# 00-preflight.sh - READ-ONLY checks before building the new production stack (compose project ddcnew).
# CHANGES ON THE SERVER: nothing. No file is written (not even /tmp), no container is started,
#   nothing is pulled or pruned. Reads: df, /proc/meminfo, ss, docker ps/inspect/system df/info,
#   docker buildx inspect, journalctl --disk-usage, getent, a size query on the old database, the NAMES in backend.env.
# UNDO: nothing to undo.
# Self-contained (no common.sh) so it can be piped to the server: ./remote.sh preflight (it prepends one line,
#   GIT_APN_SHA=<sha256>, for the apn_key.p8 comparison below; piped without it, that comparison reports "not checked").
# Prints names, counts, sizes and PASS/WARN/FAIL only - never a secret value.
set -euo pipefail

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

sec "ports (new stack must find them free, old stack must hold its own)"
for p in 10010 15433 9011 9012 9013; do
  if ss -Htln "sport = :$p" | grep -q .; then fail "port $p is in use"; else pass "port $p free"; fi
done
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
docker ps -a --format '{{.Names}}|{{.Status}}|{{.Ports}}' | grep -E '^ddc-' | sort
up=$(docker ps --format '{{.Names}}' | grep -cE '^ddc-' || true)
[ "$up" -ge 6 ] && pass "$up old containers running" || fail "only $up old containers running (expected 6)"
docker inspect --format '{{.Name}} restart={{.HostConfig.RestartPolicy.Name}} started={{.State.StartedAt}}' ddc-backend-ddc-backend-api-1 ddc-backend-ddc-backend-db-1 2>/dev/null
DB_BYTES=$(docker exec ddc-backend-ddc-backend-db-1 sh -c 'psql -U "$POSTGRES_USER" -d ddc -tAc "SELECT pg_database_size(current_database())"' 2>/dev/null | tr -dc '0-9' || true)
PGV=$(docker exec ddc-backend-ddc-backend-db-1 sh -c 'psql -U "$POSTGRES_USER" -d ddc -tAc "SHOW server_version"' 2>/dev/null | awk '{print $1}' || true)
echo "old_db=ddc size_bytes=${DB_BYTES:-?} size_gb=$(awk -v b="${DB_BYTES:-0}" 'BEGIN{printf "%.2f", b/1024^3}') server_version=${PGV:-?}"

sec "existing new-stack dirs"
for d in /root/ddcnew /root/mainnet-switch /root/backup /root/backup/pg; do
  if [ -e "$d" ]; then echo "$d exists ($(find "$d" -mindepth 1 -maxdepth 1 | wc -l) entries)"; else echo "$d absent"; fi
done
for f in /etc/nginx/sites-available/tge-api.datadance.ai /etc/nginx/sites-available/tge-app.datadance.ai /etc/nginx/sites-enabled/tge-api.datadance.ai /etc/nginx/sites-enabled/tge-app.datadance.ai /etc/cron.d/ddc-pgdump; do
  [ -e "$f" ] && echo "$f exists" || echo "$f absent"
done

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

echo "old-stack files the write scripts fingerprint (path, short sha256; common.sh old_files):"
{ printf '%s\n' /root/ddc-backend/backend.env /root/ddc-backend/docker-compose.yaml /root/ddc/docker-compose.yml
  find /root/ddc-backend/overlays -type f 2>/dev/null | LC_ALL=C sort
  find /etc/nginx/sites-available -mindepth 1 -maxdepth 1 ! -type d ! -name 'tge-api.datadance.ai*' ! -name 'tge-app.datadance.ai*' | LC_ALL=C sort
} | while IFS= read -r f; do if [ -f "$f" ]; then printf '  %s %s\n' "$(sha256sum < "$f" | cut -c1-12)" "$f"; else printf '  MISSING %s\n' "$f"; fi; done

sec "production-only code in the old api (input for the overlay reconcile step)"
docker inspect --format '{{range .Mounts}}{{if eq .Type "bind"}}{{.Source}}{{"\n"}}{{end}}{{end}}' ddc-backend-ddc-backend-api-1 | grep -c '/overlays/' | sed 's/^/overlay_file_mounts=/' || true
echo "container-layer files changed under /app/src (docker cp or edits, not in any mount):"
docker diff ddc-backend-ddc-backend-api-1 | awk '$2 ~ /^\/app\/src\/.*\.js$/ {print "  " $1 " " $2}'
echo "container-layer files under /app/public (runtime uploads outside the mounts): $(docker diff ddc-backend-ddc-backend-api-1 | awk '$1!="D" && $2 ~ /^\/app\/public\/.*\.[A-Za-z0-9]+$/' | wc -l)"
docker diff ddc-backend-ddc-backend-api-1 | awk '$1!="D" && $2 ~ /^\/app\/public\/.*\.[A-Za-z0-9]+$/ {n=split($2,a,"/"); d=""; for(i=2;i<n;i++) d=d "/" a[i]; c[d]++} END {for (k in c) print "  " c[k] " " k}'

sec "DNS for the temporary domains"
for h in tge-api.datadance.ai tge-app.datadance.ai api.datadance.ai app.datadance.ai; do
  r=$(getent hosts "$h" | awk '{print $1}' | tr '\n' ' ' || true)
  echo "$h -> ${r:-<no record>}"
done
getent hosts tge-api.datadance.ai >/dev/null && pass "tge-api resolves" || warn "tge-api.datadance.ai has no DNS record yet (Cloudflare A record needed)"
getent hosts tge-app.datadance.ai >/dev/null && pass "tge-app resolves" || warn "tge-app.datadance.ai has no DNS record yet (Cloudflare A record needed)"

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
