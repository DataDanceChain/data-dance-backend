#!/usr/bin/env bash
# DataDance server survey 2 (2026-10-04) — READ-ONLY. Changes nothing on the server.
# Purpose: decide whether our PRs are safe at Race's next deploy, and size the new stack.
# Prints no secret values: env vars are names only, except an allow-list of non-secret flags;
# file contents never leave the server except filtered names and counts.
set -u
section() { printf '\n===== %s =====\n' "$1"; }
API=ddc-backend-ddc-backend-api-1
DB=ddc-backend-ddc-backend-db-1
APP=ddc-ddc-app-1
FLAGS='NODE_ENV|PORT|TRUST_PROXY_HOPS|WEB3AUTH_VERIFY_MODE|WEB3AUTH_ALLOW_LEGACY_FALLBACK|WEB3AUTH_WALLET_MATCH|WEB3AUTH_JWKS_PIN_MODE|SSO_TGE_ENABLED|SSO_ENVIRONMENT|DISBURSEMENT_PAUSED|OAUTH_PUBLIC_REGISTRATION_ENABLED|SSO_TGE_APP_PRESENTATION|SSO_REQUIRE_VERIFIED_SESSION'

section "host"; date -u; uptime; free -m; df -h /; docker system df; journalctl --disk-usage 2>/dev/null
section "root dirs (sizes)"; du -sh /root/*/ 2>/dev/null | sort -h | tail -20
section "new-stack paths already present?"; ls -ld /root/ddcnew /root/mainnet-switch /root/backup 2>&1
section "containers"; docker ps -a --format '{{.Names}}|{{.Image}}|{{.Status}}|{{.Ports}}'
section "container details (compose labels, restart, cmd, mounts)"
for c in $(docker ps -a --format '{{.Names}}'); do
  docker inspect --format '--- {{.Name}} project={{index .Config.Labels "com.docker.compose.project"}} workdir={{index .Config.Labels "com.docker.compose.project.working_dir"}} files={{index .Config.Labels "com.docker.compose.project.config_files"}} restart={{.HostConfig.RestartPolicy.Name}} image={{.Config.Image}} created={{.Created}}
    cmd={{json .Config.Cmd}} entrypoint={{json .Config.Entrypoint}}
    mounts={{range .Mounts}}{{.Source}}->{{.Destination}} {{end}}' "$c"
done
section "images"; docker images --format '{{.Repository}}:{{.Tag}}|{{.ID}}|{{.Size}}|{{.CreatedSince}}'
section "listening TCP ports of interest"; ss -ltnH | awk '{print $4}' | grep -E ':(22|80|443|10000|10010|90[0-9][0-9]|1543[0-9])$' | sort -u

section "backend: allow-listed non-secret flags from the container env"
docker inspect --format '{{range .Config.Env}}{{printf "%q\n" .}}{{end}}' "$API" | grep -E "^\"($FLAGS)=" | tr -d '"'
section "backend image: .env* files baked into /app (paths and line counts only)"
docker exec "$API" sh -c 'find /app -path /app/node_modules -prune -o -name ".env*" -type f -print 2>/dev/null | while read f; do echo "$f $(wc -l < "$f") lines"; done'
section "backend: allow-listed flags from the baked /app/.env (dotenv fills only names missing from the container env)"
docker exec "$API" sh -c 'cat /app/.env 2>/dev/null' | grep -E "^($FLAGS)="
section "backend: env NAMES that exist only in the baked /app/.env (they vanish once .dockerignore keeps .env out)"
CENV=$(docker inspect --format '{{range .Config.Env}}{{printf "%q\n" .}}{{end}}' "$API" | grep -oE '^"[A-Za-z_][A-Za-z0-9_]*=' | tr -d '"=' | sort -u)
BAKED=$(docker exec "$API" sh -c 'cat /app/.env 2>/dev/null' | grep -oE '^[[:space:]]*(export[[:space:]]+)?[A-Z][A-Z0-9_]*=' | sed -E 's/^[[:space:]]*(export[[:space:]]+)?//; s/=$//' | grep -E '_|^(PORT|HOSTNAME)$' | sort -u)
echo "container-env-names=$(printf '%s\n' "$CENV" | grep -c .) baked-names=$(printf '%s\n' "$BAKED" | grep -c .)"
echo "only-in-baked: $(comm -13 <(printf '%s\n' "$CENV") <(printf '%s\n' "$BAKED") | tr '\n' ' ')"
section "backend image: key file NAMES (no contents)"
docker exec "$API" sh -c 'echo "keys_fixed:"; ls -1 /app/keys_fixed 2>/dev/null; echo "keys:"; ls -1R /app/keys 2>/dev/null | head -20'
section "backend image: newest migrations shipped in the running code"
docker exec "$API" sh -c 'ls -1 /app/prisma/migrations | tail -14'
section "backend image: commerce attester config shipped (address only)"
docker exec "$API" sh -c 'ls -1 /app/src/contracts 2>/dev/null; grep -hoE "\"(address|contractAddress)\"[^,}]*" /app/src/contracts/*eployed*.json 2>/dev/null'
section "prod DB: applied prisma migrations (newest 15)"
docker exec "$DB" sh -c 'psql -U "${POSTGRES_USER:-postgres}" -d ddc -Atc "select migration_name, finished_at is not null, rolled_back_at is not null from _prisma_migrations order by started_at desc limit 15"' 2>&1
section "prod DB: server version"
docker exec "$DB" sh -c 'psql -U "${POSTGRES_USER:-postgres}" -d ddc -Atc "show server_version"' 2>&1

section "nginx: api/app vhosts (selected directives; auth headers redacted)"
for f in /etc/nginx/sites-enabled/api.datadance.co /etc/nginx/sites-enabled/app.datadance.co; do
  echo "--- $f -> $(readlink -f "$f")"
  grep -nE '^\s*(server_name|listen|location|proxy_pass|proxy_set_header|real_ip_header|set_real_ip_from|real_ip_recursive|include|root|alias|client_max_body_size|return|try_files|access_log)\b' "$f" \
    | sed -E 's/(proxy_set_header[[:space:]]+(Authorization|Cookie|X-Api-Key)[[:space:]]+).*/\1<redacted>;/I'
