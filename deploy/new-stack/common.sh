# shellcheck shell=bash disable=SC2034
# common.sh - shared constants and guards for the ddcnew (new production stack) scripts.
# Sourced by p1-backup.sh, p2-disk.sh, 10-build.sh, 20-env.sh, 30-nginx.sh, 40-up.sh, 50-partner-page.sh, 99-teardown.sh.
# Every write path (p1-backup.sh dump/verify/install-cron/uninstall-cron, p2-disk.sh apply, 10-build.sh, 20-env.sh,
# 30-nginx.sh apply/undo, 40-up.sh, 50-partner-page.sh apply/remove, 99-teardown.sh) calls old_snapshot_begin at start
# and old_snapshot_assert at end.
# Every write run also calls run_begin (one write run at a time, server-side copy of its output).
# CHANGES ON THE SERVER: nothing by itself (definitions only).
# Portable to bash 3.2 (the local test sources it on macOS): no associative arrays; awk programs run on mawk 1.3.4
# 20200120 (Ubuntu 22.04), which has no {n} regex intervals.

# One locale for every tool (sort, comm, grep ranges, awk), the same on the server and in the local test.
export LC_ALL=C

# ---------------------------------------------------------------------------
# Constants (paths may be overridden ONLY for the local test, see require_server)
# ---------------------------------------------------------------------------
NEW_DIR="${NEW_DIR:-/root/ddcnew}"
# Files the host nginx serves (www-data cannot traverse /root): the partner info page (50-partner-page.sh).
SRV_DIR="${SRV_DIR:-/srv/ddcnew}"
BACKUP_DIR="${BACKUP_DIR:-/root/backup}"
SWITCH_DIR="${SWITCH_DIR:-/root/mainnet-switch}"
OLD_BACKEND_DIR="${OLD_BACKEND_DIR:-/root/ddc-backend}"
OLD_APP_DIR="${OLD_APP_DIR:-/root/ddc}"
OLD_ENV="${OLD_ENV:-$OLD_BACKEND_DIR/backend.env}"
PROJECT=ddcnew
OLD_DB_CTR=ddc-backend-ddc-backend-db-1
OLD_API_CTR=ddc-backend-ddc-backend-api-1
OLD_APP_CTR=ddc-ddc-app-1
OLD_DB_NAME=ddc
NEW_PORTS="10010 15433 9011"
OLD_PORTS="10000 9000 9001 9002 9003 15432"
PROTECTED_DIRS="/root/ddc /root/ddc-backend /root/deploy-src /opt/ddc"
NGINX_AVAIL="${NGINX_AVAIL:-/etc/nginx/sites-available}"
NGINX_ENABLED="${NGINX_ENABLED:-/etc/nginx/sites-enabled}"
TGE_API_HOST=tge-api.datadance.ai
TGE_APP_HOST=tge-app.datadance.ai
# Memory and disk watchdog for docker builds (no swap on the host; the old Postgres and API share it and its disk).
DDC_MEMINFO="${DDC_MEMINFO:-/proc/meminfo}"
DDC_PROC="${DDC_PROC:-/proc}"
BUILD_MEM_FLOOR_MB="${BUILD_MEM_FLOOR_MB:-1000}"
BUILD_DISK_FLOOR_MB="${BUILD_DISK_FLOOR_MB:-3072}"
BUILD_WATCH_INTERVAL="${BUILD_WATCH_INTERVAL:-2}"

say()  { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
pass() { printf 'PASS %s\n' "$*"; }
warn() { printf 'WARN %s\n' "$*"; }
die()  { printf 'FAIL %s\n' "$*" >&2; exit 1; }

# Local test mode: only with every path outside /root and never as root.
ddc_local_test() { [ "${DDC_LOCAL_TEST:-0}" = 1 ]; }

require_server() {
  if ddc_local_test; then
    [ "$(id -u)" != 0 ] || die "DDC_LOCAL_TEST=1 is refused when running as root"
    case "$NEW_DIR" in /root*) die "DDC_LOCAL_TEST=1 refuses NEW_DIR under /root";; esac
    case "$SRV_DIR" in /root*) die "DDC_LOCAL_TEST=1 refuses SRV_DIR under /root";; esac
    return 0
  fi
  [ "$(id -u)" = 0 ] || die "run as root on the server"
  [ "$NEW_DIR" = /root/ddcnew ] || die "NEW_DIR override is only allowed with DDC_LOCAL_TEST=1"
  [ "$SRV_DIR" = /srv/ddcnew ] || die "SRV_DIR override is only allowed with DDC_LOCAL_TEST=1"
  [ "$OLD_ENV" = /root/ddc-backend/backend.env ] || die "OLD_ENV override is only allowed with DDC_LOCAL_TEST=1"
  [ "$OLD_BACKEND_DIR" = /root/ddc-backend ] && [ "$OLD_APP_DIR" = /root/ddc ] || die "OLD_BACKEND_DIR / OLD_APP_DIR overrides are only allowed with DDC_LOCAL_TEST=1"
  [ "$BACKUP_DIR" = /root/backup ] && [ "$SWITCH_DIR" = /root/mainnet-switch ] || die "BACKUP_DIR / SWITCH_DIR overrides are only allowed with DDC_LOCAL_TEST=1"
  [ "$NGINX_AVAIL" = /etc/nginx/sites-available ] && [ "$NGINX_ENABLED" = /etc/nginx/sites-enabled ] || die "NGINX_* overrides are only allowed with DDC_LOCAL_TEST=1"
  [ "$DDC_MEMINFO" = /proc/meminfo ] || die "DDC_MEMINFO override is only allowed with DDC_LOCAL_TEST=1"
  [ "$DDC_PROC" = /proc ] || die "DDC_PROC override is only allowed with DDC_LOCAL_TEST=1"
  case "$BUILD_MEM_FLOOR_MB" in ''|*[!0-9]*) die "BUILD_MEM_FLOOR_MB must be a number";; esac
  [ "$BUILD_MEM_FLOOR_MB" -ge 1000 ] || die "BUILD_MEM_FLOOR_MB may only be raised above 1000 on the server"
  case "$BUILD_DISK_FLOOR_MB" in ''|*[!0-9]*) die "BUILD_DISK_FLOOR_MB must be a number";; esac
  [ "$BUILD_DISK_FLOOR_MB" -ge 3072 ] || die "BUILD_DISK_FLOOR_MB may only be raised above 3072 on the server"
  [ "$BUILD_WATCH_INTERVAL" = 2 ] || die "BUILD_WATCH_INTERVAL override is only allowed with DDC_LOCAL_TEST=1"
  command -v docker >/dev/null || die "docker not found"
}

