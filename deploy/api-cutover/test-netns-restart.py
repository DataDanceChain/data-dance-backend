#!/usr/bin/env python3
"""Extra local-only namespace OUTPUT and service lifecycle checks; no host rule edits."""

import http.client
import importlib.util
import json
from pathlib import Path
import re
import socket
import subprocess
import sys
import tempfile
import time
import uuid

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("fixture", HERE / "test-netns-transport.py")
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)

RULES = """
table ip ddc_restart_fixture {
  chain prerouting {
    type nat hook prerouting priority -100; policy accept;
    iifname "eth0" tcp dport 3000 tcp flags & (fin | syn | rst | ack) == syn redirect to :3001
  }
  chain output {
    type nat hook output priority -100; policy accept;
    ip saddr 127.0.0.2 ip daddr 127.0.0.1 tcp dport 3000 return
    fib daddr type local tcp dport 3000 tcp flags & (fin | syn | rst | ack) == syn redirect to :3001
  }
  chain input {
    type filter hook input priority -5; policy accept;
    iifname != "lo" tcp dport 3001 ct status dnat accept
    iifname != "lo" tcp dport 3001 drop
  }
}
"""
API = fixture.API.replace("const server=", "app.post('/fixture-stop',(r,s)=>{s.end('STOP');setTimeout(()=>process.exit(42),20)});const server=")
INTERNAL = """
const http=require('node:http');
const [host,localAddress,path='/who',method='GET']=process.argv.slice(1);
const request=http.request({host,port:3000,localAddress,agent:false,path,method},res=>{
  res.resume();res.on('end',()=>console.log(res.headers['x-fixture-observer']==='1'));
});
request.on('error',()=>process.exitCode=2);request.setTimeout(2000,()=>request.destroy());
request.end();
"""
NAMES = ["email-code", "email-bind", "oauth"]


def wait_for(predicate, seconds=18):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        answer = predicate()
        if answer:
            return answer
        time.sleep(.15)
    raise AssertionError("Fixture readiness deadline")


