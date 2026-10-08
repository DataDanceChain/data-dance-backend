#!/usr/bin/env bash
# READ-ONLY (2026-10-04): git blob ids of the production overlay files and the deploy checkouts' revisions.
# Prints hashes, sizes, times, names and redacted remotes only — no file contents, no env values.
set -u
section() { printf '\n===== %s =====\n' "$1"; }
section "overlay files: blob id | size | mtime | name"
for f in /root/ddc-backend/overlays/*; do printf '%s|%s|%s|%s\n' "$(git hash-object "$f")" "$(stat -c %s "$f")" "$(stat -c %y "$f" | cut -c1-16)" "$(basename "$f")"; done
section "other bind-mounted dirs: file counts and newest mtime"
for d in /root/ddc-backend/keys_fixed /root/ddc-backend/campaign-covers /root/ddc-backend/passes; do echo "$d files=$(find "$d" -type f | wc -l) newest=$(find "$d" -type f -printf '%TY-%Tm-%Td %TH:%TM\n' | sort | tail -1)"; done
section "/root/ddc-backend entries (names, sizes, mtimes)"; ls -la /root/ddc-backend | awk '{print $5, $6, $7, $8, $9}'
section "compose files: image/env_file/container lines only"
grep -nE '^\s*(image|env_file|container_name|restart|command):' /root/ddc-backend/docker-compose.yaml /root/ddc/docker-compose.yml 2>/dev/null
section "/root/deploy-src checkouts"
for d in /root/deploy-src/*/; do
  echo "--- $d"
  if git -C "$d" rev-parse --git-dir >/dev/null 2>&1; then
    git -C "$d" log -1 --format='head=%h %ad %s' --date=format:'%m-%d %H:%M'
    git -C "$d" rev-parse --abbrev-ref HEAD
    git -C "$d" remote -v | head -1 | sed -E 's#//[^@/]+@#//<redacted>@#'
    echo "dirty-files=$(git -C "$d" status --porcelain 2>/dev/null | wc -l)"
  else ls "$d" | head -8; fi
done
section "frontend web container: /var/www newest files"
docker exec ddc-ddc-app-1 sh -c 'find /var/www -maxdepth 1 -type f -exec stat -c "%y %n" {} \; | sort | tail -6 | cut -c1-16,36-'
