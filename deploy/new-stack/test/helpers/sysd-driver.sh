#!/usr/bin/env bash
# sysd-driver.sh <package dir>   (local test helper)
# Runs INSIDE the throwaway privileged test container of run-local-tests.sh section 6d: Ubuntu 22.04 with systemd as
# PID 1 and docker-ce 29.1.3 (the server's version), cgroup v2, the systemd cgroup driver (the Ubuntu default) and the
# containerd image store, i.e. the server's layout. Builds use an offline busybox base image. A container named like the
# old Postgres stands in for the old stack. Prints PASS/FAIL lines; exit 1 on FAIL.
set -u
PKG="$1"; W=/wd
rm -rf "$W"; mkdir -p "$W/ok" "$W/kill" "$W/sel" "$W/rootfs/bin"
fails=0; ok() { echo "PASS $*"; }; bad() { echo "FAIL $*"; fails=$((fails+1)); }
info=$(docker info --format '{{.CgroupDriver}} {{.CgroupVersion}}'); ver=$(docker version --format '{{.Server.Version}}')
echo "dockerd $ver, cgroup driver/version: $info, buildx driver: $(docker buildx inspect | awk '/^Driver:/ {print $2; exit}')"
[ "$info" = "systemd 2" ] && ok "dockerd $ver uses the systemd cgroup driver on cgroup v2 (the Ubuntu 22.04 default)" || bad "driver is '$info'"
cp /bin/busybox "$W/rootfs/bin/"; for a in sh sleep echo; do ln -sf busybox "$W/rootfs/bin/$a"; done
tar -C "$W/rootfs" -c . | docker import - wdbase:local >/dev/null || bad "could not import the offline base image"
docker rm -f ddc-backend-ddc-backend-db-1 >/dev/null 2>&1
docker run -d --name ddc-backend-ddc-backend-db-1 wdbase:local sleep 100000 >/dev/null
oldpid=$(docker inspect --format '{{.State.Pid}}' ddc-backend-ddc-backend-db-1); oldadj=$(cat "/proc/$oldpid/oom_score_adj")
echo "stand-in old container: pid $oldpid cgroup $(cut -d: -f3- "/proc/$oldpid/cgroup") oom_score_adj $oldadj"
export DDC_MEMINFO="$W/meminfo" BUILD_WATCH_INTERVAL=1
hi() { printf 'MemTotal:       16000000 kB\nMemAvailable:    8000000 kB\n' > "$W/meminfo"; }
lo() { printf 'MemTotal:       16000000 kB\nMemAvailable:     512000 kB\n' > "$W/meminfo"; }
# shellcheck source=../../common.sh
. "$PKG/common.sh"
stepof() { local q; for q in $(pgrep -x sleep); do grep -q "$1" "/proc/$q/cmdline" 2>/dev/null && echo "$q"; done | head -1; }

echo "-- 1. plain build (no watchdog): where the RUN step lives, its oom_score_adj, what the selector takes"
printf 'FROM wdbase:local\nRUN sleep 4251\n' > "$W/sel/Dockerfile"
docker build --no-cache -t wdtest:sel "$W/sel" > "$W/sel.log" 2>&1 &
bp=$!
p=""; for _ in $(seq 1 60); do p=$(stepof 4251); [ -n "$p" ] && break; sleep 1; done
cg=$(cut -d: -f3- "/proc/$p/cgroup" 2>/dev/null); adj=$(cat "/proc/$p/oom_score_adj" 2>/dev/null)
echo "RUN step pid $p cgroup $cg oom_score_adj $adj; processes whose cgroup contains 'buildkit' (the round-2 selector): $(grep -l buildkit /proc/[0-9]*/cgroup 2>/dev/null | wc -l)"
case "$cg" in /system.slice/system.slice:docker:*) ok "measured: the RUN step's cgroup is /system.slice/system.slice:docker:<id>, without 'buildkit' and not docker-<64hex>.scope";; *) bad "unexpected RUN-step cgroup '$cg'";; esac
[ "$adj" = -500 ] && ok "measured: the RUN step inherits dockerd's oom_score_adj -500 (the old container runs at $oldadj): unmarked, the OOM killer would prefer the old Postgres" || echo "note: RUN step oom_score_adj $adj"
rows=$(buildkit_step_rows); printf '%s\n' "$rows" | sed 's/^/  selector: /'
printf '%s\n' "$rows" | awk '{print $1}' | grep -qx "$p" && ok "selector takes the RUN step" || bad "selector missed the RUN step"
printf '%s\n' "$rows" | awk '{print $1}' | grep -qx "$oldpid" && bad "selector took the stand-in old container's process" || ok "selector does not take the stand-in old container's process"
sleep 300 & dummy=$!   # stands for a docker client that has already stopped: the step itself is still running
BUILD_CG_DRIVER=systemd BUILD_STEPS_MARKED=1 kill_build "$dummy" "test" 2>&1 | sed 's/^/  kill_build> /'
rc=0; wait "$bp" || rc=$?
[ "$rc" != 0 ] && grep -q 'exit code: 137' "$W/sel.log" && ok "the SIGKILL fallback stopped the live RUN step (build exit $rc, step exit 137)" || bad "SIGKILL fallback (build exit $rc)"