done
section "nginx: http-level real_ip / log_format / access_log"
grep -rnE '^\s*(real_ip_header|set_real_ip_from|real_ip_recursive|log_format|access_log)\b' /etc/nginx/nginx.conf /etc/nginx/conf.d 2>/dev/null | head -30
section "nginx access logs: POST /api/auth/register counts (no lines printed)"
for f in /var/log/nginx/*.log; do [ -f "$f" ] && echo "$f lines=$(wc -l < "$f") register_posts=$(grep -c 'POST /api/auth/register' "$f")"; done
section "backend logs (24h): counts only"
echo "rate_limit_exceeded=$(docker logs --since 24h "$API" 2>&1 | grep -c 'Rate limit exceeded') register_mentions=$(docker logs --since 24h "$API" 2>&1 | grep -c '/api/auth/register')"

section "wallet web container: served paths"
docker exec "$APP" sh -c 'for d in /usr/share/nginx/html /var/www /app; do [ -d "$d" ] && { echo "$d:"; ls "$d" | head -25; }; done; ls /usr/share/nginx/html/downloads /var/www/downloads 2>/dev/null | head'
section "wallet web: Web3Auth client id prefixes in the live bundle (public values, first 9 chars)"
docker exec "$APP" sh -c 'grep -rhoE "\"B[A-Za-z0-9_-]{80,}\"" /usr/share/nginx/html /var/www 2>/dev/null | cut -c2-10 | sort | uniq -c | head -5'

section "tools"; git --version 2>&1; docker version --format 'docker {{.Server.Version}}'; docker compose version 2>&1; docker buildx version 2>&1 | head -1
section "registries with stored docker auth (host names only)"
grep -oE '"[A-Za-z0-9.-]+\.[A-Za-z]{2,}(:[0-9]+)?"[[:space:]]*:[[:space:]]*\{' ~/.docker/config.json 2>/dev/null | grep -oE '^"[^"]+"' | tr -d '"'
section "outbound reachability"
curl -sS -m 10 -o /dev/null -w 'github %{http_code}\n' https://github.com
IMG=$(docker inspect --format '{{.Config.Image}}' "$API" 2>/dev/null); REG=""   # the registry host of the old api image, if it names one
case "$IMG" in */*) REG="${IMG%%/*}";; esac
case "$REG" in *.*|*:*) curl -sS -m 10 -o /dev/null -w 'registry of the old api image %{http_code}\n' "https://$REG/v2/";; *) echo "the old api image names no registry host";; esac
section "firewall and sshd"; ufw status verbose 2>/dev/null | head -30
sshd -T 2>/dev/null | grep -E '^(port|passwordauthentication|kbdinteractiveauthentication|permitrootlogin|pubkeyauthentication) '
section "cron (non-comment line count) and backup dirs"; echo "root-crontab-lines=$(crontab -l 2>/dev/null | grep -vcE '^[[:space:]]*(#|$)')"; ls /etc/cron.d 2>/dev/null
section "done"; date -u
