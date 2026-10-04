#!/usr/bin/env bash
# selector.sh <package dir> <work dir>   (local test helper; touches nothing outside <work dir>)
# common.sh buildkit_step_rows / buildkit_oom_prefer / kill_build on FAKE /proc trees (DDC_PROC) for both docker cgroup
# drivers. The selector must take every BuildKit RUN-step process and never a process of a container that
# `docker ps -aq --no-trunc` lists (the old stack). Runs with the local awk (BSD awk on macOS, mawk 1.3.4 on Ubuntu
# 22.04). The kill test signals only sleep processes this script started itself. Prints PASS/FAIL lines; exit 1 on FAIL.
set -u
PKG="$1"; W="$2"
rm -rf "$W"; mkdir -p "$W/bin"
fails=0; ok() { echo "PASS $*"; }; bad() { echo "FAIL $*"; fails=$((fails+1)); }
rep() { printf "%${2}s" "" | tr ' ' "$1"; }   # rep <char> <count>
OLD_DB_ID=$(rep a 64); OLD_API_ID=$(rep b 64); LATE_ID=$(rep c 64); UNLISTED_ID=$(rep d 64); UPPER_ID=$(rep A 64)
STEP_ID=md2kplbtnz0r6e31e4lnpve1k; STEP_ID2=yme49ce6pbwdt0txpaiz0u9dj   # BuildKit ids seen 10-04 (systemd host / Docker Desktop)
export OLD_DB_ID OLD_API_ID LATE_ID STUB_DIR="$W"
cat > "$W/bin/docker" <<'EOF'
#!/bin/sh
# stub `docker ps -aq --no-trunc`: STUB_PS=normal|fail|empty. From the 2nd call on it also lists LATE_ID, a container
# created while the selector scanned /proc (listed by the "after" listing only).
[ "$1" = ps ] || exit 0
case "${STUB_PS:-normal}" in fail) exit 1;; empty) exit 0;; esac
n=$(cat "$STUB_DIR/ps.calls" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$STUB_DIR/ps.calls"
printf '%s\n' "$OLD_DB_ID" "$OLD_API_ID"
if [ "$n" -ge 2 ]; then printf '%s\n' "$LATE_ID"; fi
exit 0
EOF
chmod 755 "$W/bin/docker"
export PATH="$W/bin:$PATH"
mk() { mkdir -p "$1/$2"; printf '%b\n' "$3" > "$1/$2/cgroup"; printf '%s\n' "${4:-0}" > "$1/$2/oom_score_adj"; }

# systemd driver (the Ubuntu 22.04 default on cgroup v2)
SD="$W/proc-systemd"
mk "$SD" 101 "0::/system.slice/docker-$OLD_DB_ID.scope"               # old Postgres (listed)
mk "$SD" 102 "0::/system.slice/docker-$OLD_API_ID.scope"              # old api (listed)
mk "$SD" 103 "0::/system.slice/docker.service" -500                   # dockerd
mk "$SD" 104 "0::/system.slice/containerd.service" -999               # containerd
mk "$SD" 105 "0::/system.slice/system.slice:docker:$STEP_ID" -500     # RUN step, measured layout (docker 29.1.3)
mk "$SD" 106 "0::/system.slice/system.slice:docker:$STEP_ID" -500     # its child process
mk "$SD" 107 "0::/system.slice/docker-$STEP_ID2.scope" -500           # RUN step in a systemd scope (other versions)
mk "$SD" 108 "0::/system.slice/docker-$UNLISTED_ID.scope" -500        # 64-hex scope that no listing knows
mk "$SD" 109 "0::/system.slice/docker-$LATE_ID.scope"                 # container created during the scan (listed after)
mk "$SD" 110 "0::/user.slice/user-0.slice/session-7.scope"            # the operator's ssh session (this script)
mk "$SD" 111 "0::/init.scope"
mk "$SD" 112 "0::/system.slice/docker-abc123.scope"                   # malformed id
mk "$SD" 113 "0::/system.slice/docker-$UPPER_ID.scope"                # not hex
mk "$SD" 114 "12:memory:/system.slice/system.slice:docker:$STEP_ID\n0::/system.slice/system.slice:docker:$STEP_ID" -500
mk "$SD" 115 "0::/system.slice/docker-$OLD_DB_ID.scope/init"          # below a listed container
mk "$SD" 116 "0::/system.slice/system.slice:docker:$STEP_ID/sub"      # below a step cgroup (not a step path itself)
# cgroupfs driver (Docker Desktop)
CF="$W/proc-cgroupfs"
mk "$CF" 201 "0::/docker/$OLD_DB_ID"
mk "$CF" 202 "0::/docker/$OLD_API_ID"
mk "$CF" 203 "0::/docker/buildkit/$STEP_ID2" -500
mk "$CF" 204 "0::/docker/buildkit/$STEP_ID2" -500
mk "$CF" 205 "0::/docker/buildkit"
mk "$CF" 206 "0::/docker/$UNLISTED_ID"
mk "$CF" 207 "0::/"

sel() { # <proc dir>: the selected pids, sorted, space separated
  rm -f "$W/ps.calls"
  ( DDC_LOCAL_TEST=1; DDC_PROC="$1"; . "$PKG/common.sh"; buildkit_step_pids ) | tr ' ' '\n' | grep . | sort -n | tr '\n' ' ' | sed 's/ $//'
}
expect() { # <label> <got> <want> <never...>
  local label="$1" got="$2" want="$3" n hit=""; shift 3
  for n in "$@"; do case " $got " in *" $n "*) hit="$hit $n";; esac; done
  if [ -n "$hit" ]; then bad "$label: took process(es) of LISTED containers:$hit (got: $got)"
  elif [ "$got" = "$want" ]; then ok "$label: selected [$got]"
  else bad "$label: selected [$got], expected [$want]"; fi
}
expect "systemd driver, docker ps works" "$(export STUB_PS=normal; sel "$SD")" "105 106 107 108 114" 101 102 109 115
expect "systemd driver, docker ps fails: only the unambiguous step layout" "$(export STUB_PS=fail; sel "$SD")" "105 106 114" 101 102 109 115
expect "systemd driver, docker ps lists nothing: only the unambiguous step layout" "$(export STUB_PS=empty; sel "$SD")" "105 106 114" 101 102 109 115
expect "cgroupfs driver" "$(export STUB_PS=normal; sel "$CF")" "203 204" 201 202 206
expect "no /proc at all" "$(sel "$W/does-not-exist")" ""