def check(apks):
    docker = fixture.docker
    test_id = "ddc-netns-restart-" + uuid.uuid4().hex[:9]
    network = test_id + "-bridge"
    containers, report = [], {}
    docker("network", "create", "--driver", "bridge", network)
    try:
        def run(role, opts, image, cmd):
            name = test_id + "-" + role
            docker("create", "--pull", "never", "--name", name, *opts, image, *cmd)
            containers.append(name)
            docker("start", name)
            return name

        def read(name, query):
            return docker("inspect", "-f", query, name).stdout.strip()

        # A fixed published port is the operational shape. An automatically assigned
        # host port can be changed by Docker on restart and hide the stale backend.
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            fixed_port = reservation.getsockname()[1]
        old = run("legacy", ["--platform", "linux/amd64", "--network", network, "--restart", "always",
                             "-p", f"127.0.0.1:{fixed_port}:3000", "--entrypoint", "node"], fixture.LEGACY,
                  ["-e", API, "blue", "3000"])
        port_record = docker("port", old, "3000/tcp").stdout.strip()
        assert re.fullmatch(r"127\.0\.0\.1:\d+", port_record)
        port = int(port_record.rsplit(":", 1)[1])
        assert port == fixed_port
        network_ip = read(old, "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}")
        started = read(old, "{{.State.StartedAt}}")
        old_ns = docker("exec", old, "readlink", "/proc/self/ns/net").stdout.strip()

        def host(path="/who", method="GET"):
            con = http.client.HTTPConnection("127.0.0.1", port, timeout=1)
            try:
                con.request(method, path, headers={"Connection": "close"})
                with con.getresponse() as response:
                    response.read()
                    return (response.status, response.headers.get("x-fixture-observer") == "1")
            except (OSError, http.client.HTTPException):
                return None
            finally:
                con.close()

        wait_for(host)
        ctl = run("nft", ["--network", f"container:{old}", "--cap-drop", "ALL", "--cap-add", "NET_ADMIN",
                          "--security-opt", "no-new-privileges", "-v", f"{apks}:/apks:ro"], fixture.TOOLS,
                  ["sh", "-ec", "apk add --no-network /apks/*.apk >/tmp/nft-install 2>&1; sleep 90"])
        observer = run("observer", ["--platform", "linux/amd64", "--network", f"container:{old}",
                                    "--entrypoint", "node", "-v", f"{HERE}:/fixture:ro"], fixture.LEGACY,
                       ["/fixture/netns-observer-fixture.cjs"])
        wait_for(lambda: docker("exec", ctl, "nft", "list", "tables", check=False).returncode == 0)
        docker("exec", "-i", ctl, "nft", "-c", "-f", "-", data=RULES)
        docker("exec", "-i", ctl, "nft", "-f", "-", data=RULES)
        wait_for(lambda: host() == (200, True))

        def inside(dst, src, *request):
            return docker("exec", observer, "node", "-e", INTERNAL, dst, src, *request).stdout.strip()

        assert inside("127.0.0.1", "127.0.0.1") == "true"
        assert inside(network_ip, network_ip) == "true"
        assert inside("127.0.0.1", "127.0.0.2") == "false"
        report["namespace_output_local_destinations_observed_only_dedicated_pair_exempt"] = True
        assert read(old, "{{.State.StartedAt}}") == started
        report["rules_installed_without_restarting_legacy"] = True

        with tempfile.TemporaryDirectory() as owner:
            journal = HERE / "first-handoff-journal.js"
            subprocess.run(["node", "-e", """const j=require(process.argv[1]).openJournal(process.argv[2],
process.argv.slice(3));if(!j.commit('email-code'))process.exit(1);j.release()""",
                            str(journal), owner, *NAMES], check=True)
            owners = Path(owner, "owners.json")
            before = owners.read_bytes()
            assert json.loads(before)["email-code"]["owner"] == "shared"
            # Wait beyond the restart policy's documented activation interval.
            time.sleep(11)
            assert inside("127.0.0.1", "127.0.0.2", "/fixture-stop", "POST") == "false"
            # The unsafe baseline is isolated: stale fixture restarts without its namespace rules.
            wait_for(lambda: read(old, "{{.State.StartedAt}}") != started and host() == (200, False))
            assert docker("exec", old, "readlink", "/proc/self/ns/net").stdout.strip() != old_ns
            assert docker("exec", ctl, "readlink", "/proc/self/ns/net").stdout.strip() == old_ns
            assert owners.read_bytes() == before
            report["unsafe_restart_admitted_legacy_despite_durable_shared_owner"] = True
            # Scope the existing Docker control to this fixture service only.
            docker("update", "--restart", "no", old)
            assert read(old, "{{.HostConfig.RestartPolicy.Name}}") == "no"
            started = read(old, "{{.State.StartedAt}}")
            time.sleep(11)
            assert host("/fixture-stop", "POST") == (200, False)
            wait_for(lambda: read(old, "{{.State.Status}}") == "exited")
            time.sleep(2)
            assert read(old, "{{.State.StartedAt}}") == started
            assert read(old, "{{.State.ExitCode}}") == "42"
            assert host() is None and owners.read_bytes() == before
            report["service_restart_disabled_kept_api_closed_without_erasing_owner"] = True
    finally:
        for item in reversed(containers):
            docker("rm", "-f", item, check=False)
        docker("network", "rm", network)
        assert all(docker("container", "inspect", x, check=False).returncode != 0 for x in containers)
    return {**report, "fixture_removed": True}


if __name__ == "__main__":
    directory = Path(sys.argv[1]).resolve(strict=True)
    if not list(directory.glob("nftables-*.apk")):
        raise SystemExit("Cached tool bundle required")
    print(json.dumps(check(directory), sort_keys=True))
