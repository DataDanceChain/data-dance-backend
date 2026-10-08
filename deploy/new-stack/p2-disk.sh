#!/usr/bin/env bash
# p2-disk.sh - runbook 4.0 P2 adapted to 2026-10-04 facts: measure, compute need_gb, free space safely.
#
# CHANGES ON THE SERVER
#   preview          nothing (read-only measurements and the verdict).
#   expand-check     nothing (read-only): block-device, partition and filesystem sizes of /, whether growpart and
#                    resize2fs are needed, and the exact commands for the online expansion (APPROVAL.md section 3).
#   apply            docker builder prune -f (unused BUILD CACHE only); with --all-cache: docker builder prune -a -f;
#                    journalctl --vacuum-size=200M; writes /root/backup/disk-need.txt (600).
#                    It never deletes images, containers or volumes (no image/system/volume prune).
#                    Also takes the run lock /root/ddcnew/.lock and logs to /root/ddcnew/logs/ (common.sh run_begin).
# UNDO
#   Not reversible, and nothing to restore: build cache is rebuilt by the next build (slower first build);
#   vacuumed journal entries older than the newest 200MB are gone (logs only).
#   Disk expansion (if the verdict says so) is a separate, console-side step - see APPROVAL.md.
# Usage: ./p2-disk.sh preview | expand-check | apply [--all-cache]
set -euo pipefail
HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
. "$HERE/common.sh"
require_server
mode="${1:-preview}"; opt="${2:-}"
case "$mode" in apply) run_begin p2-disk-apply "$@";; esac
G=$((1024*1024*1024))
JOURNAL_KEEP=$((200*1024*1024))
BUILD_TRANSIENT=$((4*G))   # deps stage of the backend build + frontend node_modules while both images are built here

to_bytes() { # "7.921GB" / "952.0M" / "690.4MB" / "0B" -> bytes
  awk -v s="$1" 'BEGIN{
    if (match(s, /[0-9.]+/)) { n = substr(s, RSTART, RLENGTH); u = toupper(substr(s, RSTART+RLENGTH)) } else { print 0; exit }
    gsub(/[^A-Z]/, "", u); m = 1
    b = (u ~ /B$/ && u != "B") ? 1000 : 1024   # docker prints SI units (GB), journalctl binary ones (M)
    if (u ~ /^K/) m = b; else if (u ~ /^M/) m = b^2; else if (u ~ /^G/) m = b^3; else if (u ~ /^T/) m = b^4
    printf "%d\n", n*m }'
}

img_bytes() {
  local id; id=$(docker inspect --format '{{.Image}}' "$1")
  to_bytes "$(docker image ls --no-trunc --format '{{.ID}}|{{.Size}}' | awk -F'|' -v id="$id" '$1==id {print $2; exit}')"
}

measure() {
  df -h /; docker system df
  # Unpacked size as `docker image ls` shows it (image inspect .Size is the compressed content size on containerd).
  BE_IMG=$(img_bytes "$OLD_API_CTR"); WEB_IMG=$(img_bytes "$OLD_APP_CTR")
  DB=$(docker exec "$OLD_DB_CTR" sh -c 'psql -U "$POSTGRES_USER" -d ddc -tAc "SELECT pg_database_size(current_database())"' | tr -dc '0-9')
  local latest; latest=$(find "$BACKUP_DIR/pg" -maxdepth 1 -name 'ddc-*.dump' -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2- || true)
  if [ -n "$latest" ]; then DUMP=$(stat -c %s "$latest"); DUMP_SRC="measured ($(basename "$latest"))"
  else DUMP=$(awk -v d="$DB" 'BEGIN{printf "%d", d*0.35}'); DUMP_SRC="estimated as 35% of db (run p1 dump first for a measured value)"; fi
  PUB=$(( $(docker exec "$OLD_API_CTR" du -sk /app/public | cut -f1) * 1024 ))
  CACHE_RECL=$(to_bytes "$(docker system df --format '{{.Type}}|{{.Reclaimable}}' | awk -F'|' '$1=="Build Cache" {print $2}')")
  CACHE_ALL=$(to_bytes "$(docker system df --format '{{.Type}}|{{.Size}}' | awk -F'|' '$1=="Build Cache" {print $2}')")
  JOURNAL=$(to_bytes "$(journalctl --disk-usage 2>/dev/null | sed -E 's/.*take up ([^ ]+).*/\1/')")
  AVAIL=$(( $(df -B1 --output=avail / | tail -1 | tr -dc '0-9') ))
  JOURNAL_FREE=$(( JOURNAL > JOURNAL_KEEP ? JOURNAL - JOURNAL_KEEP : 0 ))
}

