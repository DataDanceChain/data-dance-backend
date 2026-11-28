#!/usr/bin/env python3
"""Render reviewed, exact runtime-source overlays into an empty private directory."""

import argparse
import hashlib
from pathlib import Path

HERE = Path(__file__).resolve().parent
SOURCES = {
    "compose.yaml": "606ad26a828ee2a7b48e94622693a73a2a7e5d3e822f4e2941e4a60defea9596",
    "40-up.sh": "72ca47487d4fb1ced23bc359858c173f755c5898de3e4702a6b7a279f4b19597",
}


def exact(text, before, after, count=1):
    if text.count(before) != count:
        raise ValueError("Unexpected managed API placement")
    return text.replace(before, after)


def render(source, out):
    originals = {}
    for name, checksum in SOURCES.items():
        data = (source / name).read_bytes()
        if hashlib.sha256(data).hexdigest() != checksum:
            raise ValueError("Baseline changed; review fresh exact files")
        originals[name] = data.decode()
    text = originals["compose.yaml"]
    text = exact(text, "    image: ${API_IMAGE:?API_IMAGE missing - run 10-build.sh, which writes /root/ddcnew/.env}\n",
                 '    image: ${DDC_API_MANAGED_IMAGE:-ddcnew/managed-api-not-admitted:local}\n'
                 '    pull_policy: never\n    entrypoint: ["node", "/run/ddc-api-handoff/api-start.cjs"]\n'
                 '    command: []\n    stop_grace_period: 330s\n')
    text = exact(text, "    env_file: .env.api\n",
                 '    env_file: .env.api\n    environment:\n      DDC_SHARED_AUTH_STATE: "true"\n      PORT: "3000"\n')
    text = exact(text, "      - ./keys_fixed:/app/keys_fixed:ro\n",
                 "      - ./handoff-api:/run/ddc-api-handoff:ro\n      - ./keys_fixed:/app/keys_fixed:ro\n")
    text = exact(text, "    restart: unless-stopped\n    mem_limit: 1g          #",
                 '    restart: "no"\n    mem_limit: 1g          #')
    script = originals["40-up.sh"]
    script = exact(script, 'step "1b. compose file and the api env (the pin gate passed)"\n',
                   '''step "1b. compose file and the api env (the pin gate passed)"
API_RECON="$NEW_DIR/handoff-api/reconcile-api.py"
[ -f "$API_RECON" ] && [ ! -L "$API_RECON" ] && [ "$(stat -c '%u:%a' "$API_RECON")" = 0:700 ] ||
  die "Managed API reconciler not pinned and installed"
api_reconcile() { python3 "$API_RECON" --directory "$NEW_DIR" --project "$PROJECT" "$@"; }
api_reconcile template-preflight || die "Legacy API or state remains in use; use isolated prepare first"
''')
    script = exact(script, "dc run --rm --no-deps -T api ",
                   'DDC_API_MANAGED_IMAGE="$API_IMAGE" dc run --rm --no-deps -T --entrypoint '
                   '/usr/local/bin/docker-entrypoint.sh api ', 4)
    script = exact(script, "dc up -d api web\n",
                   'api_reconcile recover --image primary || die "Managed API recovery refused"\ndc up -d web\n')
    out.mkdir(mode=0o700)
    (out / "compose.yaml").write_text(text)
    (out / "40-up.sh").write_text(script)
    files = [out / "compose.yaml", out / "40-up.sh"]
    base = out / "handoff-api"
    base.mkdir(mode=0o700)
    for name in ("api-start.cjs", "reconcile-api.py"):
        dest = base / name
        dest.write_bytes((HERE / name).read_bytes())
        dest.chmod(0o700 if name.endswith(".py") else 0o600)
        files.append(dest)
    (out / "SHA256SUMS").write_text("".join(
        f"{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.relative_to(out)}\n" for p in files))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("exact_source", type=Path)
    parser.add_argument("new_destination", type=Path)
    args = parser.parse_args()
    render(args.exact_source.resolve(strict=True), args.new_destination)
