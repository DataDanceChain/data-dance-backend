#!/usr/bin/env bash
# closed-session.sh <package dir> <work dir> [mem|disk]   (local test helper; touches nothing outside <work dir>)
#   mem:  the watchdog's stdout and stderr go into a FIFO whose reader goes away after the first two lines, like an SSH
#         session that ends while 10-build.sh runs (remote.sh allocates no tty, so there is no SIGHUP). Then MemAvailable
#         drops below the floor. The watchdog must still stop the (stub) build and exit 1, not die of SIGPIPE.
#   disk: BUILD_DISK_FLOOR_MB is set above the real free space: the watchdog must stop the build and exit 1.
# Prints: rc=<exit status> term=<build got SIGTERM> build_alive=<after the run> reader_lines=<n> bash=<version>
# Runs on macOS bash 3.2 and Ubuntu 22.04 bash 5.1, as a normal user (DDC_LOCAL_TEST=1).
set -u
PKG="$1"; W="$2"; MODE="${3:-mem}"
rm -rf "$W"; mkdir -p "$W/bin" "$W/ddcnew"
cat > "$W/bin/docker" <<'EOF'
#!/bin/sh
# stub docker: only what run_build_watched calls; "build" runs until SIGTERM and records that it got it
case "$1" in
  buildx) printf 'Name:   default\nDriver: docker\n';;
  info) echo "systemd 2";;
  ps) echo 0000000000000000000000000000000000000000000000000000000000000001;;
  build) echo "$$" > "$STUB_DIR/build.pid"
         trap 'echo TERM > "$STUB_DIR/build.term"; exit 143' TERM
         while :; do sleep 1; done;;
esac
exit 0
EOF
chmod 755 "$W/bin/docker"
hi() { printf 'MemTotal:       16000000 kB\nMemAvailable:    8000000 kB\n' > "$W/meminfo"; }
lo() { printf 'MemTotal:       16000000 kB\nMemAvailable:     512000 kB\n' > "$W/meminfo"; }
hi
floor=3072; [ "$MODE" != disk ] || floor=999999999
watch() { # the 10-build.sh situation: set -euo pipefail, run_build_watched called directly
  PATH="$W/bin:$PATH" STUB_DIR="$W" DDC_LOCAL_TEST=1 NEW_DIR="$W/ddcnew" DDC_MEMINFO="$W/meminfo" BUILD_WATCH_INTERVAL=1 \
  BUILD_DISK_FLOOR_MB="$floor" "$BASH" -c 'set -euo pipefail; . "$1/common.sh"; run_build_watched "$2/build.log" -t closed-session-test .' _ "$PKG" "$W"
}
if [ "$MODE" = mem ]; then
  mkfifo "$W/fifo"
  ( head -n "${READ_LINES:-2}" < "$W/fifo" > "$W/reader.out" ) &   # the watchdog prints 2 lines before the build starts
  reader=$!
  ( watch > "$W/fifo" 2>&1; echo "$?" > "$W/rc" ) &
  runner=$!
  wait "$reader"                                    # the "SSH session" is gone: nobody reads stdout/stderr any more
  for _ in $(seq 1 50); do [ -s "$W/build.pid" ] && break; sleep 0.2; done
  sleep 2.5                                         # a few polls with the closed pipe
  lo                                                # then memory falls below the floor
  wait "$runner"
else
  ( watch > "$W/out" 2>&1; echo "$?" > "$W/rc" )
fi
rc=$(cat "$W/rc" 2>/dev/null || echo none); bp=$(cat "$W/build.pid" 2>/dev/null || echo 0)
alive=no; if [ "$bp" != 0 ] && kill -0 "$bp" 2>/dev/null; then alive=yes; kill -KILL "$bp" 2>/dev/null; fi
printf 'rc=%s term=%s build_alive=%s reader_lines=%s bash=%s\n' "$rc" "$([ -f "$W/build.term" ] && echo yes || echo no)" "$alive" \
  "$(cat "$W/reader.out" 2>/dev/null | wc -l | tr -d ' ')" "${BASH_VERSION%%(*}"
if [ "$MODE" = disk ]; then grep -E 'WATCHDOG|BUILD STOPPED' "$W/out" | cut -c1-150; fi
exit 0
