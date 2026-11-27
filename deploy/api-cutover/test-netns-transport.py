#!/usr/bin/env python3
"""Local-only Linux network namespace proof. This is not a deployment controller."""

import argparse
import http.client
import json
from pathlib import Path
import re
import subprocess
import sys
import time
import uuid

TOOLS = "node:22-alpine"
LEGACY = "sha256:8c84b391d5ff78ba6751cf123371a3cb95ffda59cd2401d2d36d3922b729a659"
API = """
const app=require('express')(), crypto=require('node:crypto');
const owner=process.argv[1];let issue=0;
app.set('trust proxy',1);
const state=(r)=>({owner,issue,key:crypto.createHash('sha256').update(r.ip||'anonymous').digest('hex')});
app.get('/who',(r,s)=>s.json(state(r)));
app.post('/issue',(r,s)=>{issue++;s.json(state(r));});
app.get('/hold',(r,s)=>{s.type('text/plain');s.write(owner+':begin\\n');setTimeout(()=>s.end(owner+':end\\n'),3000)});
const server=app.listen(Number(process.argv[2]),'0.0.0.0');
server.keepAliveTimeout=60000;
"""
CLIENT = """
const r=require('node:http').get({host:process.argv[1],port:+process.argv[2],path:'/who',agent:false},s=>{
  let b='';s.on('data',x=>b+=x);s.on('end',()=>{
    clearTimeout(deadline);console.log(JSON.stringify({...JSON.parse(b), observed:s.headers['x-fixture-observer']==='1'}));
  });
});
const deadline=setTimeout(()=>r.destroy(new Error('fixture request deadline')),1200);
r.on('error',()=>{clearTimeout(deadline);process.exitCode=2;});
"""
PROTECT = """
table ip ddc_fixture_private {
  chain input {
    type filter hook input priority -5; policy accept;
    iifname != "lo" tcp dport 3001 ct status dnat accept
    iifname != "lo" tcp dport 3001 drop
  }
}
"""
REDIRECT = """
table ip ddc_fixture_switch {
  chain prerouting {
    type nat hook prerouting priority -100; policy accept;
    iifname "eth0" tcp dport 3000 tcp flags & (fin | syn | rst | ack) == syn counter redirect to :3001
  }
  chain postrouting { type nat hook postrouting priority 100; policy accept; }
}
"""


def docker(*args, data=None, check=True):
    return subprocess.run(["docker", *args], input=data, text=True, capture_output=True,
                          check=check, timeout=25)


