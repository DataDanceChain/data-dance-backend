#!/usr/bin/env bash
# 99-teardown.sh - remove the new stack only.
#
# CHANGES ON THE SERVER
#   default            docker compose -p ddcnew down (containers ddcnew-*, network ddcnew_default; no -v needed:
#                      the data is a bind mount); 30-nginx.sh undo: removes this package's vhosts at API_HOST / APP_HOST
#                      (links + files; anything else at those names stays), nginx -t and reload if it removed something;
#                      then removes the settings record /root/ddcnew/settings.env (the hosts and ports the stack was set
#                      up with: this run uses them, so the next run may choose others).
#                      If compose cannot run (compose.yaml or .env missing, compose error), the project is removed by
#                      its compose label instead: containers labelled com.docker.compose.project=ddcnew (all named
#                      ddcnew-*, checked first), then networks with that label (named ddcnew_*, checked first).
#   --remove-images    also removes images tagged ddcnew/* (never any other image).
#   --delete-dir       also deletes /root/ddcnew (pgdata, secrets, env files, key copies, sources, logs; the
#                      server-side log of this run goes with it, the Mac keeps its copy in deploy/new-stack/logs/).
#                      Irreversible; the rehearsal TGE client secret and the db password are gone with it.
#   Takes the run lock /root/ddcnew/.lock and logs to /root/ddcnew/logs/ (common.sh run_begin).
#   Never touches /root/backup (P1 dumps and cron) or anything of the old stack, nor Race's mainnet rehearsal
#   (ddc-mainnet-* containers, /root/ddc-mainnet, his vhosts). After a vhost take-over, the backed-up entries stay in
#   /root/ddcnew/vhost-takeover/ until ./30-nginx.sh restore puts them back (a separate, approved step); --delete-dir
#   refuses while a backup there was never restored.
#   STAYS BEHIND in every mode: the base images the builds pulled (node, nginx, ...) and postgres:17 (shared with
#   the old stack), and the build cache (docker builder prune -f, or p2-disk.sh apply, removes the cache).
# UNDO
#   Without --delete-dir: re-run 30-nginx.sh apply and 40-up.sh (data in pgdata is kept).
#   With --delete-dir: rebuild from 10-build.sh.
# Usage: ./99-teardown.sh [--remove-images] [--delete-dir]
set -euo pipefail
HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
. "$HERE/common.sh"
require_server
RM_IMAGES=0; RM_DIR=0
for a in "$@"; do case "$a" in --remove-images) RM_IMAGES=1;; --delete-dir) RM_DIR=1;; *) die "unknown option $a";; esac; done
run_begin 99-teardown "$@"
settings_say
old_snapshot_begin

# Fallback for step 1: remove project ddcnew by its compose label (exact match), never anything else.
remove_project_by_label() {
  local ids names nets bad
  ids=$(docker ps -aq --filter "label=com.docker.compose.project=$PROJECT")
  if [ -n "$ids" ]; then
    # shellcheck disable=SC2086  # word splitting of the id list is intended
    names=$(docker inspect --format '{{.Name}}' $ids | sed 's#^/##')
    bad=$(printf '%s\n' "$names" | grep -v "^$PROJECT-" || true)
    [ -z "$bad" ] || die "refusing: container(s) labelled project $PROJECT without the $PROJECT- name prefix: $(printf '%s' "$bad" | tr '\n' ' ')"
    # shellcheck disable=SC2086
    docker rm -f $ids >/dev/null
    say "removed by label: $(printf '%s\n' "$names" | tr '\n' ' ')"
  fi
  nets=$(docker network ls -q --filter "label=com.docker.compose.project=$PROJECT")
  if [ -n "$nets" ]; then
    # shellcheck disable=SC2086
    names=$(docker network inspect --format '{{.Name}}' $nets)
    bad=$(printf '%s\n' "$names" | grep -v "^${PROJECT}_" || true)
    [ -z "$bad" ] || die "refusing: network(s) labelled project $PROJECT without the ${PROJECT}_ name prefix: $(printf '%s' "$bad" | tr '\n' ' ')"
    # shellcheck disable=SC2086
    docker network rm $nets >/dev/null
    say "removed network(s) by label: $(printf '%s\n' "$names" | tr '\n' ' ')"
  fi
}

step "1. compose down (project ddcnew only)"
if [ -f "$NEW_DIR/compose.yaml" ] && dc down --remove-orphans; then
  pass "docker compose down (project $PROJECT)"
else
  warn "docker compose down is not possible or failed (compose.yaml or .env missing?): removing project $PROJECT by its compose label"
  remove_project_by_label
fi
# A leftover P1 restore-test container (verify interrupted) is ours and throwaway: remove it rather than stop here.
if docker ps -a --format '{{.Names}}' | grep -qx 'ddcnew-restore-test-20261004'; then
  docker rm -f -v ddcnew-restore-test-20261004 >/dev/null 2>&1 && warn "removed a leftover ddcnew-restore-test-20261004 container" \
    || die "could not remove the leftover ddcnew-restore-test-20261004 container"
fi
left=$(docker ps -a --filter "label=com.docker.compose.project=$PROJECT" --format '{{.Names}}' | grep -c . || true)
[ "$left" = 0 ] && pass "no ddcnew containers left" || die "$left ddcnew containers remain"

step "2. vhosts (this package's only)"
"$HERE/30-nginx.sh" undo
settings_forget

if [ "$RM_IMAGES" = 1 ]; then
  step "3. images ddcnew/*"
  imgs=$(docker image ls --format '{{.Repository}}:{{.Tag}}' | grep '^ddcnew/' || true)
  for i in $imgs; do docker image rm "$i" >/dev/null && say "removed $i"; done
fi

if [ "$RM_DIR" = 1 ]; then
  step "4. delete $NEW_DIR"
  b=""; for d in "$NEW_DIR"/vhost-takeover/*/; do if [ -f "$d/MANIFEST" ] && [ ! -e "$d/RESTORED" ]; then b="$b $(basename "$d")"; fi; done
  [ -z "$b" ] || die "refusing --delete-dir: $NEW_DIR/vhost-takeover holds the backup of vhosts this package took over and never restored ($b); run ./30-nginx.sh restore first"
  [ "$NEW_DIR" = /root/ddcnew ] && [ -d /root/ddcnew ] && [ ! -L /root/ddcnew ] || die "refusing: $NEW_DIR is not the real /root/ddcnew directory"
  rm -rf --one-file-system /root/ddcnew
  [ ! -e /root/ddcnew ] && pass "/root/ddcnew deleted" || die "/root/ddcnew still exists"
fi
old_snapshot_assert
say "kept: /root/backup (P1). Not touched: /root/ddc, /root/ddc-backend, /root/deploy-src, $MAINNET_DIR, ddc-* containers (${MAINNET_CTR_PREFIX}* included), vhosts this package did not write. Left behind: base images and the build cache (see header)."
