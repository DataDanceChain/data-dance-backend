#!/usr/bin/env bash
# DataDance server survey — READ-ONLY. Changes nothing. Prints no secret values
# (environment variables: names only; crontab: secret-looking words redacted).
# Usage on the server:  bash survey-readonly.sh > survey-$(date +%Y%m%d-%H%M).txt 2>&1
set -u
section() { printf '\n===== %s =====\n' "$1"; }
redact() { sed -E 's/((pass|password|secret|token|key|pwd)[A-Za-z_]*[=: ]+)[^ ]+/\1<redacted>/Ig'; }

section "host";      hostname; uname -srm; uptime; nproc; free -h; df -h -x tmpfs -x devtmpfs
section "docker containers"; docker ps -a --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'
section "docker compose projects"; docker compose ls 2>/dev/null || docker-compose ls 2>/dev/null
section "docker resource use"; docker stats --no-stream --format 'table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}'
section "docker disk";   docker system df
section "docker networks"; docker network ls
section "docker volumes"; docker volume ls
section "env var NAMES per container (no values)"
for c in $(docker ps --format '{{.Names}}'); do
  # %q keeps multi-line values on one line, so only the NAME before '=' is printed
  echo "--- $c"; docker inspect --format '{{range .Config.Env}}{{printf "%q\n" .}}{{end}}' "$c" | grep -oE '^"[A-Za-z_][A-Za-z0-9_]*=' | tr -d '"=' | sort | tr '\n' ' '; echo
done
section "postgres databases (names, sizes) and user counts"
for c in $(docker ps --format '{{.Names}} {{.Image}}' | awk '/postgres/ {print $1}'); do
  echo "--- $c"
  docker exec "$c" sh -c 'psql -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-postgres}" -Atc "select datname, pg_size_pretty(pg_database_size(datname)) from pg_database where not datistemplate"' 2>&1
  docker exec "$c" sh -c 'psql -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-postgres}" -Atc "select count(*) as users from \"User\""' 2>&1
done
section "nginx sites (server_name / listen / proxy_pass only)"; nginx -T 2>/dev/null | grep -E '^\s*(server_name|listen|proxy_pass|# configuration file)' 
section "TLS certificates"; ls /etc/letsencrypt/live 2>/dev/null
section "directories under /root"; ls -la /root; du -sh /root/*/ 2>/dev/null | sort -h | tail -20
section "running services"; systemctl list-units --type=service --state=running --no-pager | head -60
section "scheduled jobs (secrets redacted)"; crontab -l 2>/dev/null | redact; ls /etc/cron.d 2>/dev/null
section "firewall"; (ufw status 2>/dev/null || iptables -S 2>/dev/null | head -40)
section "done"; date
