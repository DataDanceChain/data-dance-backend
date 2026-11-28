#!/usr/bin/env python3
"""Managed API release guards, including the old whole-service retirement boundary."""

import importlib.util
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import unittest
from unittest.mock import MagicMock
import uuid

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("reconcile", HERE / "reconcile-api.py")
reconcile = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reconcile)


class Boundary(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.op = object.__new__(reconcile.Reconcile)
        self.op.root = Path(self.temp.name)
        self.op.images = {name: "sha256:" + value * 64 for name, value in
                          (("legacy", "1"), ("primary", "2"), ("rollback", "3"))}
        self.owner = {fam: {"owner": "shared", "pending": 0, "unknown": 0} for fam in reconcile.FAMILIES}
        self.retired = {
            "version": 1,
            "legacyImage": self.op.images["legacy"],
            "sharedTargetFingerprint": "4" * 64,
            "allApiIngressClosed": True,
            "directLegacyConnections": 0,
            "unresolvedLegacyWrites": 0,
            "windowElapsedMs": 3600000,
            "legacyContainerId": "test-old",
            "legacyStartedAt": "test-generation",
            "drainedLimiterNamespaces": sorted(reconcile.LIMITERS),
            "additionalState": {
                n: {"method": "terminal", "unresolved": 0} if expiry is None else
                {"method": "expired", "windowElapsedMs": expiry}
                for n, expiry in reconcile.ADDITIONAL.items()
            },
        }

    def files(self):
        raw = json.dumps(self.owner).encode()
        (self.op.root / "owners.json").write_bytes(raw)
        self.retired["ownerSha256"] = reconcile.digest(raw)
        (self.op.root / "retired-legacy.json").write_text(json.dumps(self.retired))

    def test_protects_live_shared_generation_without_sending_any_signal(self):
        self.op.active = lambda: {"image": self.op.images["primary"]}
        self.op.pinned = MagicMock()
        self.op.reserved_image_absent = MagicMock()
        self.op.managed_config = MagicMock()
        self.op.config = lambda: {"image": reconcile.RESERVED_IMAGE}
        self.op.docker = MagicMock()
        self.op.dc = MagicMock()
        self.files()
        with self.assertRaisesRegex(RuntimeError, "Live API unchanged"):
            self.op.recover("rollback")
        self.op.docker.assert_not_called()
        self.op.dc.assert_not_called()

    def test_stopped_branch_accepts_whole_retirement_not_three_family_only(self):
        self.op.active = lambda: None
        self.files()
        self.assertEqual(self.op.recovery_boundary()[1]["version"], 1)
        self.retired["drainedLimiterNamespaces"].remove("ssoTicket")
        self.files()
        with self.assertRaisesRegex(RuntimeError, "retirement evidence"):
            self.op.recovery_boundary()

    def test_crawler_24h_and_unresolved_purchase_queue_are_independent(self):
        self.op.active = lambda: None
        self.retired["additionalState"]["crawler-idempotency"]["windowElapsedMs"] = 3600000
        self.files()
        with self.assertRaisesRegex(RuntimeError, "state still unresolved"):
            self.op.recovery_boundary()
        self.retired["additionalState"]["crawler-idempotency"] = {"method": "observed-empty", "records": 0}
        self.retired["additionalState"]["pack-purchase-queue"]["unresolved"] = 1
        self.files()
        with self.assertRaisesRegex(RuntimeError, "state still unresolved"):
            self.op.recovery_boundary()

    def test_legacy_observer_cannot_be_shared_authority(self):
        self.op.active = lambda: None
        self.owner["oauth"]["owner"] = "legacy"
        self.files()
        with self.assertRaisesRegex(RuntimeError, "not fully shared"):
            self.op.recovery_boundary()

    def test_mismatched_legacy_generation_rejected(self):
        self.files()
        old = {"image": self.op.images["legacy"], "id": "test-old", "started": "replacement"}
        with self.assertRaisesRegex(RuntimeError, "another legacy process"):
            self.op.retiring(old)


@unittest.skipUnless(os.environ.get("DDC_TEST_MANAGED_DOCKER") == "1", "explicit local Docker proof")
class ComposeRefusal(unittest.TestCase):
    def test_default_raw_force_recreate_cannot_stop_running_service(self):
        project = "ddcapiraw" + uuid.uuid4().hex[:8]
        with tempfile.TemporaryDirectory(prefix="ddc-raw-compose-audit-") as root:
            file = Path(root) / "compose.yaml"
            with socket.socket() as lease:
                lease.bind(("127.0.0.1", 0))
                port = lease.getsockname()[1]
            api = {"image": "node:22-alpine", "pull_policy": "never",
                   "ports": [f"127.0.0.1:{port}:3000"], "command": ["sleep", "45"]}
            file.write_text(json.dumps({"services": {"api": api}}))
            def command(*args):
                return subprocess.run(args, capture_output=True, text=True, timeout=25)
            def dc(*args):
                return command("docker", "compose", "-f", str(file), "-p", project, *args)
            def identity():
                cid = dc("ps", "-q", "api").stdout.strip()
                result = command("docker", "inspect", "-f", "{{.State.Pid}} {{.State.StartedAt}}", cid)
                self.assertEqual(result.returncode, 0)
                return cid, result.stdout
            try:
                self.assertEqual(dc("up", "-d", "--no-deps", "--pull", "never", "api").returncode, 0)
                before = identity()
                api["image"] = "ddcnew/managed-api-not-admitted:local"
                file.write_text(json.dumps({"services": {"api": api}}))
                denied = dc("up", "-d", "--force-recreate", "--no-deps", "api")
                self.assertNotEqual(denied.returncode, 0)
                self.assertIn("No such image", denied.stderr)
                self.assertEqual(identity(), before)
            finally:
                self.assertEqual(dc("down").returncode, 0)


if __name__ == "__main__":
    unittest.main()
