#!/usr/bin/env python3
"""API-only Compose recovery contract exercised against a synthetic isolated service."""

import hashlib
import http.client
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import uuid

HERE = Path(__file__).resolve().parent
LEGACY = "sha256:8c84b391d5ff78ba6751cf123371a3cb95ffda59cd2401d2d36d3922b729a659"
RECOVERY = "sha256:2cc6eb9437ae91c59122608d6931732ff62076c802c65bad9582287c893940ec"
FAMILIES = ["email-code", "email-bind", "oauth"]
GATE = """
const fs=require('node:fs'),crypto=require('node:crypto'),http=require('node:http');
const ns=fs.readlinkSync('/proc/self/ns/net'), nonce=crypto.randomUUID();
fs.writeFileSync('/tmp/fixture-boot', JSON.stringify({ns,nonce}), { mode:0o600 });
const poll=setInterval(()=>{
  try {
    const body=fs.readFileSync('/policy/owners.json');
    const owners=JSON.parse(body);
    if(Object.keys(owners).sort().join(',')!=='email-bind,email-code,oauth' ||
       Object.values(owners).some(x=>!['legacy','shared'].includes(x.owner) || x.pending || x.unknown))return;
    const shared=Object.values(owners).some(x=>x.owner==='shared');
    const lease=JSON.parse(fs.readFileSync('/policy/launch.json'));
    const ownerDigest=crypto.createHash('sha256').update(body).digest('hex');
    const mode=shared?'shared':'legacy';
    if(lease.ns!==ns || lease.nonce!==nonce || lease.ownerDigest!==ownerDigest || lease.mode!==mode ||
       lease.actualImage!==process.env.FIXTURE_IMAGE ||
       process.env.FIXTURE_IMAGE!==(shared?process.env.RECOVERY_PIN:process.env.LEGACY_PIN))return;
    clearInterval(poll);
    http.createServer((q,s)=>{
      if(q.url==='/hold'){s.writeHead(200);s.write('hold');setTimeout(()=>s.end('-completed'),1500)}
      else s.end(mode);
    }).listen(3010,'0.0.0.0');
  }catch{}
},50);
"""
# The fixture serves only a synthetic API from a private test port. The host
# publication still terminates at :3000 and cannot start before this rule exists.
RULE = """
table ip ddc_recovery_fixture {
 chain route { type nat hook prerouting priority -100; policy accept;
  iifname "eth0" tcp dport 3000 tcp flags & (fin | syn | rst | ack) == syn redirect to :3010
 }
 chain private { type filter hook input priority -5; policy accept;
  iifname != "lo" tcp dport 3010 ct status dnat accept
  iifname != "lo" tcp dport 3010 drop
 }
}
"""
PAUSE = """
table ip ddc_recovery_pause_fixture {
 chain close_new { type filter hook prerouting priority -150; policy accept;
  iifname "eth0" tcp dport 3000 tcp flags & (fin | syn | rst | ack) == syn drop
 }
}
"""


def command(*words, env=None, data=None, check=True):
    return subprocess.run(words, env=env, input=data, text=True,
                          capture_output=True, check=check, timeout=30)


def wait_for(check, seconds=12):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        result = check()
        if result:
            return result
        time.sleep(.12)
    raise AssertionError("Fixture deadline")


