#!/usr/bin/env python3
"""Local-only IPv6 loopback proof using the actual first-handoff proxy."""

import importlib.util
import json
from pathlib import Path
import sys
import time
import uuid

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("fixture", HERE / "test-netns-transport.py")
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)

API = """
const app=require('express')();
app.set('trust proxy',1);
app.get('/who',(req,res)=>res.json({exact:req.ip==='::1',observed:req.get('x-forwarded-for')==='::1'}));
app.listen(3000,'::');
"""
PROXY = """
const fs=require('node:fs');
const {createProxy}=require('/fixture/first-handoff-proxy');
const p=createProxy({stateDir:fs.mkdtempSync('/tmp/ddc-v6-'),legacyOrigin:'http://127.0.0.1:3000',
  legacyLocalAddress:'127.0.0.2',sharedOrigin:'http://127.0.0.1:3010'});
p.server.listen(3001,'::1');
"""
CLIENT = """
const http=require('node:http'), connection=new http.Agent({keepAlive:true});
const probe=async()=>await new Promise((ok,bad)=>{
  const req=http.get({host:'::1',port:3000,path:'/who',agent:connection},res=>{
    let body='';res.on('data',x=>body+=x);res.on('end',()=>ok(JSON.parse(body)));
  });
  req.on('error',bad);req.setTimeout(2000,()=>req.destroy());
});
(async()=>{console.log(JSON.stringify(await probe()));if(process.argv[1]==='keep'){
  await new Promise(resolve=>process.stdin.once('data',resolve));
  console.log(JSON.stringify(await probe()));
}connection.destroy();})().catch(()=>{process.exitCode=1});
"""
RULE = """
table ip6 ddc_v6_loopback_fixture {
  chain output {
    type nat hook output priority -100; policy accept;
    ip6 daddr ::1 tcp dport 3000 tcp flags & (fin | syn | rst | ack) == syn redirect to :3001
  }
}
"""


def run(apks):
    import subprocess
    docker = fixture.docker
    prefix = "ddc-loopback6-" + uuid.uuid4().hex[:9]
    containers = []
    retained = None
    try:
        def create(role, image, options, command):
            name = f"{prefix}-{role}"
            docker("create", "--pull", "never", "--name", name, *options, image, *command)
            containers.append(name)
            docker("start", name)
            return name

        node = ["--platform", "linux/amd64", "--entrypoint", "node"]
        old = create("old", fixture.LEGACY, ["--network", "none", *node], ["-e", API])
        nested = ["--network", f"container:{old}"]
        proxy = create("proxy", fixture.LEGACY, [*nested, *node, "-v", f"{HERE}:/fixture:ro"], ["-e", PROXY])
        ctl = create("nft", fixture.TOOLS, [*nested, "--cap-drop", "ALL", "--cap-add", "NET_ADMIN",
                      "--security-opt", "no-new-privileges", "-v", f"{apks}:/input:ro"],
                     ["sh", "-ec", "apk add --no-network /input/*.apk >/tmp/nft-install 2>&1; sleep 90"])
        for _ in range(45):
            result = docker("exec", proxy, "node", "-e", CLIENT, check=False)
            if result.returncode == 0 and docker("exec", ctl, "nft", "list", "tables", check=False).returncode == 0:
                break
            time.sleep(.15)
        else:
            raise AssertionError("Neither unswitched IPv6 API nor namespace tools became ready")
        assert json.loads(result.stdout) == {"exact": True, "observed": False}
        retained = subprocess.Popen(["docker", "exec", "-i", proxy, "node", "-e", CLIENT, "keep"],
                                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        assert json.loads(retained.stdout.readline()) == {"exact": True, "observed": False}
        docker("exec", "-i", ctl, "nft", "-c", "-f", "-", data=RULE)
        docker("exec", "-i", ctl, "nft", "-f", "-", data=RULE)
        assert json.loads(docker("exec", proxy, "node", "-e", CLIENT).stdout) == {"exact": True, "observed": True}
        retained.stdin.write("probe\n")
        retained.stdin.flush()
        assert json.loads(retained.stdout.readline()) == {"exact": True, "observed": False}
        retained.stdin.close()
        assert retained.wait(timeout=5) == 0
        docker("exec", ctl, "nft", "delete", "table", "ip6", "ddc_v6_loopback_fixture")
        assert json.loads(docker("exec", proxy, "node", "-e", CLIENT).stdout) == {"exact": True, "observed": False}
    finally:
        if retained and retained.poll() is None:
            retained.terminate()
            retained.wait(timeout=5)
        for name in reversed(containers):
            docker("rm", "-f", name, check=False)
        assert all(docker("inspect", name, check=False).returncode for name in containers)
    return {"new_ipv6_loopback_uses_actual_proxy": True, "exact_express_req_ip_unchanged": True,
            "existing_ipv6_keepalive_stays_direct_until_close": True, "ipv6_inverse_restored": True,
            "fixture_removed": True}


if __name__ == "__main__":
    print(json.dumps(run(Path(sys.argv[1]).resolve(strict=True)), sort_keys=True))
