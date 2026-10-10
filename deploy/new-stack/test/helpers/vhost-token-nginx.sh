#!/usr/bin/env bash
# vhost-token-nginx.sh <render dir> <api host> <app host> <token> <name suffix> [docker run label arguments...]
# The two copies 30-nginx.sh render wrote to <render dir>, served by a REAL nginx:stable: this package's vhost token
# location must answer the token (200) to 127.0.0.1 only and 403 without it to any other address. One nginx container
# (named ddcnew-tokentest-<suffix>, removed at the end) on Docker's default bridge; the loopback request runs inside it,
# the other request from a second short-lived container on the same bridge (another address). Nothing is published on
# the host. Prints one PASS or FAIL line per host and exits 1 on any FAIL. Writes only <render dir>/token-nginx/.
set -euo pipefail
R="$1"; AH="$2"; PH="$3"; TOK="$4"; SFX="$5"; shift 5
W="$R/token-nginx"; C="ddcnew-tokentest-$SFX"
mkdir -p "$W/sites"; cp "$R/$AH" "$R/$PH" "$W/sites/"
printf 'events {}\nhttp {\n  include /etc/nginx/mime.types;\n  include /etc/nginx/sites/*;\n}\n' > "$W/nginx.conf"
trap 'docker rm -f "$C" >/dev/null 2>&1 || true' EXIT
docker run -d "$@" --name "$C" -v "$W/nginx.conf:/etc/nginx/nginx.conf:ro" -v "$W/sites:/etc/nginx/sites:ro" nginx:stable >/dev/null
for _ in $(seq 1 30); do docker exec "$C" curl -s -o /dev/null -m 2 http://127.0.0.1/ 2>/dev/null && break; sleep 0.5; done
IP=$(docker inspect --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$C")
[ -n "$IP" ] || { echo "FAIL the nginx container has no bridge address"; exit 1; }
fails=0
for h in "$AH" "$PH"; do
  lo=$(docker exec "$C" curl -s -m 5 -w ' %{http_code}' -H "Host: $h" "http://127.0.0.1/.well-known/ddcnew-vhost-token" || true)
  other=$(docker run --rm "$@" --name "$C-client-$RANDOM" nginx:stable curl -s -m 5 -w ' %{http_code}' -H "Host: $h" "http://$IP/.well-known/ddcnew-vhost-token" || true)
  if [ "$lo" = "$TOK 200" ] && [ "${other##* }" = 403 ] && [[ "$other" != *"$TOK"* ]]; then
    echo "PASS $h on nginx:stable: the vhost token location answers the token to 127.0.0.1 (200) and 403 without it to another container's address"
  else
    echo "FAIL $h on nginx:stable: from 127.0.0.1 got code ${lo##* } (token $([ "${lo% *}" = "$TOK" ] && echo yes || echo no)), from another address got code ${other##* } (token $([[ "$other" == *"$TOK"* ]] && echo yes || echo no))"
    fails=$((fails + 1))
  fi
done
[ "$fails" = 0 ]