sha256() { if command -v sha256sum >/dev/null; then sha256sum | cut -c1-64; else shasum -a 256 | cut -c1-64; fi; }

# Canonical absolute path, whether or not the path (or its last components) exists yet: symlinks of the existing
# part are followed and `..` is applied after them (GNU realpath -m; grealpath on the Mac for the local test).
resolve_path() {
  if realpath -m / >/dev/null 2>&1; then realpath -m -- "$1"
  elif command -v grealpath >/dev/null 2>&1; then grealpath -m -- "$1"
  else die "resolve_path needs GNU realpath (coreutils; on macOS: brew install coreutils for grealpath)"; fi
}

# Refuse any WRITE target outside the new stack's own directories.
guard_write_path() {
  local r d
  r="$(resolve_path "$1")"
  [ -n "$r" ] || die "cannot resolve write target $1"
  for d in $PROTECTED_DIRS; do
    case "$r/" in "$d"/*) die "refusing to write $r: it belongs to the old stack ($d)";; esac
  done
  if ddc_local_test; then return 0; fi
  case "$r/" in
    /root/ddcnew/*|/root/backup/*|/root/mainnet-switch/*|/srv/ddcnew/*) return 0;;
    "$NGINX_AVAIL/$TGE_API_HOST/"|"$NGINX_AVAIL/$TGE_APP_HOST/"|"$NGINX_ENABLED/$TGE_API_HOST/"|"$NGINX_ENABLED/$TGE_APP_HOST/") return 0;;
    /etc/cron.d/ddc-pgdump/) return 0;;
  esac
  die "refusing to write $r: not a new-stack path"
}

# Refuse a database name that is the production one.
guard_db_name() {
  case "$1" in
    ddc|postgres|template0|template1|"") die "refusing database name '$1'";;
  esac
}

# ---------------------------------------------------------------------------
# Every WRITE run (read-only modes never call this, so they still write nothing):
#   run_begin <label> <the script's original arguments...>     (right after require_server and argument checks)
# 1. A server-side copy of everything the run prints: $NEW_DIR/logs/<yyyymmdd-hhmmss>-<label>-<pid>.log (600). The script
#    runs itself again as `bash <script> <args> 2>&1 | tee -a <log>` and exits with the child's status, so the log is
#    complete when the script returns. The scripts print no secret values, so the log holds none either. GNU tee -p
#    keeps writing the log after the SSH session ends; the script itself goes on to its end, because its stdout (the
#    pipe to tee) stays open (no tty: Ctrl-C on the Mac or a dropped connection does not stop it; see APPROVAL.md).
#    A write script started by a logged run (99-teardown.sh -> 30-nginx.sh undo) writes into the parent's log.
# 2. One write run at a time: an exclusive flock on $NEW_DIR/.lock (600, holds the holder's pid/label/start time).
#    A second write run stops at once and names the holder. A child write script of a run that holds the lock
#    inherits it: DDC_LOCK_HELD names the lock AND fd 9 must be open on that file (checked in /proc).
# ---------------------------------------------------------------------------
lock_fd_is() { # <lock file>: fd 9 of this shell is open on exactly that file (Linux /proc)
  [ -e "/proc/$$/fd/9" ] && [ "$(readlink "/proc/$$/fd/9" 2>/dev/null)" = "$(resolve_path "$1")" ]
}
run_begin() {
  local label="$1" lock="$NEW_DIR/.lock" log rc
  shift
  case "$label" in ''|*[!A-Za-z0-9._-]*) die "run_begin: bad label '$label'";; esac
  if [ -z "${DDC_RUN_LOG:-}" ]; then
    guard_write_path "$NEW_DIR/logs"
    ( umask 077; install -d -m 700 "$NEW_DIR" "$NEW_DIR/logs" ) || die "cannot create $NEW_DIR/logs"
    log="$NEW_DIR/logs/$(date +%Y%m%d-%H%M%S)-$label-$$.log"
    guard_write_path "$log"
    ( umask 077; : >> "$log" ) && chmod 600 "$log" || die "cannot create $log"
    export DDC_RUN_LOG="$log"
    set +e
    if tee -p </dev/null >/dev/null 2>&1; then   # GNU tee: a closed SSH session does not stop the log
      "$BASH" "$0" "$@" 2>&1 | tee -p -a "$log"; rc=${PIPESTATUS[0]}
    else
      "$BASH" "$0" "$@" 2>&1 | tee -a "$log"; rc=${PIPESTATUS[0]}
    fi
    exit "$rc"
  fi
  guard_write_path "$lock"
  if command -v flock >/dev/null 2>&1; then
    if [ "${DDC_LOCK_HELD:-}" = "$lock" ] && lock_fd_is "$lock"; then
      say "lock: held by the parent run ($(cat "$lock" 2>/dev/null))"
    else
      exec 9>>"$lock"
      chmod 600 "$lock"
      flock -n 9 || die "another ddcnew write script is running ($(cat "$lock" 2>/dev/null)): let it finish (fuser -v $lock, or ps -fp <pid in the lock line>), then re-run"
      printf 'pid %s %s since %s\n' "$$" "$label" "$(date '+%Y-%m-%d %H:%M:%S %Z')" > "$lock"
      export DDC_LOCK_HELD="$lock"
    fi
  elif ddc_local_test; then say "lock: flock is not installed here (local test only): runs are not serialised"
  else die "flock not found (util-linux): refusing to write without the run lock"; fi
  say "run: $label pid $$; server-side log $DDC_RUN_LOG (600)"
}

# Single-line value of NAME from an env file (last assignment wins, surrounding quotes removed).
# Refuses a value that opens a quote it does not close on the same line (multi-line values).
env_get_simple() { # NAME FILE
  local line v
  line=$(grep -E "^[[:space:]]*(export[[:space:]]+)?$1[[:space:]]*=" "$2" | tail -1 || true)
  v="${line#*=}"; v="${v#"${v%%[![:space:]]*}"}"
  case "$v" in
    \"*\") v="${v#\"}"; v="${v%\"}";;
    \'*\') v="${v#\'}"; v="${v%\'}";;
    \"*|\'*) die "$1 in $(basename "$2") is a multi-line or unterminated quoted value";;
  esac
  printf '%s' "$v"
}

# ---------------------------------------------------------------------------
# Old-stack integrity: containers AND files, recorded at the start of every write script and compared
# at the end. Any difference fails loudly. Prints paths and short hashes only, never file contents.
# ---------------------------------------------------------------------------
# Snapshot of every old-stack container (name, id, state, start time, restart count, restart policy).
old_snapshot() {
  docker ps -a --format '{{.Names}}' | { grep -E '^ddc-' || true; } | sort | while read -r c; do
    docker inspect --format '{{.Name}}|{{.Id}}|{{.State.Status}}|{{.State.StartedAt}}|{{.RestartCount}}|{{.HostConfig.RestartPolicy.Name}}' "$c"
  done
}
# The old stack's configuration files: backend.env, every overlay file, both compose files and every
# vhost file in sites-available except the two tge-* files (and their .new temporaries) this package writes.
old_files() {
  printf '%s\n' "$OLD_ENV" "$OLD_BACKEND_DIR/docker-compose.yaml" "$OLD_APP_DIR/docker-compose.yml"
  if [ -d "$OLD_BACKEND_DIR/overlays" ]; then find "$OLD_BACKEND_DIR/overlays" -type f | LC_ALL=C sort
  else printf '%s\n' "$OLD_BACKEND_DIR/overlays/"; fi
  # A missing directory is listed as MISSING (a bare failing find would end the caller silently under pipefail).
  if [ -d "$NGINX_AVAIL" ]; then find "$NGINX_AVAIL" -mindepth 1 -maxdepth 1 ! -type d ! -name "$TGE_API_HOST*" ! -name "$TGE_APP_HOST*" | LC_ALL=C sort
  else printf '%s\n' "$NGINX_AVAIL/"; fi
}
old_files_snapshot() {
  local f
  old_files | while IFS= read -r f; do
    if [ -f "$f" ]; then printf '%s %s\n' "$(sha256 < "$f")" "$f"; else printf 'MISSING %s\n' "$f"; fi
  done
}
OLD_SNAP_BEFORE=""; OLD_FILES_BEFORE=""
old_snapshot_begin() {
  OLD_SNAP_BEFORE="$(old_snapshot)"
  OLD_FILES_BEFORE="$(old_files_snapshot)"
  say "old-stack containers: $(printf '%s\n' "$OLD_SNAP_BEFORE" | grep -c . ) (snapshot $(printf '%s' "$OLD_SNAP_BEFORE" | sha256 | cut -c1-12))"
  say "old-stack files: $(printf '%s\n' "$OLD_FILES_BEFORE" | grep -c . ) (snapshot $(printf '%s' "$OLD_FILES_BEFORE" | sha256 | cut -c1-12); missing=$(printf '%s\n' "$OLD_FILES_BEFORE" | grep -c '^MISSING ' || true))"
}
# Prints "before|after <short hash> <path>" for every line that differs; returns 1 when anything differs.
old_files_compare() {
  local now; now="$(old_files_snapshot)"
  [ "$now" = "$OLD_FILES_BEFORE" ] && return 0
  diff <(printf '%s\n' "$OLD_FILES_BEFORE") <(printf '%s\n' "$now") | awk '/^[<>] / {
    h = $2; p = substr($0, length($2) + 4); if (h != "MISSING") h = substr(h, 1, 12)
    printf "  %s %-12s %s\n", ($1 == "<" ? "before" : "after "), h, p }'
  return 1
}
old_snapshot_assert() {
  local now bad=0
  now="$(old_snapshot)"
  if [ "$now" = "$OLD_SNAP_BEFORE" ]; then pass "old-stack containers unchanged ($(printf '%s\n' "$now" | grep -c .) containers, same ids/state/start/restarts)"
  else
    printf 'old-stack container snapshot diff (names/state only):\n'; diff <(printf '%s\n' "$OLD_SNAP_BEFORE" | cut -d'|' -f1,3,4,5) <(printf '%s\n' "$now" | cut -d'|' -f1,3,4,5) || true
    printf 'FAIL old-stack containers changed during this script (a restart by a teammate, e.g. during the TGE data refresh, also triggers this: check who restarted it before assuming this script did)\n' >&2
    bad=1
  fi
  if old_files_compare; then pass "old-stack files unchanged ($(printf '%s\n' "$OLD_FILES_BEFORE" | grep -c .) files: backend.env, overlays/*, both compose files, old vhosts)"
  else
    printf 'FAIL OLD-STACK FILES CHANGED while this script ran (paths and short sha256 above). This package never writes them,\n' >&2
    printf '     so a teammate may have changed them: ask Race / the team before going on, and do not assume this script did it.\n' >&2
    bad=1
  fi
  [ "$bad" = 0 ] || die "old-stack integrity check failed"
}

# Compose wrapper for the new stack only.
dc() { docker compose -p "$PROJECT" --project-directory "$NEW_DIR" -f "$NEW_DIR/compose.yaml" "$@"; }

port_in_use() { ss -Htln "sport = :$1" 2>/dev/null | grep -q .; }

# MemAvailable in MB; empty output when the file cannot be read.
mem_avail_mb() { awk '/^MemAvailable:/ {print int($2/1024)}' "$DDC_MEMINFO" 2>/dev/null || true; }
# Rounds DOWN (df -BG rounds up, so 5.1G would pass a 6G check).
disk_avail_gb() { echo $(( $(df -B1 --output=avail / | tail -1 | tr -dc '0-9') / 1073741824 )); }
# Free space on / in MB (POSIX df, rounds down); empty output when df fails. Used by the build watchdog.
disk_avail_mb() { df -Pk / 2>/dev/null | awk 'NR == 2 {print int($4 / 1024)}' || true; }

# ---------------------------------------------------------------------------
# docker build under a memory and disk watchdog.
#   run_build_watched <log-file> <docker build arguments...>
# Polls every $BUILD_WATCH_INTERVAL s while the build runs. It stops the build when MemAvailable falls below
# $BUILD_MEM_FLOOR_MB or the free space on / below $BUILD_DISK_FLOOR_MB (3G; the old Postgres writes to the same
# disk), or when either cannot be read: SIGTERM to the docker client (BuildKit cancels the session and the running
# step), SIGKILL after 10 s, then SIGKILL to every BuildKit RUN-step process still alive (buildkit_step_rows). It then
# fails with a clear message. On every poll it also sets oom_score_adj=1000 on the RUN-step processes, so that if the
# kernel OOM killer acts between two polls it kills the build, not the old Postgres or API. That marking matters:
# a RUN step inherits dockerd's oom_score_adj=-500 (measured 10-04, docker 29.1.3), while the old containers run at 0.
# Only the embedded builder (buildx driver "docker") is accepted, because a docker-container builder would keep
# running in its own container.
# No tty (remote.sh): when the SSH session ends the script gets no SIGHUP, and a write to the closed stdout would
# kill it with SIGPIPE, leaving the build unwatched. So SIGPIPE is ignored while the build runs, every watchdog line
# goes through wd_say (never fails), and kill_build runs before anything is printed. SIGHUP/SIGINT/SIGTERM to the
# script stop the build through kill_build as well.
# Returns the build's exit code when the build ends on its own.
# ---------------------------------------------------------------------------
wd_say() { printf '%s\n' "$*" 2>/dev/null || true; }

# BuildKit RUN-step processes of the embedded builder, found by their cgroup ($DDC_PROC/<pid>/cgroup):
#   cgroupfs driver (Docker Desktop, measured):                          /docker/buildkit/<id>
#   systemd driver (docker 29.1.3 = the server's version, measured 10-04 on Ubuntu 22.04 with systemd, cgroup v2):
#                                                                        /system.slice/system.slice:docker:<id>
#   a systemd scope, should another docker/runc version put steps there: /system.slice/docker-<id>.scope
# <id> is BuildKit's random 25-character [0-9a-z] id. Every normal container (the old stack included) lives in
# /system.slice/docker-<64 hex>.scope (systemd) or /docker/<64 hex> (cgroupfs). So a docker-<id>.scope process is
# taken only when <id> is 25 characters or 64 hex AND no container that `docker ps -aq --no-trunc` lists before or
# after the scan has that id; when either listing fails or is empty, no scope process is taken at all.
# Prints "<pid> <kind> <id|-> <cgroup path>" per selected process.
docker_ids_listed() { # space-separated full ids of every container; fails when docker fails, hangs (5 s) or lists none
  local ids
  if command -v timeout >/dev/null 2>&1; then
    ids=$(timeout 5 docker ps -aq --no-trunc 2>/dev/null) || return 1
  else
    ids=$(docker ps -aq --no-trunc 2>/dev/null) || return 1
  fi
  [ -n "$ids" ] || return 1
  printf '%s' "$ids" | tr '\n' ' '
}
_scan_step_rows() { # one /proc scan: "<pid> <kind> <id|-> <cgroup path>" per candidate RUN-step process
  grep -sH '' "$DDC_PROC"/[0-9]*/cgroup 2>/dev/null | awk -v pfx="$DDC_PROC/" -v self="$$" '
    index($0, pfx) == 1 {
      s = substr($0, length(pfx) + 1); i = index(s, "/cgroup:"); if (i < 2) next
      pid = substr(s, 1, i - 1); path = substr(s, i + 8)
      if (pid !~ /^[0-9]+$/ || pid == self) next
      sub(/^[^:]*:[^:]*:/, "", path)
      kind = ""; id = "-"
      if (path ~ /^\/docker\/buildkit\/[0-9a-z]+$/) kind = "cgroupfs"
      else if (path ~ /^\/system\.slice\/system\.slice:docker:[0-9a-z]+$/) kind = "systemd"
      else if (path ~ /^\/system\.slice\/docker-[0-9a-z]+\.scope$/) {
        id = substr(path, 22); id = substr(id, 1, length(id) - 6)
        if (length(id) == 25 || (length(id) == 64 && id ~ /^[0-9a-f]+$/)) kind = "systemd-scope"
      }
      if (kind != "" && !(pid in seen)) { seen[pid] = 1; print pid, kind, id, path }
    }' || true
}
buildkit_step_rows() {
  local l1 l2 rows
  [ -d "$DDC_PROC" ] || return 0
  rows=$(_scan_step_rows)
  [ -n "$rows" ] || return 0
  # Without a docker-<id>.scope candidate nothing needs the container list, so dockerd is not asked at all and a
  # hung dockerd cannot stall the watchdog (the measured systemd and cgroupfs layouts both land here).
  if ! printf '%s\n' "$rows" | awk '$2 == "systemd-scope" { f = 1 } END { exit !f }'; then
    printf '%s\n' "$rows"; return 0
  fi
  l1=$(docker_ids_listed) || l1=-
  rows=$(_scan_step_rows)
  l2=$(docker_ids_listed) || l2=-
  [ -n "$rows" ] || return 0
  printf '%s\n' "$rows" | awk -v l1="$l1" -v l2="$l2" '
    BEGIN { n = split(l1 " " l2, a, " "); for (i = 1; i <= n; i++) listed[a[i]] = 1 }
    $2 == "systemd-scope" { if (l1 == "-" || l2 == "-" || ($3 in listed)) next }
    NF >= 4 { print }'
}
buildkit_step_pids() { buildkit_step_rows | awk '{printf "%s ", $1}'; }
# The kernel OOM killer may act between two polls (no swap, build steps have no memory limit): make it pick a build
# step before the old Postgres or API. Prints how many processes were newly marked; never fails the build.
buildkit_oom_prefer() {
  local p n=0
  for p in $(buildkit_step_pids); do
    [ "$(cat "$DDC_PROC/$p/oom_score_adj" 2>/dev/null)" = 1000 ] && continue
    { echo 1000 > "$DDC_PROC/$p/oom_score_adj"; } 2>/dev/null && n=$((n + 1))
  done
  printf '%s' "$n"
}
cgroup_still() { # <pid> <path>: the process is still in exactly that cgroup (re-checked right before SIGKILL)
  local line l
  while IFS= read -r line; do l=${line#*:}; l=${l#*:}; [ "$l" = "$2" ] && return 0; done < "$DDC_PROC/$1/cgroup"
  return 1
} 2>/dev/null
BUILD_CG_DRIVER=unknown; BUILD_STEPS_MARKED=0
kill_build() { # <client pid> <reason> ; uses BUILD_CG_DRIVER and BUILD_STEPS_MARKED
  local pid="$1" why="${2:-stop requested}" i rows p kind id path n=0
  kill -TERM "$pid" 2>/dev/null || true
  wd_say "WATCHDOG $why: SIGTERM sent to the docker build client (pid $pid); BuildKit cancels the running step"
  for i in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
  if kill -0 "$pid" 2>/dev/null; then kill -KILL "$pid" 2>/dev/null || true; wd_say "watchdog: docker build client did not stop after SIGTERM: SIGKILL sent"; fi
  wait "$pid" 2>/dev/null || true
  sleep 3
  if [ ! -d "$DDC_PROC" ]; then wd_say "watchdog: no $DDC_PROC on this host (not Linux): step-process check skipped"; return 0; fi
  rows=$(buildkit_step_rows)
  while read -r p kind id path; do
    [ -n "$p" ] || continue
    if cgroup_still "$p" "$path" && kill -KILL "$p" 2>/dev/null; then n=$((n + 1)); fi
  done <<EOF
$rows
EOF
  if [ "$n" -gt 0 ]; then
    wd_say "watchdog: SIGKILL sent to $n BuildKit step process(es) still running (driver $BUILD_CG_DRIVER; this also stops any other build on this host)"
  elif [ "$BUILD_STEPS_MARKED" -gt 0 ]; then
    wd_say "watchdog: BuildKit step processes: none found (the selector matched $BUILD_STEPS_MARKED during this build on driver $BUILD_CG_DRIVER; none is left)"
  else
    wd_say "watchdog: BuildKit step processes: none found (selector inactive on driver $BUILD_CG_DRIVER: it matched no process during this build, so it cannot confirm that no RUN step is left; check: ps -eo pid,cgroup,args | grep -E 'buildkit|system.slice:docker:')"
  fi
}
run_build_watched() { # <log> <docker build args...>
  local log="$1" bpid m d low="" min="" dmin="" rc=0 drv info oomn
  shift
  drv=$(docker buildx inspect 2>/dev/null | awk '/^Driver:/ {print $2; exit}')
  [ "$drv" = docker ] || die "the active buildx builder uses driver '${drv:-unknown}', not the embedded 'docker' builder: the memory watchdog cannot stop it (docker buildx ls; docker buildx use default)"
  info=$(docker info --format '{{.CgroupDriver}} {{.CgroupVersion}}' 2>/dev/null) || info=""
  BUILD_CG_DRIVER=${info%% *}; [ -n "$BUILD_CG_DRIVER" ] || BUILD_CG_DRIVER=unknown
  BUILD_STEPS_MARKED=0
  m=$(mem_avail_mb); [ -n "$m" ] || die "cannot read MemAvailable from $DDC_MEMINFO"
  d=$(disk_avail_mb); [ -n "$d" ] || die "cannot read the free disk space on /"
  say "watchdog: MemAvailable=${m}MB (floor ${BUILD_MEM_FLOOR_MB}MB), free disk on / ${d}MB (floor ${BUILD_DISK_FLOOR_MB}MB), polling every ${BUILD_WATCH_INTERVAL}s"
  say "watchdog: docker cgroup driver=$BUILD_CG_DRIVER cgroup_version=${info#* }; RUN steps are found as /docker/buildkit/<id> (cgroupfs), /system.slice/system.slice:docker:<id> (systemd) or an unlisted /system.slice/docker-<id>.scope"
  # From here on, nothing printed may stop this shell (see the header): SIGPIPE ignored until the end.
  trap '' PIPE
  docker build "$@" > "$log" 2>&1 &
  bpid=$!
  # shellcheck disable=SC2064  # bpid is fixed now
  trap "kill_build $bpid 'signal received by the script'; wd_say 'FAIL build stopped: the script received a signal'; exit 1" HUP INT TERM
  while kill -0 "$bpid" 2>/dev/null; do
    m=$(mem_avail_mb)
    case "$m" in ''|*[!0-9]*) low="MemAvailable unreadable"; break;; esac
    if [ -z "$min" ] || [ "$m" -lt "$min" ]; then min="$m"; fi
    if [ "$m" -lt "$BUILD_MEM_FLOOR_MB" ]; then low="MemAvailable ${m}MB < ${BUILD_MEM_FLOOR_MB}MB"; break; fi
    oomn=$(buildkit_oom_prefer); case "$oomn" in ''|*[!0-9]*) oomn=0;; esac
    BUILD_STEPS_MARKED=$((BUILD_STEPS_MARKED + oomn))
    d=$(disk_avail_mb)
    case "$d" in ''|*[!0-9]*) low="free disk on / unreadable"; break;; esac
    if [ -z "$dmin" ] || [ "$d" -lt "$dmin" ]; then dmin="$d"; fi
    if [ "$d" -lt "$BUILD_DISK_FLOOR_MB" ]; then low="free disk on / ${d}MB < ${BUILD_DISK_FLOOR_MB}MB"; break; fi
    sleep "$BUILD_WATCH_INTERVAL"
  done
  if [ -n "$low" ]; then
    kill_build "$bpid" "$low"   # first: the build is stopped before anything else is printed
    trap - HUP INT TERM
    { tail -5 "$log" | sed 's/^/  build log: /'; } 2>/dev/null || true
    die "BUILD STOPPED BY THE WATCHDOG: $low (no swap; the old Postgres and API share this host and its disk). Nothing was tagged by this build. Check free -m and df -h /, wait or free space (p2-disk.sh apply removes build cache), then re-run. Log: $log"
  fi
  wait "$bpid" || rc=$?
  trap - HUP INT TERM
  wd_say "watchdog: build ended (exit $rc), lowest MemAvailable ${min:-?}MB, lowest free disk ${dmin:-?}MB, BuildKit step processes given oom_score_adj=1000: $BUILD_STEPS_MARKED (driver $BUILD_CG_DRIVER)"
  if [ "$BUILD_STEPS_MARKED" = 0 ]; then
    if [ -d "$DDC_PROC" ]; then
      wd_say "WARN watchdog: no BuildKit step process was marked during this build (driver $BUILD_CG_DRIVER): either every step came from the cache, or the step selector is inactive on this driver, and then the OOM preference and the SIGKILL fallback were inactive for this build (the memory and disk floors still applied)"
    else
      wd_say "WARN watchdog: no $DDC_PROC on this host: no BuildKit step process can be marked (local test only)"
    fi
  fi
  trap - HUP INT TERM PIPE
  return $rc
}

