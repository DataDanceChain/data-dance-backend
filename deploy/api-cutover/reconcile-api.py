#!/usr/bin/env python3
"""Existing Compose project, API only. First prepare beside blue; recover only shared."""

import argparse
import fcntl
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import time


FAMILIES = {"email-code", "email-bind", "oauth"}
HEALTH = "/api/app/version-policy"
GATE = "/run/ddc-api-handoff/api-start.cjs"
ENTRY = "/usr/local/bin/docker-entrypoint.sh"
PIN = re.compile(r"sha256:[0-9a-f]{64}")
RESERVED_IMAGE = "ddcnew/managed-api-not-admitted:local"
AUTH_NAMESPACE_MAX_MS = 3600000
ADDITIONAL = {
    # Exact legacy: crawlerRoutes uses the default idempotencyMiddleware TTL.
    "crawler-idempotency": 86400000,
    "x-binding-flow": 600000,
    "developer-sso-proof-limiter": 3600000,
    # This is a queue, not a clock.
    "pack-purchase-queue": None,
}
LIMITERS = set("""upload general auth registerIp registerEmail public goEvents verify web3authLogin
oauthRegister oauthAuthorize oauthToken oauthTokenClient oauthRevoke oauthRevokeClient consent partner
partnerReferralBind opsLogin demandCreate opsLoginGlobal lifeContextSave lifeContextRefine lifeContextClean
ssoTicket developerClientCreate developerConsoleRead developerConsoleUpdate developerClientRotate emailOtpSend
emailOtpVerify emailBindSend emailBindVerify ssoExchange""".split())
CHECK_TARGET = """const c=require('node:crypto'),u=new URL(process.env.DATABASE_URL);
const key=process.env.JWT_SECRET||'';if(Buffer.byteLength(key)<32)process.exit(1);
const fingerprint=c.createHash('sha256').update(JSON.stringify([u.protocol,u.host,u.pathname,
u.searchParams.get('schema')||'public',key])).digest('hex');"""
TARGET_ONLY = CHECK_TARGET + "console.log(fingerprint);"
TARGET_READY = CHECK_TARGET + """
const p=require('./src/utils/prisma');
(async()=>{
try {
await p.$queryRaw`SELECT "keyHash", "codeId" FROM "DdcAuthWindow", "DdcOAuthCodeIssuance" LIMIT 0`;
console.log(fingerprint);
} catch {process.exitCode=1} finally {await p.$disconnect()}
})().catch(()=>{process.exitCode=1});"""
CHECK_SOCKET = """const h=require('node:http'),q=h.get({
socketPath:'/run/ddc-stage/api.sock',path:'/api/app/version-policy'},s=>{
s.resume();s.on('end',()=>process.exit(s.statusCode===200?0:1));});
q.on('error',()=>process.exit(1));q.setTimeout(1800,()=>q.destroy());"""


def stop(condition, message):
    if not condition:
        raise RuntimeError(message)


def private(root):
    info = root.lstat()
    stop(stat.S_ISDIR(info.st_mode) and info.st_uid == os.geteuid() and not info.st_mode & 0o077,
         "Handoff directory is not private or owned by the operator")


