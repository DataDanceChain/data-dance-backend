#!/usr/bin/env python3
"""Exercise real nginx HUP, held requests and inverse routing on loopback only."""

from concurrent.futures import ThreadPoolExecutor
from http.client import HTTPConnection
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import time
from threading import Event, Thread


def fixture(label):
    started, release = Event(), Event()

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path == "/held":
                started.set()
                if not release.wait(12):
                    self.send_error(504)
                    return
            self.send_response(200)
            self.end_headers()
            self.wfile.write(label.encode())

        def log_message(self, *_):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    service = Thread(target=server.serve_forever, daemon=True)
    service.start()
    return (server, started, release, service)


def request(port, path="/probe"):
    client = HTTPConnection("127.0.0.1", port, timeout=13)
    try:
        client.request("GET", path, headers={"Connection": "close"})
        response = client.getresponse()
        return response.status, response.read().decode()
    finally:
        client.close()


def wait_route(port, destination):
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline:
        try:
            if request(port) == (200, destination):
                return
        except OSError:
            pass
        time.sleep(0.05)
    raise RuntimeError(f"timed out waiting for local {destination} stub")


def prove(nginx, root, fixtures):
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        ingress = probe.getsockname()[1]
    upstream = root / "upstream.conf"
    pidfile = root / "nginx.pid"
    cmd = [nginx, "-p", str(root), "-c", "nginx.conf"]
    drain = [sys.executable, str(Path(__file__).with_name("drain.py")), "--pid-file", str(pidfile)]
    (root / "nginx.conf").write_text(
        f"daemon off; master_process on; worker_processes 1; pid {pidfile};\n"
        f"error_log {root}/error.log notice; events {{ worker_connections 64; }}\n"
        f"http {{ access_log off; include {upstream}; server {{ listen 127.0.0.1:{ingress}; "
        "location / { proxy_pass http://candidate; proxy_next_upstream off; } } }\n"
    )

    def set_route(target):
        pending = upstream.with_suffix(".tmp")
        port = fixtures[target][0].server_port
        pending.write_text(f"upstream candidate {{ server 127.0.0.1:{port}; }}\n")
        pending.replace(upstream)
        subprocess.run([*cmd, "-t"], check=True, capture_output=True, timeout=5)

    set_route("blue")
    with (root / "process.log").open("w") as logger, ThreadPoolExecutor(max_workers=2) as pool:
        master = subprocess.Popen(cmd, stdout=logger, stderr=logger)
        try:
            wait_route(ingress, "blue")
            assert int(pidfile.read_text().strip()) == master.pid
            receipts = []
            for old, new in (("blue", "green"), ("green", "blue")):
                _, started, release, _ = fixtures[old]
                in_flight = pool.submit(request, ingress, "/held")
                if not started.wait(5):
                    raise AssertionError("old upstream did not receive the held request")
                snapshot = root / f"{old}.json"
                before = subprocess.check_output([*drain, "snapshot"], timeout=5)
                snapshot.write_bytes(before)
                set_route(new)
                begin = time.monotonic()
                master.send_signal(signal.SIGHUP)
                wait_route(ingress, new)
                route_ms = round((time.monotonic() - begin) * 1000)
                for _ in range(8):
                    assert request(ingress) == (200, new), "fresh request returned old upstream"
                assert not in_flight.done(), "old request already terminated"
                refused = subprocess.run([*drain, "wait", str(snapshot), "--timeout-seconds", "0.5"],
                                         capture_output=True, text=True, timeout=5)
                assert refused.returncode == 1 and "drain deadline reached" in refused.stderr, refused
                assert not in_flight.done(), "held request stopped before caller released it"
                release.set()
                assert in_flight.result(5) == (200, old), "old in-flight request did not finish"
                result = subprocess.check_output(
                    [*drain, "wait", str(snapshot), "--timeout-seconds", "6"], timeout=8)
                assert request(ingress) == (200, new)
                assert request(fixtures[old][0].server_port) == (200, old), "previous backend was stopped"
                receipts.append({"from": old, "to": new, "first_new_route_ms": route_ms,
                                 "fresh_requests_to_new_while_old_held": 8, "old_held_status": 200,
                                 "refused_early_retire": True, **json.loads(result)})
            # An inverse is also safe while the previous forward generation is still held.
            holds = {}
            for color in ("blue", "green"):
                _, started, release, _ = fixtures[color]
                started.clear()
                release.clear()
                holds[color] = pool.submit(request, ingress, "/held")
                assert started.wait(5), "expected upstream did not receive the held request"
                if color == "blue":
                    set_route("green")
                    master.send_signal(signal.SIGHUP)
                    wait_route(ingress, "green")
            assert all(not future.done() for future in holds.values())
            snapshot = root / "early-inverse.json"
            before = subprocess.check_output([*drain, "snapshot"], timeout=5)
            snapshot.write_bytes(before)
            assert sorted(json.loads(before)["workers"].values()) == [False, True], before
            set_route("blue")
            master.send_signal(signal.SIGHUP)
            wait_route(ingress, "blue")
            for _ in range(8):
                assert request(ingress) == (200, "blue")
            # Keep the first generation held after finishing the just-replaced generation.
            fixtures["green"][2].set()
            assert holds["green"].result(5) == (200, "green")
            premature = subprocess.run([*drain, "wait", str(snapshot), "--timeout-seconds", "0.5"],
                                       capture_output=True, text=True, timeout=5)
            assert premature.returncode == 1 and "drain deadline reached" in premature.stderr
            fixtures["blue"][2].set()
            assert holds["blue"].result(5) == (200, "blue")
            result = subprocess.check_output([*drain, "wait", str(snapshot), "--timeout-seconds", "6"],
                                             timeout=8)
            receipts.append({"early_inverse": True, "both_held_status": 200,
                             "fresh_requests_to_returned_blue": 8, **json.loads(result)})
            return receipts
        finally:
            for _, _, release, _ in fixtures.values():
                release.set()
            master.send_signal(signal.SIGQUIT)
            try:
                master.wait(timeout=4)
            except subprocess.TimeoutExpired:
                master.kill()
                master.wait()


def main():
    if len(sys.argv) != 2:
        raise SystemExit("usage: test_drain.py /absolute/path/to/nginx")
    nginx = str(Path(sys.argv[1]).resolve(strict=True))
    version = subprocess.run([nginx, "-v"], check=True, text=True, capture_output=True).stderr.strip()
    fixtures = {label: fixture(label) for label in ("blue", "green")}
    try:
        with tempfile.TemporaryDirectory(prefix="ddc-nginx-drain-") as temp:
            stages = prove(nginx, Path(temp), fixtures)
        print(json.dumps({"nginx": version, "platform": sys.platform, "stages": stages}, indent=2))
    finally:
        for server, _, release, service in fixtures.values():
            release.set()
            server.shutdown()
            server.server_close()
            service.join(timeout=2)


if __name__ == "__main__":
    main()