# ---------------------------------------------------------------------------
# Throwaway Apple Wallet pass signer for the rehearsal (10-build.sh step 3).
#   rehearsal_pass_signer <new keys_fixed dir> <old keys_fixed dir>
# The production signerKey.pem is a PRIVATE key (it signs passes as DataDance's Pass Type ID) and never enters the
# rehearsal. Writes signerKey.pem + a self-signed signerCert.pem (400) into the new dir; regenerates them when
# missing, unreadable, mismatched (cert vs key) or equal to the production files; dies if the result is not a
# matching throwaway pair. Prints file names and modes only.
# ---------------------------------------------------------------------------
pass_signer_ok() { # <sk> <sc> <prod sk> <prod sc>
  [ -f "$1" ] && [ -f "$2" ] || return 1
  cmp -s "$1" "$3" && return 1; cmp -s "$2" "$4" && return 1
  openssl pkey -in "$1" -noout 2>/dev/null || return 1
  [ "$(openssl pkey -in "$1" -pubout 2>/dev/null | sha256)" = "$(openssl x509 -in "$2" -noout -pubkey 2>/dev/null | sha256)" ]
}
rehearsal_pass_signer() {
  local sk="$1/signerKey.pem" sc="$1/signerCert.pem" psk="$2/signerKey.pem" psc="$2/signerCert.pem"
  [ -f "$psk" ] && [ -f "$psc" ] || die "missing $psk or $psc (needed only to prove the rehearsal files differ)"
  if ! pass_signer_ok "$sk" "$sc" "$psk" "$psc"; then
    rm -f "$sk.tmp" "$sc.tmp"
    ( umask 077; openssl req -x509 -newkey rsa:2048 -nodes -days 365 -subj "/CN=ddcnew rehearsal THROWAWAY pass signer (not Apple-issued)" \
        -keyout "$sk.tmp" -out "$sc.tmp" >/dev/null 2>&1 ) || die "openssl could not generate the throwaway pass signer"
    chmod 400 "$sk.tmp" "$sc.tmp"; mv -f "$sk.tmp" "$sk"; mv -f "$sc.tmp" "$sc"
    say "keys_fixed/signerKey.pem + signerCert.pem: generated a throwaway RSA-2048 key and self-signed certificate"
  else
    say "keys_fixed/signerKey.pem + signerCert.pem: reusing the throwaway pair"
  fi
  chmod 400 "$sk" "$sc"
  pass_signer_ok "$sk" "$sc" "$psk" "$psc" || die "pass signer check failed: the rehearsal pair is missing, mismatched or equal to production"
  pass "keys_fixed/signerKey.pem and signerCert.pem are a throwaway pair (differ from production; cert matches key), mode $(stat -c %a "$sk" 2>/dev/null || stat -f %Lp "$sk")"
}