def check(apks):
    name = "ddcrecovery" + uuid.uuid4().hex[:10]
    with tempfile.TemporaryDirectory(prefix="ddc-recovery-contract-") as scratch:
        work = Path(scratch).resolve()
        policy = work / "policy"
        policy.mkdir(mode=0o700)
        guard = work / "gate.js"
        guard.write_text(GATE)
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        compose = work / "compose.json"
        services = {role: {"image": "node:22-alpine", "command": ["sleep", "180"], "pull_policy": "never"}
                    for role in ("db", "web")}
        services["api"] = {
            "image": "${FIXTURE_IMAGE}", "platform": "linux/amd64", "pull_policy": "never",
            "entrypoint": ["node", "/fixture/gate.js"], "restart": "no",
            "ports": [f"127.0.0.1:{port}:3000"],
            "volumes": [f"{guard}:/fixture/gate.js:ro", f"{policy}:/policy:ro"],
            "environment": {"FIXTURE_IMAGE": "${FIXTURE_IMAGE}", "LEGACY_PIN": LEGACY, "RECOVERY_PIN": RECOVERY},
        }
        compose.write_text(json.dumps({"services": services}))
        base = ("docker", "compose", "-f", str(compose), "-p", name)
        env = dict(os.environ, FIXTURE_IMAGE=LEGACY)
        helper = name + "-nft"
        owners = policy / "owners.json"
        startup_receipt = policy / "launch.json"

        def dc(*args, **kw):
            return command(*base, *args, env=env, **kw)

        def docker(*args, **kw):
            return command("docker", *args, **kw)

        def raw_owner(shared=False):
            src = """const j=require(process.argv[1]).openJournal(process.argv[2],process.argv.slice(4));
if(process.argv[3]==='shared'&&!j.commit('email-code'))process.exit(1);j.release()"""
            command("node", "-e", src, str(HERE / "first-handoff-journal.js"),
                    str(policy), "shared" if shared else "legacy", *FAMILIES)

        def address():
            return http.client.HTTPConnection("127.0.0.1", port, timeout=.25)

        def request():
            client = address()
            try:
                client.request("GET", "/")
                return client.getresponse().read().decode()
            except (OSError, http.client.HTTPException):
                return None
            finally:
                client.close()

        def identity(cid, field):
            return docker("inspect", "-f", field, cid).stdout.strip()

        def start():
            docker("rm", "-f", helper, check=False)
            dc("up", "-d", "--force-recreate", "--no-deps", "api")
            cid = dc("ps", "-q", "api").stdout.strip()
            assert cid and identity(cid, "{{.HostConfig.RestartPolicy.Name}}") == "no"
            boot = wait_for(lambda: (lambda x: x.stdout if x.returncode == 0 else None)(
                docker("exec", cid, "cat", "/tmp/fixture-boot", check=False)))
            assert request() is None
            return cid, json.loads(boot)

        def nft(text):
            docker("exec", "-i", helper, "nft", "-c", "-f", "-", data=text)
            docker("exec", "-i", helper, "nft", "-f", "-", data=text)

        def rebuild_rules(cid):
            docker("run", "-d", "--pull", "never", "--name", helper, "--network", f"container:{cid}",
                   "--cap-drop", "ALL", "--cap-add", "NET_ADMIN", "--security-opt", "no-new-privileges",
                   "-v", f"{apks}:/input:ro", "node:22-alpine", "sh", "-ec",
                   "apk add --no-network /input/*.apk >/tmp/nft-install 2>&1; sleep 90")
            wait_for(lambda: docker("exec", helper, "nft", "list", "tables", check=False).returncode == 0)
            nft(RULE)
            assert request() is None

        def authorize(cid, boot):
            document = owners.read_bytes()
            state = json.loads(document)
            shared = any(x["owner"] == "shared" for x in state.values())
            image = identity(cid, "{{.Image}}")
            assert set(state) == set(FAMILIES)
            if image != (RECOVERY if shared else LEGACY):
                return False
            assert identity(cid, "{{.HostConfig.RestartPolicy.Name}}") == "no"
            active_ns = docker("exec", helper, "readlink", "/proc/self/ns/net").stdout.strip()
            assert boot["ns"] == active_ns
            rules = docker("exec", helper, "nft", "list", "table", "ip", "ddc_recovery_fixture").stdout
            assert "redirect to :3010" in rules
            stamp = {**boot, "ownerDigest": hashlib.sha256(document).hexdigest(), "actualImage": image,
                     "mode": "shared" if shared else "legacy"}
            temporary = startup_receipt.with_suffix(".new")
            temporary.write_text(json.dumps(stamp))
            os.replace(temporary, startup_receipt)
            return True

        report = {}
        try:
            raw_owner()
            dc("up", "-d", "db", "web")
            peers = {p: dc("ps", "-q", p).stdout.strip() for p in ("db", "web")}
            peer_boots = {cid: identity(cid, "{{.State.StartedAt}}") for cid in peers.values()}
            cid, boot = start()
            rebuild_rules(cid)
            assert authorize(cid, boot)
            wait_for(lambda: request() == "legacy")
            # Planned recovery blocks new connections while allowing the active response.
            retained = http.client.HTTPConnection("127.0.0.1", port, timeout=4)
            try:
                retained.request("GET", "/hold")
                active = retained.getresponse()
                assert active.read(4) == b"hold"
                nft(PAUSE)
                assert request() is None
                assert active.read() == b"-completed"
            finally:
                retained.close()
            new_cid, new_boot = start()
            assert new_cid != cid and new_boot["nonce"] != boot["nonce"]
            rebuild_rules(new_cid)
            assert authorize(new_cid, new_boot)
            wait_for(lambda: request() == "legacy")
            report["legacy_owner_same_compose_entry_drains_rebuilds_and_recovers"] = True

            # Shared marker here is a fixture state transition, not a live ownership transfer.
            raw_owner(shared=True)
            wrong_cid, wrong_boot = start()
            rebuild_rules(wrong_cid)
            assert not authorize(wrong_cid, wrong_boot) and request() is None
            report["old_image_compose_force_recreate_cannot_admit_shared_owner"] = True
            env["FIXTURE_IMAGE"] = RECOVERY
            recovered, shared_boot = start()
            rebuild_rules(recovered)
            assert authorize(recovered, shared_boot)
            wait_for(lambda: request() == "shared")
            report["only_compatible_recovery_image_admitted_shared_owner"] = True
            assert peers == {p: dc("ps", "-q", p).stdout.strip() for p in ("db", "web")}
            assert all(identity(cid, "{{.State.StartedAt}}") == value for cid, value in peer_boots.items())
            report["db_web_not_recreated_or_restarted"] = True
        finally:
            docker("rm", "-f", helper, check=False)
            dc("down", "--remove-orphans")
        assert not dc("ps", "-aq").stdout.strip()
    return {**report, "fixture_removed": True}


if __name__ == "__main__":
    print(json.dumps(check(Path(sys.argv[1]).resolve(strict=True)), sort_keys=True))
