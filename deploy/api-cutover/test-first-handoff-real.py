#!/usr/bin/env python3
"""Run the established exact-image QA scaffold through the actual proxy."""

import argparse
from pathlib import Path
import shutil
import subprocess
import tempfile


ABORTED_EXCHANGE = """
 // Second, genuinely executed old-image OAuth exchange, with its response
 // consumer gone while the old app waits for the synthetic DB update lock.
 const severedCode=crypto.randomBytes(32).toString('hex');
 const severedRow=await db.oAuthAuthorization.create({data:{
   clientId:'tge-test',redirectUri:redirect,
   codeChallenge:crypto.createHash('sha256').update(verifier).digest('base64url'),
   codeChallengeMethod:'S256',resource:issuer+'/partner/sso',scope:'identity.read',
   userId:user.id,codeHash:sha(severedCode),expiresAt:new Date(Date.now()+60000)}});
 let releaseSevered, lockedSevered;
 const dbReady=new Promise(r=>lockedSevered=r), dbRelease=new Promise(r=>releaseSevered=r);
 const held=db.$transaction(async tx=>{
   await tx.$queryRaw`SELECT id FROM "OAuthAuthorization" WHERE id=${severedRow.id} FOR UPDATE`;
   lockedSevered();
   await dbRelease;
 },{timeout:12000});
 let client;
 try {
   await dbReady;
   const raw=JSON.stringify({grant_type:'authorization_code',code:severedCode,code_verifier:verifier,
     client_id:'tge-test',client_secret:secret,redirect_uri:redirect});
   client=http.request({hostname:'127.0.0.1',port:proxy.address().port,path:'/oauth/token',method:'POST',
     headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(raw)},agent:false});
   client.on('error',()=>{});
   client.end(raw);
   let reallyWaiting=false;
   for(let i=0;i<100;i++){
     const [dbStatus]=await db.$queryRaw`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock'
       AND query ILIKE '%UPDATE%' AND query LIKE '%OAuthAuthorization%') AS waiting`;
     if(dbStatus.waiting){reallyWaiting=true;break}await pause(30);
   }
   assert.ok(reallyWaiting,'Exact old app did not reach the second database lock');
   client.destroy();
   await pause(100);
   assert.equal(engine.status().families.oauth.pending,1);
   assert.equal(engine.observe('oauth'),false);
 } finally {
   client?.destroy();
   releaseSevered();
   await held.catch(()=>{});
 }
 for(let i=0;i<100&&engine.status().families.oauth.pending;i++)await pause(30);
 assert.equal(engine.status().families.oauth.pending,0);
 assert.equal(engine.status().families.oauth.unknown,0);
 assert.ok((await db.oAuthAuthorization.findUnique({where:{id:severedRow.id}})).consumedAt);
 assert.equal(await db.mcpToken.count({where:{userId:user.id}}),1,'Did not execute exact old exchange once');
 assert.equal(engine.prepareReverse(),true);
 for(const name of names)assert.equal(engine.observe(name),true);
"""


def exact_replace(source, before, after):
    if source.count(before) != 1:
        raise RuntimeError("Archived exact-image harness shape changed")
    return source.replace(before, after)


def adapt(qa):
    target = qa / "tests" / "flow.cjs"
    worker = qa / "tests" / "worker.cjs"
    worker.write_text(exact_replace(
        worker.read_text(),
        "const server=app.listen(0,'127.0.0.1',()=>process.send({port:server.address().port}));",
        """const socket=process.env.QA_SHARED_SOCKET;
const ready=()=>process.send({port:socket||server.address().port});
const server=socket?app.listen(socket,ready):app.listen(0,'127.0.0.1',ready);""",
    ))
    script = target.read_text()
    start = script.index("const {trackFamily}=")
    end = script.index("async function worker", start)
    script = script[:start] + """
const {createProxy}=require('/qa/tests/first-handoff-proxy');
const fs=require('node:fs');
let engine,proxy,elapsed=0,targets={};
const names=['email-code','email-bind','oauth'];
fs.mkdirSync('/run/qa/shared-app',{mode:0o700});
const sharedSocket='/run/qa/shared-app/api.sock';
""" + script[end:]
    script = exact_replace(script, "async function worker(shared)",
                           "async function worker(shared,socket)")
    script = exact_replace(script, "DDC_SHARED_AUTH_STATE:String(shared)},",
                           "DDC_SHARED_AUTH_STATE:String(shared),...(socket?{QA_SHARED_SOCKET:socket}:{})},")
    script = exact_replace(script, "a=await worker(shared),b=await worker(true)",
                           "a=await worker(shared),b=await worker(true,sharedSocket)")
    script = exact_replace(script, "targets={legacy:a,shared:b};", """targets={legacy:a,shared:b};
 engine=createProxy({stateDir:'/run/qa/proxy-state',legacyOrigin:'http://127.0.0.1:'+a.port,
   sharedSocket, now:()=>elapsed,
   verifyClosure:()=>({ingressVerified:true,directConnections:0,unresolvedLegacyWrites:0})});
 proxy=engine.server.listen(0,'127.0.0.1');
 await once(proxy,'listening');
""")
    script = exact_replace(script, "for(const g of Object.values(groups))g.startObservation();",
                           "assert.equal(engine.observe('oauth'),false);")
    script = exact_replace(script, " elapsed+=3600001;", ABORTED_EXCHANGE + "\n elapsed+=3600001;")
    script = exact_replace(script, "protectedGroups:Object.keys(groups)", "protectedGroups:names")
    script = exact_replace(script, "allOwnersCommitted:Object.keys(groups).every(name=>fs.existsSync('/run/qa/'+name+'.owner'))",
                           "allOwnersCommitted:names.every(name=>engine.status().families[name].owner==='shared'),"
                           "clientAbortPreservedOldActualExchangeAndSingleCommit:true,realSharedAppOverPrivateUDS:true")
    script = script[:script.index("(async()=>{\n proxy=http.createServer")]
    script += """
(async()=>{await run('legacy')})()
 .catch(e=>{console.error('FAILED',e.code||e.name,(e.stack||'').split('\\n').slice(0,5).join(' '));process.exitCode=1})
 .finally(async()=>{for(const c of workers)await stop(c);if(engine)await engine.close();await db.$disconnect()});
"""
    target.write_text(script)


if __name__ == "__main__":
    arg = argparse.ArgumentParser(description=__doc__)
    arg.add_argument("archived_image_qa", type=Path)
    qa_source = arg.parse_args().archived_image_qa.resolve(strict=True)
    files = Path(__file__).resolve().parent
    with tempfile.TemporaryDirectory(prefix="ddc-handoff-real-proxy-") as temp:
        qa = Path(temp) / "qa"
        shutil.copytree(qa_source, qa, symlinks=True)
        for name in ("first-handoff.js", "first-handoff-proxy.js", "first-handoff-journal.js"):
            shutil.copyfile(files / name, qa / "tests" / name)
        adapt(qa)
        raise SystemExit(subprocess.run([str(qa / "run.sh")], check=False).returncode)