def trusted(file):
    fd = os.open(file, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        with os.fdopen(fd, "rb", closefd=False) as stream:
            info = os.fstat(fd)
            stop(stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid() and
                 not info.st_mode & 0o022 and 0 < info.st_size <= 65536, "Untrusted release evidence file")
            data = stream.read(65537)
            stop(len(data) == info.st_size, "Release evidence changed during read")
            return data
    finally:
        os.close(fd)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def wait_for(work, seconds=55):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        value = work()
        if value:
            return value
        time.sleep(.2)
    raise RuntimeError("API readiness deadline expired")


class Reconcile:
    def __init__(self, options):
        self.directory = Path(options.directory).resolve(strict=True)
        self.root = self.directory / "handoff-api"
        private(self.root)
        self.stage_name = options.project + "-api-staged"
        self.stage = self.root / "staged"
        self.raw_policy = trusted(self.root / "policy.json")
        self.p = json.loads(self.raw_policy)
        stop(isinstance(self.p, dict), "Invalid deployment policy")
        self.port = self.p.get("publishedPort")
        self.images = {name: self.p.get(name + "Image") for name in ("legacy", "primary", "rollback")}
        stop(self.p.get("version") == 1 and self.p.get("project") == options.project and
             re.fullmatch(r"[a-z0-9][a-z0-9_-]{1,44}", options.project) and
             type(self.port) is int and 1024 <= self.port <= 65535 and
             all(PIN.fullmatch(i or "") for i in self.images.values()) and
             len(set(self.images.values())) == 3, "Invalid, unpinned or mismatched deployment policy")
        compose = self.directory / "compose.yaml"
        self.base = ["docker", "compose", "-p", options.project, "--project-directory", str(self.directory),
                     "-f", str(compose)]
        if options.env_file:
            self.base += ["--env-file", str(Path(options.env_file).resolve(strict=True))]
        self.env = {**os.environ, "API_PORT": str(self.port)}
        self.env.pop("DDC_API_MANAGED_IMAGE", None)
        self.project = options.project

    def run(self, args, label, env=None, allow=False, timeout=45):
        result = subprocess.run(args, env=env, text=True, capture_output=True, timeout=timeout)
        stop(allow or result.returncode == 0, f"{label} failed (exit {result.returncode})")
        return result.stdout.strip() if result.returncode == 0 else None

    def dc(self, *words, image=None, **kwargs):
        env = {**self.env}
        if image:
            env.update(API_IMAGE=image, DDC_API_MANAGED_IMAGE=image)
        return self.run([*self.base, *words], "Compose " + words[0], env=env, **kwargs)

    def docker(self, *words, **kwargs):
        return self.run(["docker", *words], "Docker " + words[0], **kwargs)

    def inspect(self, cid, optional=False):
        raw = self.docker("inspect", "--format",
            '{{json .Id}} {{json .Image}} {{json .State.Pid}} {{json .State.StartedAt}} {{json .State.Running}} '
            '{{json .Config.Labels}} {{json .HostConfig.PortBindings}} {{json .HostConfig.RestartPolicy.Name}}',
            cid, allow=optional)
        if raw is None:
            return None
        parser = json.JSONDecoder()
        values = []
        while raw:
            value, end = parser.raw_decode(raw)
            values.append(value)
            raw = raw[end:].lstrip()
        names = ("id", "image", "pid", "started", "running", "labels", "ports", "restart")
        row = dict(zip(names, values, strict=True))
        stop(row["labels"].get("com.docker.compose.project") == self.project and
             row["labels"].get("com.docker.compose.service") == "api", "Not the selected API service")
        return row

    def active(self):
        ids = (self.dc("ps", "-q", "api") or "").splitlines()
        stop(len(ids) <= 1, "API has more than one running primary")
        return self.inspect(ids[0]) if ids else None

    def config(self, image=None):
        settings = json.loads(self.dc("config", "--format", "json", image=image))
        api = settings["services"]["api"]
        ports = api.get("ports", [])
        stop(len(ports) == 1 and ports[0].get("host_ip") == "127.0.0.1" and
             int(ports[0].get("published", -1)) == self.port and ports[0].get("target") == 3000 and
             not api.get("privileged") and not api.get("network_mode"), "Unreviewed API runtime shape")
        return api

    def pinned(self, image):
        actual = self.docker("image", "inspect", "-f", "{{.Id}}", image)
        stop(actual == image, "Required immutable image is not already local")

    def target(self, cid):
        fingerprint = self.docker("exec", cid, "node", "-e", TARGET_ONLY)
        stop(re.fullmatch(r"[0-9a-f]{64}", fingerprint or ""), "Cannot establish API database and signing identity")
        return fingerprint

    def prepare(self):
        before = self.active()
        stop(before and before["running"] and before["image"] == self.images["legacy"],
             "Prepare requires the live, exact legacy PID; did not recreate it")
        self.config(self.images["primary"])
        self.pinned(self.images["primary"])
        origin_target = self.target(before["id"])
        self.stage.mkdir(mode=0o700, exist_ok=True)
        private(self.stage)
        stage = self.inspect(self.stage_name, optional=True)
        created_id = None
        try:
            if stage is None:
                stop(not os.path.lexists(self.stage / "api.sock"), "Managed candidate socket already exists")
                identity = self.dc("run", "-d", "--no-deps", "--name", self.stage_name, "--pull", "never",
                                   "--entrypoint", ENTRY, "-e", "DDC_SHARED_AUTH_STATE=true",
                                   "-e", "PORT=/run/ddc-stage/api.sock", "-v", f"{self.stage}:/run/ddc-stage",
                                   "api", "node", "src/server.js", image=self.images["primary"])
                stop(re.fullmatch(r"[0-9a-f]{64}", identity or ""), "Cannot bind the newly staged Compose container ID")
                created_id = identity
            stage = self.inspect(self.stage_name)
            stop((created_id is None or stage["id"] == created_id) and
                 stage["running"] and stage["image"] == self.images["primary"] and
                 str(stage["labels"].get("com.docker.compose.oneoff")).lower() == "true" and
                 not stage["ports"], "Staged API is not private or not the exact image")
            stop(self.target(stage["id"]) == origin_target, "Candidate database or signing identity differs")
            def health():
                result = subprocess.run(["docker", "exec", stage["id"], "node", "-e", CHECK_SOCKET],
                                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=4)
                return result.returncode == 0
            wait_for(health)
            after = self.active()
            stop(after == before, "Legacy PID or deployment changed while preparing")
        except BaseException:
            if created_id:
                try:
                    target = self.inspect(created_id, optional=True)
                    if target and target["id"] == created_id and target["image"] == self.images["primary"] and \
                       str(target["labels"].get("com.docker.compose.oneoff")).lower() == "true":
                        self.docker("rm", "-f", created_id, allow=True)
                except (RuntimeError, OSError, ValueError, subprocess.SubprocessError):
                    pass  # No proven identity, no removal.
            raise
        return {"stage": "prepared", "legacyPidUnchanged": True, "privateSocket": str(self.stage / "api.sock"),
                "sharedCandidateImage": self.images["primary"], "ownsTraffic": False}

    def retiring(self, active):
        owner_path = self.root / "owners.json"
        root_owner = trusted(owner_path)
        rows = json.loads(root_owner)
        stop(set(rows) == FAMILIES and all(r == {"owner": "shared", "pending": 0, "unknown": 0}
                                         for r in rows.values()), "Authoritative ownership is not fully shared")
        retired = json.loads(trusted(self.root / "retired-legacy.json"))
        stop(isinstance(retired, dict), "Invalid retired API receipt")
        elapsed = retired.get("windowElapsedMs")
        more = retired.get("additionalState")
        stop(isinstance(more, dict) and set(more) == ADDITIONAL.keys(),
             "Non-auth in-process state retirement is not accounted for")
        for name, maximum in ADDITIONAL.items():
            item = more[name]
            stop(isinstance(item, dict), "Invalid non-auth retirement evidence")
            queue_settled = maximum is None and item == {"method": "terminal", "unresolved": 0}
            clock_settled = (maximum is not None and item.get("method") == "expired" and
                             type(item.get("windowElapsedMs")) is int and item["windowElapsedMs"] >= maximum)
            known_empty = maximum is not None and item == {"method": "observed-empty", "records": 0}
            stop(queue_settled or clock_settled or known_empty, "Non-auth in-process state still unresolved")
        stop(retired.get("version") == 1 and retired.get("ownerSha256") == digest(root_owner) and
             retired.get("legacyImage") == self.images["legacy"] and
             PIN.fullmatch("sha256:" + (retired.get("sharedTargetFingerprint") or "")) and
             retired.get("allApiIngressClosed") is True and
             set(retired.get("drainedLimiterNamespaces") or []) == LIMITERS and
             type(elapsed) is int and elapsed >= AUTH_NAMESPACE_MAX_MS and
             retired.get("unresolvedLegacyWrites") == 0 and retired.get("directLegacyConnections") == 0,
             "Whole-API retirement evidence is missing or incomplete")
        if active:
            allowed = self.images.values()
            stop(active["image"] in allowed, "Running API is not a pinned release image")
            if active["image"] == self.images["legacy"]:
                stop(active["id"] == retired.get("legacyContainerId") and
                     active["started"] == retired.get("legacyStartedAt"),
                     "Retirement evidence belongs to another legacy process")
        return root_owner, retired

    def managed_config(self, image):
        api = self.config(image)
        mounts = api.get("volumes", [])
        stop(api.get("image") == image and api.get("entrypoint") == ["node", GATE] and
             api.get("restart") == "no" and api.get("pull_policy") == "never" and
             str(api.get("environment", {}).get("DDC_SHARED_AUTH_STATE")).lower() == "true" and
             any(v.get("type") == "bind" and v.get("read_only") and
                 v.get("source") == str(self.root) and v.get("target") == "/run/ddc-api-handoff" for v in mounts),
             "Current API template does not enforce managed shared-only startup")

    def reserved_image_absent(self):
        stop(self.docker("image", "inspect", "-f", "{{.Id}}", RESERVED_IMAGE, allow=True) is None,
             "Reserved unadmitted alias unexpectedly exists; release cannot proceed")

    def preflight(self, role):
        image = self.images[role]
        self.pinned(image)
        self.reserved_image_absent()
        self.managed_config(image)
        stop(self.config().get("image") == RESERVED_IMAGE, "Raw Compose has an unexpected default API image")
        self.recovery_boundary()
        return {"stage": "preflight-passed", "image": image, "role": role}

    def template_preflight(self, role):
        self.pinned(self.images[role])
        self.reserved_image_absent()
        self.recovery_boundary()
        return {"stage": "template-preflight-passed", "role": role}

    def recovery_boundary(self):
        current = self.active()
        stop(current is None,
             "Live API unchanged: no independent standby owns the published port and direct ingress")
        # This is recovery of an unavailable service, not a live release
        # authorization. Reading a retirement receipt never closes admission.
        return self.retiring(None)

    def recover(self, role):
        image = self.images[role]
        self.preflight(role)
        owner, retired = self.recovery_boundary()
        # Same Compose env, no published ports, explicit fixed maintenance command.
        expected = retired["sharedTargetFingerprint"]
        actual = self.dc("run", "--rm", "--no-deps", "-T", "--pull", "never",
                         "--entrypoint", ENTRY, "api", "node", "-e", TARGET_READY, image=image).splitlines()[-1]
        stop(actual == expected, "Shared database or signing identity differs; active API untouched")
        stop(self.recovery_boundary()[0] == owner,
             "API still running or authoritative ownership changed; no replacement started")
        self.dc("up", "-d", "--no-deps", "--force-recreate", "--pull", "never", "api",
                image=image, timeout=390)
        active = self.active()
        expected_ports = {"3000/tcp": [{"HostIp": "127.0.0.1", "HostPort": str(self.port)}]}
        stop(active and active["image"] == image and active["ports"] == expected_ports and
             active["restart"] == "no" and self.target(active["id"]) == expected,
             "New API stay closed: runtime identity or port mismatch")
        challenge_file = "/tmp/ddc-api-launch-challenge.json"
        challenge = json.loads(wait_for(lambda: self.docker("exec", active["id"], "cat", challenge_file, allow=True)))
        stop(self.retiring(active)[0] == owner, "Ownership changed during replacement; new API stays closed")
        admission = {**challenge, "image": image, "role": role, "policySha256": digest(self.raw_policy),
                     "ownerSha256": digest(owner), "version": 1}
        filename = self.root / f".admission-{os.getpid()}.tmp"
        with open(filename, "x", opener=lambda path, flags: os.open(path, flags, 0o600)) as stream:
            json.dump(admission, stream)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(filename, self.root / "admission.json")
        def ready():
            connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=1)
            try:
                connection.request("GET", HEALTH)
                status = connection.getresponse()
                ok = status.status == 200
                status.read()
                return ok and self.active() == active
            except (OSError, http.client.HTTPException):
                return False
            finally:
                connection.close()
        wait_for(ready)
        return {"stage": "recovered", "image": image, "role": role, "health": 200, "sharedOnly": True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", required=True)
    parser.add_argument("--project", required=True)
    parser.add_argument("--env-file")
    parser.add_argument("step", choices=("prepare", "template-preflight", "preflight", "recover", "reconcile"))
    parser.add_argument("--image", choices=("primary", "rollback"), default="primary")
    args = parser.parse_args()
    try:
        work = Reconcile(args)
        fd = os.open(work.root / "reconcile.lock", os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "wb") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            if args.step == "prepare":
                result = work.prepare()
            elif args.step == "preflight":
                result = work.preflight(args.image)
            elif args.step == "template-preflight":
                result = work.template_preflight(args.image)
            else:
                result = work.recover(args.image)
        print(json.dumps(result, sort_keys=True))
    except RuntimeError as error:
        parser.exit(1, f"STOP: {error}\n")
    except (OSError, ValueError, KeyError, TypeError, IndexError, subprocess.TimeoutExpired):
        parser.exit(1, "STOP: invalid, inaccessible or expired API release evidence\n")


if __name__ == "__main__":
    main()