echo "-- 2. a normal build under the watchdog"
hi; printf 'FROM wdbase:local\nRUN sleep 5\n' > "$W/ok/Dockerfile"
rc=0; ( run_build_watched "$W/ok.log" --no-cache -t wdtest:ok "$W/ok" ) > "$W/ok.out" 2>&1 || rc=$?
sed 's/^/  /' "$W/ok.out"
[ "$rc" = 0 ] && grep -q 'docker cgroup driver=systemd' "$W/ok.out" && grep -qE 'given oom_score_adj=1000: [1-9]' "$W/ok.out" && ! grep -q '^WARN' "$W/ok.out" \
  && ok "build passes; the watchdog prints driver=systemd and marked the RUN step (no 'selector inactive' warning)" || bad "normal build under the watchdog (rc=$rc)"

echo "-- 3. MemAvailable falls below the floor during RUN sleep 4252"
hi; printf 'FROM wdbase:local\nRUN sleep 4252\n' > "$W/kill/Dockerfile"
( q=""; for _ in $(seq 1 60); do q=$(stepof 4252); [ -n "$q" ] && break; sleep 1; done
  for _ in $(seq 1 10); do [ "$(cat "/proc/$q/oom_score_adj" 2>/dev/null)" = 1000 ] && break; sleep 1; done
  echo "step pid=$q oom_score_adj_before_flip=$(cat "/proc/$q/oom_score_adj" 2>/dev/null)"; lo ) > "$W/flip.out" 2>&1 &
flip=$!
rc=0; ( run_build_watched "$W/kill.log" --no-cache -t wdtest:kill "$W/kill" ) > "$W/kill.out" 2>&1 || rc=$?
wait "$flip"; cat "$W/flip.out"; sed 's/^/  /' "$W/kill.out"
[ "$rc" = 1 ] && grep -q 'oom_score_adj_before_flip=1000' "$W/flip.out" && grep -q 'BUILD STOPPED BY THE WATCHDOG: MemAvailable' "$W/kill.out" \
  && [ -z "$(stepof 4252)" ] && ! docker image inspect wdtest:kill >/dev/null 2>&1 \
  && ok "the RUN step had oom_score_adj=1000 before memory fell; the watchdog stopped the build (exit 1), no step left, nothing tagged" || bad "watchdog stop (rc=$rc)"

[ "$(docker inspect -f '{{.State.Running}}' ddc-backend-ddc-backend-db-1)" = true ] && [ "$(docker inspect --format '{{.State.Pid}}' ddc-backend-ddc-backend-db-1)" = "$oldpid" ] \
  && [ "$(cat "/proc/$oldpid/oom_score_adj")" = "$oldadj" ] && ok "stand-in old container: still running, same pid, oom_score_adj still $oldadj" || bad "the stand-in old container was touched"
echo "sysd-driver.sh: fails=$fails"
[ "$fails" = 0 ]