# ---------------------------------------------------------------------------
# Infra-only images (10-build.sh --infra-only): the backend image lacks the production-only code.
# ---------------------------------------------------------------------------
INFRA_ONLY_BANNER='INFRA-ONLY IMAGE: this backend image lacks the production-only code (tracked links /api/go, data demands, market tags; see Drive report 2026-10-04). Do NOT use it for a rehearsal with production data or for the cutover.'
infra_only_value() { [ -f "$NEW_DIR/.env" ] && sed -n 's/^INFRA_ONLY=//p' "$NEW_DIR/.env" | tail -1; }
# Every step that brings production data into the new stack (pg_restore, public/ seeding, cutover) MUST
# call this first. Fails closed: anything but INFRA_ONLY=0 refuses.
refuse_if_infra_only() {
  [ -f "$NEW_DIR/.env" ] || die "$NEW_DIR/.env missing: run 10-build.sh first"
  [ "$(infra_only_value)" = 0 ] || die "INFRA_ONLY=$(infra_only_value) in $NEW_DIR/.env: $INFRA_ONLY_BANNER Refusing to bring production data in; rebuild with --overlays-reconciled first."
}

# ---------------------------------------------------------------------------
# Web3Auth JWKS pins (40-up.sh step 1a, runbook 5.0).
#   jwks_pins_decide <output of scripts/web3authJwksThumbprints.js> <configured pins csv> <operator-verified csv>
# Served = every 43-character base64url thumbprint in the output. Dies when nothing is served, when none of the
# configured pins is served, or when a served key was never pinned and the operator has not confirmed it.
# Sets JWKS_SERVED (one per line, sorted) and JWKS_PINS (comma list = every served key). Prints counts and
# 12-character prefixes only (thumbprints of public keys; not secrets).
# ---------------------------------------------------------------------------
JWKS_SERVED=""; JWKS_PINS=""
jwks_pins_decide() {
  local served configured verified both new gone unverified
  _n() { printf '%s\n' "$1" | grep -c . || true; }
  served=$(printf '%s\n' "$1" | sed -n 's/.*thumbprint=\([A-Za-z0-9_-]\{43\}\)\([^A-Za-z0-9_-].*\)\{0,1\}$/\1/p' | LC_ALL=C sort -u)
  configured=$(printf '%s' "$2" | tr ',' '\n' | tr -d ' \t' | grep . | LC_ALL=C sort -u || true)
  verified=$(printf '%s' "$3" | tr ',' '\n' | tr -d ' \t' | grep . | LC_ALL=C sort -u || true)
  both=$(LC_ALL=C comm -12 <(printf '%s\n' "$served") <(printf '%s\n' "$configured") | grep . || true)
  new=$(LC_ALL=C comm -23 <(printf '%s\n' "$served") <(printf '%s\n' "$configured") | grep . || true)
  gone=$(LC_ALL=C comm -13 <(printf '%s\n' "$served") <(printf '%s\n' "$configured") | grep . || true)
  say "jwks served=$(_n "$served") configured=$(_n "$configured") configured_and_served=$(_n "$both") served_not_configured=$(_n "$new") configured_not_served=$(_n "$gone")"
  [ "$(_n "$served")" -ge 1 ] || die "Web3Auth serves no usable key (no thumbprint in the script output): not starting the api"
  [ "$(_n "$both")" -ge 1 ] || die "none of the $(_n "$configured") configured WEB3AUTH_JWKS_PINNED_THUMBPRINTS is served by Web3Auth now: refusing to start the api (check the JWKS endpoints from a second network; runbook 5.0)"
  if [ -n "$new" ]; then
    unverified=$(LC_ALL=C comm -23 <(printf '%s\n' "$new") <(printf '%s\n' "$verified") | grep . || true)
    if [ -n "$unverified" ]; then
      printf '%s\n' "$unverified" | sed 's/^/  served but never pinned: /'
      die "Web3Auth serves $(_n "$unverified") key(s) that were never pinned. Confirm each thumbprint from a second network (node scripts/web3authJwksThumbprints.js on the Mac) and against Web3Auth's published keys, then re-run with JWKS_NEW_PINS_VERIFIED=<comma-separated thumbprints>"
    fi
    pass "$(_n "$new") newly served key(s) confirmed by the operator (JWKS_NEW_PINS_VERIFIED)"
  fi
  [ -z "$gone" ] || say "  $(_n "$gone") configured pin(s) no longer served: dropped"
  printf '%s\n' "$served" | cut -c1-12 | sed 's/^/  pin (prefix): /'
  JWKS_SERVED="$served"; JWKS_PINS=$(printf '%s\n' "$served" | paste -sd, -)
}