def test(apks, observer):
    prefix = f"ddc-netns-{uuid.uuid4().hex[:10]}"
    net = prefix + "-network"
    containers = []
    retained = []
    result = {}
    stage = "prepare"
    try:
        docker("image", "inspect", LEGACY)
        # A disposable bridge mirrors existing Docker loopback port publishing.
        # No outside traffic is emitted. The only published socket is host loopback.
        docker("network", "create", "--driver", "bridge", net)

        def run(role, options, image, command=()):
            name = f"{prefix}-{role}"
            docker("create", "--pull", "never", "--name", name, *options, image, *command)
            containers.append(name)
            docker("start", name)
            return name

        old = run("old", ["--platform", "linux/amd64", "--network", net, "--network-alias",
                          "ddc-old", "-p", "127.0.0.1::3000", "--entrypoint", "node"],
                  LEGACY, ("-e", API, "blue", "3000"))
        bridge = run("observer", ["--network", net], TOOLS, ("sleep", "120"))
        publication = docker("port", old, "3000/tcp").stdout.strip()
        assert re.fullmatch(r"127\.0\.0\.1:\d+", publication)
        published = int(publication.rsplit(":", 1)[1])
        before_start = docker("inspect", "-f", "{{.State.StartedAt}}", old).stdout

        stage = "private-sidecar"
        ctl = run("nft-fixture", ["--network", f"container:{old}", "--cap-drop", "ALL",
                                 "--cap-add", "NET_ADMIN", "--security-opt", "no-new-privileges",
                                 "-v", f"{apks}:/apk-input:ro"],
                  TOOLS, ("sh", "-ec", "apk add --no-network /apk-input/*.apk >/tmp/nft-install.log 2>&1; sleep 120"))

        def rule(text):
            docker("exec", "-i", ctl, "nft", "-c", "-f", "-", data=text)
            docker("exec", "-i", ctl, "nft", "-f", "-", data=text)

        def bridge_call(port=3000):
            response = docker("exec", bridge, "node", "-e", CLIENT, "ddc-old", str(port), check=False)
            return json.loads(response.stdout) if response.returncode == 0 else None

        for _ in range(30):
            if docker("exec", ctl, "nft", "list", "tables", check=False).returncode == 0:
                break
            time.sleep(0.15)
        rule(PROTECT)
        green_options = ["--platform", "linux/amd64", "--network", f"container:{old}",
                         "--entrypoint", "node"]
        if observer:
            fixture = Path(__file__).resolve().parent
            green_options += ["-v", f"{fixture}:/fixture:ro"]
            green_command = ("/fixture/netns-observer-fixture.cjs",)
        else:
            green_command = ("-e", API, "green", "3001")
        green = run("green", green_options, LEGACY, green_command)

        def new_host():
            c = http.client.HTTPConnection("127.0.0.1", published, timeout=6)
            retained.append(c)
            return c

        def json_request(conn, path="/who", method="GET", headers=None):
            conn.request(method, path, headers=headers or {})
            r = conn.getresponse()
            assert r.status == 200
            return {**json.loads(r.read()), "observed": r.headers.get("X-Fixture-Observer") == "1"}

        def fresh_host():
            c = new_host()
            try:
                return json_request(c)
            finally:
                c.close()

        stage = "baseline"
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            old_bridge = bridge_call()
            direct_ready = docker("exec", green, "node", "-e", CLIENT, "127.0.0.1", "3001",
                                  check=False)
            if old_bridge and direct_ready.returncode == 0:
                break
            time.sleep(0.15)
        startup = json.loads(direct_ready.stdout)
        assert old_bridge["owner"] == "blue"
        assert (startup["owner"], startup["observed"]) == (("blue", True) if observer else ("green", False))
        old_host = fresh_host()
        keep_blue = new_host()
        first = json_request(keep_blue, "/issue", "POST")
        hold_blue = new_host()
        hold_blue.request("GET", "/hold")
        blue_response = hold_blue.getresponse()
        assert blue_response.readline() == b"blue:begin\n"

        stage = "forward"
        rule(REDIRECT)
        new_host_response, new_bridge_response = fresh_host(), bridge_call()
        if observer:
            def control(route):
                code = (
                    "const r=require('node:http').get('http://127.0.0.1:3999/'+process.argv[1],"
                    "s=>{if(s.statusCode!==200){process.exitCode=2;return;}s.pipe(process.stdout)});"
                    "r.setTimeout(2000,()=>r.destroy());r.on('error',()=>process.exitCode=2);"
                )
                return json.loads(docker("exec", green, "node", "-e", code, route).stdout)

            result["fresh_paths_enter_observer_but_still_reach_legacy"] = all(
                m["owner"] == "blue" and m["observed"] for m in (new_host_response, new_bridge_response))
            result["fresh_client_keys_unchanged"] = (
                old_host["key"] == new_host_response["key"]
                and old_bridge["key"] == new_bridge_response["key"])
            assert control("transport-checked")["transportChecked"]
            refused = control("start-observation")
            result["retained_direct_connection_blocks_first_handoff"] = (
                refused["originalDirectStillAlive"] and not refused["observationStarted"]
                and refused["dedicatedLegacyPathAlive"])
            result["in_flight_old_request_completed_without_reset"] = blue_response.read() == b"blue:end\n"
            late = json_request(keep_blue, "/issue", "POST", headers={"Connection": "close"})
            result["retained_old_connection_can_issue_and_complete_before_observing"] = (
                late["issue"] == first["issue"] + 1 and late["owner"] == "blue" and not late["observed"])
            assert json_request(hold_blue, headers={"Connection": "close"})["owner"] == "blue"
            # The real client closes both connections with successful HTTP
            # responses. The observer-to-legacy keep-alive should remain live.
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                admitted = control("start-observation")
                if admitted["observationStarted"]:
                    break
                time.sleep(0.1)
            result["natural_close_allows_real_first_handoff_observation"] = (
                admitted["observationStarted"] and not admitted["originalDirectStillAlive"]
                and admitted["dedicatedLegacyPathAlive"])
            observed = new_host()
            seen = json_request(observed, "/issue", "POST")
            result["after_observation_known_old_route_still_owns_mutation"] = (
                seen["owner"] == "blue" and seen["observed"] and seen["key"] == old_host["key"])
            stage = "observer-inverse"
            result["observation_clock_invalidated_before_inverse"] = not control("invalidate")["observationStarted"]
            rule("flush chain ip ddc_fixture_switch prerouting\n")
            reverted_host, reverted_bridge = fresh_host(), bridge_call()
            result["new_connections_rollback_to_unmodified_legacy_keys"] = (
                reverted_host["owner"] == reverted_bridge["owner"] == "blue"
                and not reverted_host["observed"] and not reverted_bridge["observed"]
                and reverted_host["key"] == old_host["key"] and reverted_bridge["key"] == old_bridge["key"])
            still_connected = json_request(observed)
            result["retained_observer_connection_finishes_after_inverse"] = (
                still_connected["owner"] == "blue" and still_connected["observed"])
            result["old_process_not_restarted"] = (
                before_start == docker("inspect", "-f", "{{.State.StartedAt}}", old).stdout)
            result["transport_checks_passed"] = all(result.values())
            return result

        result["new_connections_on_both_existing_endpoints_reach_green"] = (
            new_host_response["owner"] == new_bridge_response["owner"] == "green")
        result["fresh_client_keys_unchanged"] = (
            old_host["key"] == new_host_response["key"]
            and old_bridge["key"] == new_bridge_response["key"])
        result["existing_blue_in_flight_completed_at_blue"] = blue_response.read() == b"blue:end\n"
        late = json_request(keep_blue, "/issue", "POST")
        result["old_keepalive_can_still_issue_after_transport_cutover"] = (
            late["owner"] == "blue" and late["issue"] == first["issue"]+1 and late["key"] == first["key"])
        result["candidate_port_not_directly_reachable_during_cutover"] = bridge_call(3001) is None

        stage = "rollback"
        keep_green = new_host()
        assert json_request(keep_green)["owner"] == "green"
        hold_green = new_host()
        hold_green.request("GET", "/hold")
        green_response = hold_green.getresponse()
        assert green_response.readline() == b"green:begin\n"
        # Keep the NAT hooks installed for established green flows during reverse drain.
        rule("flush chain ip ddc_fixture_switch prerouting\n")
        reversed_host, reversed_bridge = fresh_host(), bridge_call()
        result["new_connections_revert_to_blue_with_original_keys"] = (
            reversed_host["owner"] == reversed_bridge["owner"] == "blue"
            and reversed_host["key"] == old_host["key"] and reversed_bridge["key"] == old_bridge["key"])
        result["existing_green_in_flight_completed_at_green"] = green_response.read() == b"green:end\n"
        result["green_keepalive_retains_its_owner_after_inverse"] = json_request(keep_green)["owner"] == "green"
        result["candidate_port_not_directly_reachable_after_inverse"] = bridge_call(3001) is None
        result["old_process_not_restarted"] = (
            before_start == docker("inspect", "-f", "{{.State.StartedAt}}", old).stdout)
        result["transport_checks_passed"] = all(result.values())
    except (OSError, TypeError, ValueError, AssertionError, subprocess.SubprocessError):
        result.update({"transport_checks_passed": False, "failed_phase": stage})
    finally:
        for conn in retained:
            conn.close()
        if containers:
            docker("rm", "-f", *reversed(containers), check=False)
        docker("network", "rm", net, check=False)
        live = set(docker("ps", "-a", "--format", "{{.Names}}").stdout.splitlines())
        networks = set(docker("network", "ls", "--format", "{{.Name}}").stdout.splitlines())
        result["local_fixture_removed"] = not live.intersection(containers) and net not in networks
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("verified_alpine_apks", type=Path)
    parser.add_argument("--observer", action="store_true", help="prove the first-handoff observation barrier")
    args = parser.parse_args()
    root = args.verified_alpine_apks.resolve(strict=True)
    if not root.is_dir() or not list(root.glob("nftables-*.apk")):
        raise SystemExit("Expected a directory of Alpine package artifacts for the cached Node tool image")
    outcome = test(root, args.observer)
    print(json.dumps(outcome, indent=2, sort_keys=True))
    sys.exit(0 if outcome["transport_checks_passed"] and outcome["local_fixture_removed"] else 1)
