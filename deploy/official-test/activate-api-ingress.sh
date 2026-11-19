#!/usr/bin/env bash
set -euo pipefail
umask 077

refuse() { printf '%s\n' "$*" >&2; exit 1; }
[[ $(id -u) == 0 ]] || refuse 'TEST ingress requires the host operator'
[[ $# == 5 && $1 == --apply-test ]] || refuse 'Expected --apply-test NETWORK OWNER API PG'
network=$2
owner=$3
api=$4
pg=$5
[[ $owner =~ ^[a-f0-9]{32}$ && $network =~ ^ddc-real-test-[a-f0-9]+-private$ &&
   $api =~ ^ddc-official-test-api-[a-z0-9-]+$ && $pg =~ ^ddc-real-test-[a-f0-9]+-pg$ ]] ||
  refuse 'Arguments do not identify isolated TEST artifacts'

[[ "$(docker network inspect --format '{{.Driver}} {{.Internal}} {{index .Labels "ddc.owner"}}' "$network")" == "bridge true $owner" ]] ||
  refuse 'TEST bridge does not have the expected owner and isolation'
for name in "$api" "$pg"; do
  expected=isolated-test-postgres
  [[ $name != "$api" ]] || expected=official-test-api-sdk
  [[ "$(docker inspect --format '{{.State.Running}} {{index .Config.Labels "ddc.owner"}} {{index .Config.Labels "ddc.component"}} {{len .HostConfig.PortBindings}} {{range $n, $_ := .NetworkSettings.Networks}}{{$n}}{{end}}' "$name")" == \
    "true $owner $expected 0 $network" ]] || refuse "Unexpected TEST service state $name"
done
[[ "$(docker network inspect --format '{{range .Containers}}{{.Name}}{{"\n"}}{{end}}' "$network" | awk 'NF' | sort)" == \
  "$(printf '%s\n' "$api" "$pg" | sort)" ]] || refuse 'Unexpected services on original TEST bridge'

image=$(docker inspect --format '{{.Image}}' "$api")
[[ $image =~ ^sha256:[a-f0-9]{64}$ ]] || refuse 'Unexpected TEST API image metadata'
docker exec -i "$api" node - <<'JS'
(async () => {
  const db = new URL(process.env.DATABASE_URL);
  if (!/^ddc-real-test-[a-f0-9]+-pg$/.test(db.hostname) || db.pathname !== '/ddc_developer_test' ||
      !/^ddc_api_[a-f0-9]+$/.test(db.username) || process.env.SSO_ENVIRONMENT !== 'test' ||
      process.env.PUBLIC_BASE_URL !== 'https://test-api.datadance.ai' ||
      process.env.APP_PUBLIC_URL !== 'https://test-app.datadance.ai' ||
      process.env.SSO_TGE_REDIRECT_URIS !== 'https://test-developers.datadance.ai/auth/callback' ||
      process.env.WEB3AUTH_JWKS_PIN_MODE !== 'enforce' ||
      process.env.WEB3AUTH_ALLOW_LEGACY_FALLBACK !== 'false') throw Error('Invalid isolated application configuration');
  const response = await fetch('http://127.0.0.1:3000/.well-known/oauth-authorization-server', {signal: AbortSignal.timeout(4000)});
  const info = await response.json();
  if (response.status !== 200 || info.issuer !== process.env.PUBLIC_BASE_URL || info.ddc_sso_environment !== 'test') {
    throw Error('Invalid TEST issuer');
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
JS

source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
base=/opt/ddc-isolated-test-20261029/api-ingress-v1
units=/etc/systemd/system
service=ddc-official-test-api-ingress
egress=ddc-official-test-jwks-egress-v1
names=(ddc-official-test-api-loopback-v1 ddc-official-test-jwks-api-auth-v1 ddc-official-test-jwks-authjs-v1)
[[ -f "$source_dir/api-relay.cjs" && ! -L "$source_dir/api-relay.cjs" &&
   -d "${base%/*}" && "$(realpath -e "${base%/*}")" == "${base%/*}" ]] ||
  refuse 'Relay custody or TEST release path is missing'
[[ -x /usr/lib/systemd/systemd-socket-proxyd ]] || refuse 'Socket bridge is unavailable'
[[ -z "$(ss -H -ltn 'sport = :55320')" &&
   ! -e $base && ! -L $base &&
   ! -e "$units/$service.service" && ! -L "$units/$service.service" &&
   ! -e "$units/$service.socket" && ! -L "$units/$service.socket" ]] || refuse 'TEST target is occupied'
[[ -z "$(docker network ls --filter "name=^/$egress$" --format '{{.Name}}')" ]] || refuse 'Relay egress network exists'
for name in "${names[@]}"; do
  [[ -z "$(docker ps -aq --filter "name=^/$name$")" ]] || refuse "Relay container exists $name"
done

read -r invocation </proc/sys/kernel/random/uuid
applied=0
base_created=0
units_created=0
egress_created=0
rollback() {
  [[ $applied == 0 ]] || return 0
  if [[ $units_created == 1 ]]; then
    systemctl disable --now "$service.socket" >/dev/null 2>&1 || true
    systemctl stop "$service.service" >/dev/null 2>&1 || true
    rm -f -- "$units/$service.socket" "$units/$service.service"
    systemctl daemon-reload >/dev/null 2>&1 || true
  fi
  for name in "${names[@]}"; do
    if [[ "$(docker inspect --format '{{index .Config.Labels "ddc.invocation"}}' "$name" 2>/dev/null)" == "$invocation" ]]; then
      docker rm -f "$name" >/dev/null || true
    fi
  done
  if [[ $egress_created == 1 && "$(docker network inspect --format '{{index .Labels "ddc.invocation"}}' "$egress")" == "$invocation" ]]; then
    docker network rm "$egress" >/dev/null || true
  fi
  if [[ $base_created == 1 ]]; then
    rm -f -- "$base/socket/api.sock" "$base/api-relay.cjs"
    rmdir -- "$base/socket" "$base" || true
  fi
}
trap rollback EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

install -d -m 0700 -- "$base"
base_created=1
install -d -m 0755 -- "$base/socket"
install -m 0444 -- "$source_dir/api-relay.cjs" "$base/api-relay.cjs"

common=(--pull never --read-only --cap-drop ALL --security-opt no-new-privileges
  --pids-limit 40 --memory 96m --cpus .25 --restart unless-stopped
  --label "ddc.owner=$owner" --label "ddc.invocation=$invocation"
  --mount "type=bind,src=$base/api-relay.cjs,dst=/tmp/ddc-test-api-relay.cjs,readonly"
  --log-opt max-size=256k --log-opt max-file=1 --entrypoint node)
docker run -d "${common[@]}"   --name "${names[0]}" --label ddc.component=official-test-api-loopback --network "$network"   --mount "type=bind,src=$base/socket,dst=/run/ddc-test-api"   "$image" /tmp/ddc-test-api-relay.cjs ingress "$api" >/dev/null
for _ in {1..20}; do
  [[ ! -S "$base/socket/api.sock" ]] || break
  sleep .25
done
[[ -S "$base/socket/api.sock" && "$(stat -c '%a:%u' "$base/socket/api.sock")" == 660:0 ]] ||
  refuse 'TEST API Unix socket failed to start'
curl -fsS --max-time 4 --unix-socket "$base/socket/api.sock"   http://localhost/.well-known/oauth-authorization-server | python3 -c '
import json,sys
data=json.load(sys.stdin)
assert data["issuer"]=="https://test-api.datadance.ai" and data["ddc_sso_environment"]=="test"
'

# Separate, credential-free peers preserve remote TLS and only connect to each
# JWK provider hostname on port 443. TEST API and DB keep their original network.
docker network create --driver bridge --opt com.docker.network.bridge.enable_icc=false   --label "ddc.owner=$owner" --label "ddc.invocation=$invocation" "$egress" >/dev/null
egress_created=1
vendors=(api-auth.web3auth.io authjs.web3auth.io)
for index in 0 1; do
  name="${names[index+1]}"
  vendor="${vendors[index]}"
  docker create "${common[@]}" --name "$name" --label ddc.component=official-test-jwks-relay     --network "$egress" --sysctl net.ipv4.ip_unprivileged_port_start=0     "$image" /tmp/ddc-test-api-relay.cjs jwks "$vendor" >/dev/null
  docker network connect --alias "$vendor" "$network" "$name"
  docker start "$name" >/dev/null
done

docker exec -i "$api" node - <<'JS'
const {createHash} = require('node:crypto');
const {lookup} = require('node:dns').promises;
function thumbprint(key) {
  if (key.kty !== 'EC' || key.crv !== 'P-256') return null;
  return createHash('sha256').update(JSON.stringify({crv:key.crv,kty:key.kty,x:key.x,y:key.y})).digest('base64url');
}
(async () => {
  const pins = new Set(process.env.WEB3AUTH_JWKS_PINNED_THUMBPRINTS.split(',').map(pin => pin.trim()));
  for (const host of ['api-auth.web3auth.io','authjs.web3auth.io']) {
    const {address} = await lookup(host, {family:4});
    if (!/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address)) throw Error('TEST alias did not resolve privately');
    const response = await fetch('https://' + host + '/jwks', {signal:AbortSignal.timeout(9000), redirect:'error'});
    const data = await response.json();
    if (response.status !== 200 || !Array.isArray(data.keys) || !data.keys.some(key => pins.has(thumbprint(key)))) {
      throw Error('No trusted vendor signing key for ' + host);
    }
    console.log('jwksPinned=true host=' + host);
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
JS

units_created=1
cat > "$units/$service.service" <<EOF
[Unit]
Description=DDC TEST API bridge
Requires=$service.socket
After=docker.service

[Service]
ExecStart=/usr/lib/systemd/systemd-socket-proxyd $base/socket/api.sock
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
EOF
cat > "$units/$service.socket" <<'EOF'
[Unit]
Description=DDC TEST API loopback listener
After=docker.service

[Socket]
ListenStream=127.0.0.1:55320

[Install]
WantedBy=sockets.target
EOF
chmod 0644 -- "$units/$service.service" "$units/$service.socket"
systemctl daemon-reload
systemctl enable --now "$service.socket" >/dev/null

endpoint=http://127.0.0.1:55320/.well-known/oauth-authorization-server
curl -fsS --max-time 4 "$endpoint" | python3 -c '
import json,sys
data=json.load(sys.stdin)
assert data["issuer"]=="https://test-api.datadance.ai" and data["ddc_sso_environment"]=="test"
'
for origin in https://test-app.datadance.ai https://test-developers.datadance.ai; do
  curl -fsS --max-time 4 -D - -o /dev/null -H "Origin: $origin" "$endpoint" |
    tr -d '\r' | grep -iFx "access-control-allow-origin: $origin" >/dev/null
done
if curl -fsS --max-time 4 -D - -o /dev/null -H 'Origin: https://app.datadance.ai' "$endpoint" |
  grep -qi '^access-control-allow-origin:'; then
  refuse 'Unexpected production origin allowed by TEST API'
fi
[[ "$(docker inspect --format '{{range $n, $_ := .NetworkSettings.Networks}}{{$n}}{{end}}' "$api")" == "$network" &&
   "$(docker inspect --format '{{range $n, $_ := .NetworkSettings.Networks}}{{$n}}{{end}}' "$pg")" == "$network" ]] ||
  refuse 'TEST API or DB network changed'

applied=1
printf 'test_api_loopback=127.0.0.1:55320 test_issuer_verified=true test_cors_verified=true prod_cors_denied=true invocation=%s\n' "$invocation"
