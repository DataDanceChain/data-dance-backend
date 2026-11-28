#!/usr/bin/env python3
"""Read-only observation of one nginx master and its worker generation."""

import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time


WORKER = re.compile(r"nginx: worker process( is shutting down)?(?: \(nginx\))?")
BOOT_ID = Path("/proc/sys/kernel/random/boot_id")


def identity(pid, started):
    if sys.platform.startswith("linux"):
        fields = Path(f"/proc/{pid}/stat").read_text().rpartition(")")[2].split()
        return f"{pid}:{fields[19]}"
    # Portable identity for the isolated macOS integration test.
    return f"{pid}:{started}"


def observe(pid_file):
    pid = int(pid_file.read_text().strip())
    if pid <= 1:
        raise RuntimeError("invalid nginx master PID")
    linux = sys.platform.startswith("linux")
    boot = BOOT_ID.read_text().strip() if linux else None
    rows = subprocess.check_output(
        ["/bin/ps", "-A", "-ww", "-o", "pid=", "-o", "ppid=", "-o", "lstart=",
         "-o", "state=", "-o", "command="],
        text=True, timeout=4, env={**os.environ, "LC_ALL": "C", "TZ": "UTC"},
    )
    master = None
    workers = {}
    for row in rows.splitlines():
        fields = row.split(None, 8)
        if len(fields) != 9:
            continue
        own, parent = map(int, fields[:2])
        started, state, title = " ".join(fields[2:7]), fields[7], fields[8].strip()
        if own == pid:
            if not title.startswith("nginx: master process ") or state.startswith("Z"):
                raise RuntimeError("PID file does not identify a running nginx master")
            master = identity(own, started)
        elif parent == pid:
            match = WORKER.fullmatch(title)
            if match is None:
                # nginx cache-manager/loader processes are not request workers.
                continue
            try:
                workers[identity(own, started)] = bool(match[1]) or state.startswith("Z")
            except FileNotFoundError:
                # A worker that just exited can disappear between ps and /proc.
                continue
    if master is None:
        raise RuntimeError("nginx master process was not found")
    return {"boot": boot, "master": master, "workers": workers}


def wait_for_drain(pid_file, snapshot, timeout):
    saved = snapshot["workers"]
    if not isinstance(saved, dict) or not any(value is False for value in saved.values()):
        raise RuntimeError("snapshot contained no active request worker")
    old = set(saved)
    deadline = time.monotonic() + timeout
    while True:
        current = observe(pid_file)
        if (current["master"], current["boot"]) != (snapshot["master"], snapshot["boot"]):
            raise RuntimeError("nginx master or boot changed during cutover")
        workers = current["workers"]
        remaining = old & workers.keys()
        replacement = workers.keys() - old
        if any(workers[key] for key in replacement):
            raise RuntimeError("unexpected newer draining worker; keep both backends")
        if not remaining and replacement:
            return {"drained": len(old), "active_replacements": len(replacement)}
        if time.monotonic() >= deadline:
            raise RuntimeError(f"drain deadline reached ({len(remaining)} original workers remain, "
                               f"{len(replacement)} replacements); keep both backends")
        time.sleep(0.15)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pid-file", type=Path, required=True)
    modes = parser.add_subparsers(dest="mode", required=True)
    modes.add_parser("snapshot")
    wait = modes.add_parser("wait")
    wait.add_argument("snapshot", type=Path)
    wait.add_argument("--timeout-seconds", type=float, required=True)
    args = parser.parse_args()
    try:
        if args.mode == "snapshot":
            result = observe(args.pid_file)
            if not any(value is False for value in result["workers"].values()):
                raise RuntimeError("no active nginx request worker to capture")
        else:
            if not 0 < args.timeout_seconds <= 3600:
                raise RuntimeError("drain timeout must be in (0, 3600] seconds")
            result = wait_for_drain(args.pid_file, json.loads(args.snapshot.read_text()),
                                    args.timeout_seconds)
        print(json.dumps(result, sort_keys=True))
        return 0
    except (OSError, ValueError, IndexError, KeyError, TypeError,
            subprocess.SubprocessError, RuntimeError) as exc:
        print(f"STOP: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