# ---------------------------------------------------------------------------
# 40-up.sh step 5: the api's "Partner SSO money-path assertions OK" line (src/server.js lines 42-48, identical on
# origin/main 47e6f74 and a779770, fetched 10-04). It prints sessionSecretSeparate=${moneyPath.sessionSecretSeparate},
# which src/constants/partnerClient.js assertFinancialGradeConfig sets to true only after checking that
# SSO_SESSION_SECRET is set and differs from JWT_SECRET (it throws otherwise).
#   money_path_fields_check <log line> <expected jwksPins count>
# Each field must appear as an exact space-separated token (allowedVerifiers=50 or issuer=https://tge-api.x do not
# pass). Any missing or different field STOPS the script: these are pass criteria, not warnings.
# publicClientRegistration stays a warning while runbook 5.2 is open (Sloan to confirm).
# ---------------------------------------------------------------------------
money_path_fields_check() {
  local tokens want missing=""
  tokens=$(printf '%s\n' "$1" | tr ' ' '\n')
  for want in "nodeEnv=production" "allowedVerifiers=5" "issuer=https://$TGE_API_HOST" "consentOrigin=https://$TGE_APP_HOST" \
              "web3authVerify=enforce" "legacyFallback=false" "jwksPinMode=enforce" "jwksPins=$2" "sessionSecretSeparate=true"; do
    if printf '%s\n' "$tokens" | grep -qxF -- "$want"; then pass "log: $want"; else missing="$missing $want"; fi
  done
  [ -z "$missing" ] || die "the money-path log line lacks:$missing (exact fields expected; the api is running: ./99-teardown.sh, or fix the env and re-run)"
  if printf '%s\n' "$tokens" | grep -qxF publicClientRegistration=closed; then pass "log: publicClientRegistration=closed"
  else warn "publicClientRegistration is not closed (OAUTH_PUBLIC_REGISTRATION_ENABLED, runbook 5.2: Sloan to confirm)"; fi
}