# OOM preference: exactly the selected processes get 1000, everything else keeps its value
rm -f "$W/ps.calls"
m1=$( ( DDC_LOCAL_TEST=1; DDC_PROC="$SD"; . "$PKG/common.sh"; buildkit_oom_prefer ) )
rm -f "$W/ps.calls"
m2=$( ( DDC_LOCAL_TEST=1; DDC_PROC="$SD"; . "$PKG/common.sh"; buildkit_oom_prefer ) )
adj=""; for p in 101 102 103 104 105 106 107 108 109 110 111 112 113 114 115 116; do adj="$adj $p=$(cat "$SD/$p/oom_score_adj")"; done
want=" 101=0 102=0 103=-500 104=-999 105=1000 106=1000 107=1000 108=1000 109=0 110=0 111=0 112=0 113=0 114=1000 115=0 116=0"
[ "$m1" = 5 ] && [ "$m2" = 0 ] && [ "$adj" = "$want" ] && ok "oom_score_adj=1000 on the 5 RUN-step processes only (second poll marks 0 more); listed containers, dockerd and containerd unchanged" \
  || bad "oom marking: first=$m1 second=$m2 adj:$adj"

# kill_build's SIGKILL fallback on real processes: test-owned sleeps described by a fake /proc
state_of() { if [ -r "/proc/$1/stat" ]; then awk '{print $3}' "/proc/$1/stat"; else ps -o stat= -p "$1" 2>/dev/null | cut -c1; fi; }
KP="$W/proc-kill"
sleep 300 & s_step=$!; sleep 300 & s_child=$!; sleep 300 & s_old=$!; sleep 300 & s_client=$!
disown "$s_step" "$s_child" "$s_old" "$s_client"   # no job-status noise when they are killed
mk "$KP" "$s_step" "0::/system.slice/system.slice:docker:$STEP_ID" -500
mk "$KP" "$s_child" "0::/system.slice/docker-$STEP_ID2.scope" -500
mk "$KP" "$s_old" "0::/system.slice/docker-$OLD_DB_ID.scope" 0
rm -f "$W/ps.calls"
out=$( ( DDC_LOCAL_TEST=1; DDC_PROC="$KP"; . "$PKG/common.sh"; BUILD_CG_DRIVER=systemd; BUILD_STEPS_MARKED=2; kill_build "$s_client" "test stop" ) 2>&1 )
sleep 0.5
gone() { case "$(state_of "$1")" in ""|Z) return 0;; esac; return 1; }   # exited (reaped or zombie)
st="client=$(state_of "$s_client") step=$(state_of "$s_step") child=$(state_of "$s_child") old=$(state_of "$s_old")"
printf '%s\n' "$out" | sed 's/^/  kill_build> /'
if gone "$s_client" && gone "$s_step" && gone "$s_child" && ! gone "$s_old"; then
  printf '%s\n' "$out" | grep -q 'SIGKILL sent to 2 BuildKit step process' && ok "kill_build: client got SIGTERM, both RUN-step processes (systemd path + unlisted scope) SIGKILLed, the listed container's process untouched ($st)" || bad "kill_build message: $out"
else bad "kill_build process states: $st"; fi
kill -KILL "$s_old" 2>/dev/null
# "none found" wording: never claims that nothing is left when the selector never matched anything
mkdir -p "$W/proc-empty/1"; printf '0::/init.scope\n' > "$W/proc-empty/1/cgroup"
for marked in 0 3; do
  sleep 300 & c=$!; disown "$c"
  out=$( ( DDC_LOCAL_TEST=1; DDC_PROC="$W/proc-empty"; . "$PKG/common.sh"; BUILD_CG_DRIVER=systemd; BUILD_STEPS_MARKED=$marked; kill_build "$c" "test stop" ) 2>&1 )
  if [ "$marked" = 0 ]; then printf '%s\n' "$out" | grep -q 'none found (selector inactive on driver systemd' && ok "no step ever matched -> 'none found (selector inactive on driver systemd ...)'" || bad "inactive wording: $out"
  else printf '%s\n' "$out" | grep -q 'none found (the selector matched 3 during this build on driver systemd; none is left)' && ok "steps matched earlier, none now -> 'none found (the selector matched 3 ...; none is left)'" || bad "matched wording: $out"; fi
done
echo "selector.sh: awk=$({ awk --version || awk -W version; } </dev/null 2>/dev/null | head -1 | cut -c1-30) bash=${BASH_VERSION%%(*} fails=$fails"
[ "$fails" = 0 ]
