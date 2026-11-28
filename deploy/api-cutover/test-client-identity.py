#!/usr/bin/env python3
"""Verify the production-shaped IP-key hop chain and inverse on private Docker."""

import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import uuid


NODE = "node:22-alpine"
NGINX = "nginx:1.18"
HOSTS = ("api.example.test", "api-rehearsal.example.test")
STAGES = ("production", "rehearsal")


def docker(*args, check=True):
    return subprocess.run(["docker", *args], check=check, text=True,
                          capture_output=True, timeout=15).stdout.strip()


def config(target):
    servers = "".join(f"""
      server {{
        listen 8080;
        server_name {host};
        location / {{
          proxy_http_version 1.1;
          proxy_set_header Host $host;
          proxy_set_header Upgrade $http_upgrade;
          proxy_set_header Connection $connection_upgrade;
          proxy_pass http://{target}-origin:3000;
        }}
      }}""" for host in HOSTS)
    return f"""events {{ worker_connections 64; }}
http {{
  access_log off;
  map $http_upgrade $connection_upgrade {{ default upgrade; '' close; }}
  {servers}
}}
"""


def exercise():
    prefix = f"ddc-identity-{uuid.uuid4().hex[:9]}"
    files = Path(__file__).resolve().parent
    dependencies = files.parents[1] / "node_modules"
    networks, containers = [], []
    result = {}
    stage = "prepare"
    try:
        with tempfile.TemporaryDirectory(prefix=prefix + "-") as root_path:
            root = Path(root_path)
            entry = root / "nginx.conf"
            entry.write_text(config("blue"))
            for role in ("front", "mid", "back"):
                name = f"{prefix}-{role}"
                docker("network", "create", "--internal", name)
                networks.append(name)
            front, mid, back = networks
            result["networks_internal_only"] = all(
                docker("network", "inspect", "-f", "{{.Internal}}", n) == "true" for n in networks)
            assert result["networks_internal_only"]

            def create(role, network, alias, image=NODE, extra=(), command=()):
                name = f"{prefix}-{role}"
                docker("create", "--pull", "never", "--name", name, "--network", network,
                       "--network-alias", alias, *extra, image, *command)
                containers.append(name)
                return name

            node_mounts = ("-v", f"{files}:/fixture:ro", "-v", f"{root}:/lab:ro",
                           "-v", f"{dependencies.resolve()}:/deps:ro", "-e", "NODE_PATH=/deps")
            fixture = "/fixture/client-identity-fixture.cjs"
            stage = "origin-start"
            old = create("blue", back, "blue-origin", extra=node_mounts,
                         command=("node", fixture, "origin", "blue"))
            new = create("green", back, "green-origin", extra=node_mounts,
                         command=("node", fixture, "origin", "green"))
            client = create("client", front, "identity-client", extra=node_mounts,
                            command=("sleep", "120"))
            backprobe = create("backprobe", back, "identity-backprobe", extra=node_mounts,
                               command=("sleep", "120"))
            docker("start", old, new, client, backprobe)
            stage = "gateway-start"
            nginx = create("gateway", mid, "identity-gateway", NGINX,
                           ("--platform", "linux/amd64", "-v", f"{root}:/lab:ro"),
                           ("nginx", "-c", "/lab/nginx.conf", "-g", "daemon off;"))
            docker("network", "connect", "--alias", "identity-gateway", back, nginx)
            docker("start", nginx)
            edge = create("edge", front, "identity-edge", extra=node_mounts,
                          command=("node", fixture, "edge"))
            docker("network", "connect", mid, edge)
            docker("start", edge)
            local_net = set(networks)
            details = json.loads(docker("inspect", *containers))
            result["fixture_ports_not_published"] = all(
                not d["HostConfig"]["PortBindings"]
                and set(d["NetworkSettings"]["Networks"]) <= local_net for d in details)
            assert result["fixture_ports_not_published"]

            def request(source, target):
                return json.loads(docker("exec", source, "node", fixture, "request", target))

            def through(alias):
                return request(client, "http://identity-edge:4000/" + alias)

            def expect_target(target):
                deadline = time.monotonic() + 9
                while time.monotonic() < deadline:
                    samples = [through(alias) for alias in STAGES]
                    if all(s["status"] == 200 and s["payload"]["target"] == target for s in samples):
                        return [s["payload"] for s in samples]
                    time.sleep(0.15)
                raise AssertionError("both aliases failed to reach the expected target")

            def switch(content):
                pending = root / "next.conf"
                pending.write_text(content)
                pending.replace(entry)
                docker("exec", nginx, "nginx", "-t", "-c", "/lab/nginx.conf")
                docker("exec", nginx, "nginx", "-s", "reload", "-c", "/lab/nginx.conf")

            stage = "old-route"
            before = expect_target("blue")
            old_start = docker("inspect", "-f", "{{.State.StartedAt}}", old)
            baseline = entry.read_text()
            stage = "direct-negative"
            unaffiliated = request(client, "http://blue-origin:3000/key")
            same_network = request(backprobe, "http://blue-origin:3000/key")
            result["unaffiliated_client_direct_rejected_by_network"] = unaffiliated["status"] == 0
            result["unguarded_same_network_bypass_present"] = (
                same_network["status"] == 200 and not same_network["payload"]["forwarded"]
                and same_network["payload"]["key"] != before[0]["key"])
            assert result["unaffiliated_client_direct_rejected_by_network"]
            assert result["unguarded_same_network_bypass_present"]
            (root / "origin-guard-on").touch()
            def direct_denied():
                codes = [request(backprobe, f"http://{color}-origin:3000/key")["status"]
                         for color in ("blue", "green")]
                return codes == [403, 403]

            result["guarded_same_network_bypass_denied_on_both_origins"] = direct_denied()
            assert result["guarded_same_network_bypass_denied_on_both_origins"]
            guarded_blue = expect_target("blue")

            stage = "forward"
            switch(config("green"))
            forward = expect_target("green")
            result["same_network_direct_also_denied_after_forward"] = direct_denied()
            stage = "rollback"
            switch(baseline)
            reverse = expect_target("blue")
            result["same_network_direct_also_denied_after_rollback"] = direct_denied()
            after = docker("inspect", "-f", "{{.State.StartedAt}}", old)

            for index, alias in enumerate(STAGES):
                records = [samples[index] for samples in (before, guarded_blue, forward, reverse)]
                result[alias + "_same_limit_key_forward_and_rollback"] = (
                    len({m["key"] for m in records}) == 1
                    and all(m["matchesObservedClient"] and m["forwarded"] for m in records))
            result["both_aliases_same_limit_key"] = len(
                {m["key"] for samples in (before, guarded_blue, forward, reverse) for m in samples}) == 1
            result["rollback_restored_original_route_bytes"] = entry.read_text() == baseline
            result["old_origin_not_restarted"] = old_start == after
            assert all(result.values())
    except (OSError, ValueError, subprocess.SubprocessError, AssertionError):
        result.update({"passed": False, "failed_phase": stage})
    else:
        result["passed"] = True
    finally:
        if containers:
            docker("rm", "-f", *reversed(containers), check=False)
        if networks:
            docker("network", "rm", *reversed(networks), check=False)
        remaining_containers = set(docker("ps", "-a", "--format", "{{.Names}}").splitlines())
        remaining_networks = set(docker("network", "ls", "--format", "{{.Name}}").splitlines())
        result["fixture_cleanup_verified"] = (
            not remaining_containers.intersection(containers)
            and not remaining_networks.intersection(networks))
    return result


if __name__ == "__main__":
    result = exercise()
    print(json.dumps(result, indent=2, sort_keys=True))
    sys.exit(0 if result["passed"] and result["fixture_cleanup_verified"] else 1)