report() {
  awk -v be="$BE_IMG" -v web="$WEB_IMG" -v db="$DB" -v dump="$DUMP" -v pub="$PUB" -v bt="$BUILD_TRANSIENT" \
      -v avail="$AVAIL" -v cr="$CACHE_RECL" -v ca="$CACHE_ALL" -v jf="$JOURNAL_FREE" -v src="$DUMP_SRC" 'BEGIN{
    G = 1024^3
    # Runbook P2 formula: new backend image + tge and production web images + ddc_rehearsal / ddc_rehearsal2 / ddc_prod
    # (1.5x db each: indexes, WAL) + 11 dumps (8 daily + 2 rehearsal + final) + old-public and new public + 5G margin.
    # Plus the build cache that building BOTH images on this server leaves behind (no registry).
    need  = be + 2*web + 3*1.5*db + 11*dump + 2*pub + bt + 5*G
    # Minimum to start today: P1 dump + new backend and tge web images + empty db + build cache + 3G margin.
    build = be + web + 2*dump + pub + bt + 3*G
    # Added on the window night (runbook section 6 step 0).
    win   = 1.5*db + dump + pub + 5*G
    after1 = avail + cr + jf          # apply
    after2 = avail + ca + jf          # apply --all-cache
    printf "be_img=%.2fG web_img=%.2fG db=%.2fG dump=%.2fG (%s) public=%.2fG build_transient=%.1fG\n", be/G, web/G, db/G, dump/G, src, pub/G, bt/G
    printf "need_gb=%d\nneed_build_gb=%d\nwindow_need_gb=%d\n", int(need/G)+1, int(build/G)+1, int(win/G)+1
    printf "avail_now_gb=%.1f avail_after_apply_gb=%.1f avail_after_apply_all_cache_gb=%.1f (cache reclaimable %.1fG of %.1fG, journal %.2fG)\n", avail/G, after1/G, after2/G, cr/G, ca/G, jf/G
    if (after1 >= need) v = "cleanup is enough for need_gb; no disk expansion needed";
    else if (after2 >= need) v = "cleanup with --all-cache is enough for need_gb; no disk expansion needed";
    else if (after2 >= build) v = "cleanup is enough to BUILD and start the empty stack (need_build_gb), NOT for the full rehearsal (need_gb): EXPAND THE DISK (80G) before restoring production data";
    else v = "cleanup is NOT enough even to build: EXPAND THE DISK (80G) before 10-build.sh";
    printf "verdict=%s\n", v
  }'
}

case "$mode" in
  expand-check)
    step "disk expansion check (read-only)"; say "df_avail_gb=$(disk_avail_gb)"; expand_check
    ;;
  preview)
    step "measurements (read-only)"; measure
    step "need_gb"; report
    journalctl --disk-usage 2>/dev/null || true
    ;;
  apply)
    guard_write_path "$BACKUP_DIR/disk-need.txt"
    old_snapshot_begin
    step "before"; measure; report
    step "prune build cache (never images or volumes)"
    if [ "$opt" = --all-cache ]; then docker builder prune -a -f | tail -1; else docker builder prune -f | tail -1; fi
    step "vacuum journal to 200M"; journalctl --vacuum-size=200M 2>&1 | tail -1
    step "after"; measure
    install -d -m 700 "$BACKUP_DIR"; umask 077
    { date -Is; report; } | tee "$BACKUP_DIR/disk-need.txt"
    chmod 600 "$BACKUP_DIR/disk-need.txt"
    docker image ls --format '{{.Repository}}:{{.Tag}}' | wc -l | sed 's/^/images_still_present=/'
    old_snapshot_assert
    ;;
  *) die "usage: $0 preview | expand-check | apply [--all-cache]";;
esac