# ---------------------------------------------------------------------------
# Disk expansion verdict (p2-disk.sh expand-check). Pure arithmetic, so the local test can check it.
#   disk_expand_verdict <disk_bytes> <part_start_bytes> <part_bytes> <fs_bytes>
# growpart is needed when more than 16 MiB lies unallocated after the root partition (GPT keeps
# about 17 KiB at the end); resize2fs when the filesystem is more than 64 MiB smaller than the partition.
# ---------------------------------------------------------------------------
disk_expand_verdict() {
  awk -v d="$1" -v s="$2" -v p="$3" -v f="$4" 'BEGIN {
    M = 1024 * 1024; G = M * 1024
    tail = d - (s + p); gap = p - f
    gp = (tail > 16 * M) ? "yes" : "no"; rf = (gap > 64 * M || gp == "yes") ? "yes" : "no"
    printf "disk_gb=%.1f part_gb=%.1f fs_gb=%.1f unallocated_after_part_gb=%.1f growpart_needed=%s resize2fs_needed=%s\n", d/G, p/G, f/G, tail/G, gp, rf
  }'
}

# Read-only: block-device, partition and filesystem sizes of the root filesystem, the verdict and the exact
# growpart / resize2fs commands (p2-disk.sh expand-check). Dies on LVM, non-last partitions or unknown filesystems.
expand_check() { # [mount point, default /; anything else is for the local test only]
  local mp="${1:-/}" root fstype rdev pk part disk_b start_b part_b fs_b bs bc later f s
  root=$(findmnt -n -o SOURCE "$mp"); root="${root%%\[*}"; fstype=$(findmnt -n -o FSTYPE "$mp")
  say "root_source=$root fstype=$fstype df_size_gb=$(( $(df -B1 --output=size "$mp" | tail -1 | tr -dc '0-9') / 1073741824 ))"
  case "$root" in
    /dev/mapper/*|/dev/dm-*) die "root is on LVM / device-mapper ($root): growpart + resize2fs alone do not apply - stop and ask";;
    /dev/*) ;;
    *) die "root is not on a block device ($root)";;
  esac
  rdev=$(basename "$(readlink -f "$root")")
  [ -f "/sys/class/block/$rdev/partition" ] || die "$root is not a partition: stop and ask"
  pk=$(lsblk -no PKNAME "/dev/$rdev" | head -1); part=$(cat "/sys/class/block/$rdev/partition")
  [ -n "$pk" ] && [ -f "/sys/class/block/$pk/size" ] || die "cannot find the disk that holds $root"
  # /sys sizes are always in 512-byte sectors
  disk_b=$(( $(cat "/sys/class/block/$pk/size") * 512 ))
  start_b=$(( $(cat "/sys/class/block/$rdev/start") * 512 )); part_b=$(( $(cat "/sys/class/block/$rdev/size") * 512 ))
  case "$fstype" in
    ext2|ext3|ext4)
      bs=$(dumpe2fs -h "$root" 2>/dev/null | awk -F: '/^Block size/ {gsub(/[^0-9]/, "", $2); print $2}')
      bc=$(dumpe2fs -h "$root" 2>/dev/null | awk -F: '/^Block count/ {gsub(/[^0-9]/, "", $2); print $2}')
      [ -n "$bs" ] && [ -n "$bc" ] || die "dumpe2fs -h could not read the filesystem size"
      fs_b=$(( bs * bc ));;
    xfs)
      fs_b=$(xfs_info "$mp" | awk '/^data/ { for (i = 1; i <= NF; i++) { if ($i ~ /^bsize=/) { split($i, a, "="); b = a[2] } if ($i ~ /^blocks=/) { split($i, c, "="); n = c[2]; sub(/,$/, "", n) } } print b * n; exit }');;
    *) die "unexpected filesystem $fstype: stop and ask";;
  esac
  lsblk -b -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINT "/dev/$pk"
  later=0
  for f in /sys/class/block/"$pk"/"$pk"*/start; do
    [ -f "$f" ] || continue; s=$(( $(cat "$f") * 512 )); [ "$s" -gt "$start_b" ] && later=$((later + 1))
  done
  say "disk=/dev/$pk root_partition=$part partitions_after_root=$later"
  [ "$later" = 0 ] || die "the root partition is not the last one on /dev/$pk: growpart cannot grow it - stop and ask"
  disk_expand_verdict "$disk_b" "$start_b" "$part_b" "$fs_b"
  say "tools: growpart=$(command -v growpart >/dev/null && echo yes || echo 'NO (apt-get install -y cloud-guest-utils)') resize2fs=$(command -v resize2fs >/dev/null && echo yes || echo NO)"
  say "commands for the expansion (SEPARATE APPROVAL; only after the Aliyun console online resize to 80G and a console snapshot):"
  say "  command -v growpart || apt-get install -y cloud-guest-utils"
  say "  growpart /dev/$pk $part"
  case "$fstype" in xfs) say "  xfs_growfs $mp";; *) say "  resize2fs $root";; esac
  say "  df -h / && ./p2-disk.sh expand-check     # expect growpart_needed=no resize2fs_needed=no"
}
