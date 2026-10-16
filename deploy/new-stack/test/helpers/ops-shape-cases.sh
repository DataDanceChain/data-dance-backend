#!/usr/bin/env bash
# ops-shape-cases.sh <package dir> [--node] - common.sh ops_value_refused, 20-env.sh's check of backend PR #55's ops
# settings, on SYNTHETIC values: each case must get exactly its expected verdict (accepted, or the exact reason). The
# suite runs it on macOS (bash 3.2, the BSD regex library) with --node, and in ubuntu:jammy (bash 5.1, glibc regex, the
# server's shell); common.sh sets LC_ALL=C there as on the server. With --node, every OPS_ADMIN_URL the check accepts
# must also give an https origin under the backend's opsAdminUrl() rules (backend b6d01cb src/services/opsSignIn.js,
# run here with node's URL parser), and every case marked "*" (refused here, though the backend reads it correctly: the
# kit accepts a stricter subset, 20-env.sh header OPS SETTINGS) must give an origin there. Prints one FAIL line per
# wrong case and one PASS line per setting whose cases all passed; exits 1 on any FAIL. Writes nothing.
set -euo pipefail
PKG="$1"; NODE="${2:-}"
# shellcheck source=../../common.sh
. "$PKG/common.sh"
fails=0; ok() { echo "PASS $*"; }; bad() { echo "FAIL $*"; fails=$((fails + 1)); }

TOK=$(printf '0123456789abcdef%.0s' 1 2 3 4)   # 64 lower-case hex characters
L63=$(printf 'a%.0s' $(seq 1 63)); L64="${L63}a"
R_NL='a line break or carriage return'; R_ON='not on or off'; R_TTL='not a whole number of seconds from 300 to 43200'
R_URL='not an https origin (https://<host>[:<port>], no user, path, query or fragment)'; R_PORT='a port above 65535'
R_NUM='an IP address or a numeric last label'; R_XN='a punycode (xn--) label'; R_HEX='not 64 lower-case hex characters'
CR=$'\r'; NL=$'\n'
# <name>|<value>|<expected>: "ok" (accepted) or the exact reason; a leading "*" marks a value the backend reads correctly.
CASES=(
  "OPS_SHARED_LOGIN|on|ok" "OPS_SHARED_LOGIN|off|ok"
  "OPS_SHARED_LOGIN|OFF|*$R_ON" "OPS_SHARED_LOGIN|Off|*$R_ON" "OPS_SHARED_LOGIN|off |*$R_ON" "OPS_SHARED_LOGIN| off|*$R_ON"
  "OPS_SHARED_LOGIN|\"off\"   # on or off|*$R_ON" "OPS_SHARED_LOGIN|of|$R_ON" "OPS_SHARED_LOGIN|false|$R_ON"
  "OPS_SHARED_LOGIN|off$CR|*$R_NL" "OPS_SHARED_LOGIN|off${NL}on|$R_NL"
  "OPS_USER_TOKEN_TTL_SEC|300|ok" "OPS_USER_TOKEN_TTL_SEC|3600|ok" "OPS_USER_TOKEN_TTL_SEC|43200|ok"
  "OPS_USER_TOKEN_TTL_SEC|0300|*$R_TTL" "OPS_USER_TOKEN_TTL_SEC|3600 |*$R_TTL" "OPS_USER_TOKEN_TTL_SEC|299|$R_TTL"
  "OPS_USER_TOKEN_TTL_SEC|43201|$R_TTL" "OPS_USER_TOKEN_TTL_SEC|100000|$R_TTL" "OPS_USER_TOKEN_TTL_SEC|12h|$R_TTL"
  "OPS_USER_TOKEN_TTL_SEC|1e3|$R_TTL" "OPS_USER_TOKEN_TTL_SEC|-1|$R_TTL" "OPS_USER_TOKEN_TTL_SEC|3600$CR|*$R_NL"
  "OPS_ADMIN_URL|https://admin.example.org|ok" "OPS_ADMIN_URL|https://admin.example.org/|ok"
  "OPS_ADMIN_URL|https://ADMIN.Example.org:8443/|ok" "OPS_ADMIN_URL|https://admin.example.org:1|ok"
  "OPS_ADMIN_URL|https://admin.example.org:443|ok" "OPS_ADMIN_URL|https://admin.example.org:65535|ok"
  "OPS_ADMIN_URL|https://localhost|ok" "OPS_ADMIN_URL|https://a--b.example.org|ok" "OPS_ADMIN_URL|https://0x1f.example.org|ok"
  "OPS_ADMIN_URL|https://admin.123b|ok" "OPS_ADMIN_URL|https://admin.0xg|ok" "OPS_ADMIN_URL|https://$L63.example.org|ok"
  "OPS_ADMIN_URL|http://localhost:8080|*$R_URL" "OPS_ADMIN_URL|HTTPS://admin.example.org|*$R_URL"
  "OPS_ADMIN_URL|https://admin.example.org:08443|*$R_URL" "OPS_ADMIN_URL|https://admin.example.org:0|*$R_URL"
  "OPS_ADMIN_URL| https://admin.example.org|*$R_URL" "OPS_ADMIN_URL|https://admin.example.org |*$R_URL"
  "OPS_ADMIN_URL|https://admin.example.org.|*$R_URL" "OPS_ADMIN_URL|https://a_b.example.org|*$R_URL"
  "OPS_ADMIN_URL|https://[::1]|*$R_URL" "OPS_ADMIN_URL|https://$L63.$L63.$L63.$L63.$L63.org|*$R_URL"
  "OPS_ADMIN_URL|http://admin.example.org|$R_URL" "OPS_ADMIN_URL|https://admin.example.org/ops|$R_URL"
  "OPS_ADMIN_URL|https://admin.example.org?next=1|$R_URL" "OPS_ADMIN_URL|https://admin.example.org#x|$R_URL"
  "OPS_ADMIN_URL|admin.example.org|$R_URL" "OPS_ADMIN_URL|https://lt-user@admin.example.org|$R_URL"
  "OPS_ADMIN_URL|https://-a.example.org|$R_URL" "OPS_ADMIN_URL|https://$L64.example.org|$R_URL"
  "OPS_ADMIN_URL|https://admin.example.org:123456|$R_URL" "OPS_ADMIN_URL|https://admin.example.org:99999|$R_PORT"
  "OPS_ADMIN_URL|https://admin.example.org:65536|$R_PORT" "OPS_ADMIN_URL|https://192.0.2.10|*$R_NUM"
  "OPS_ADMIN_URL|https://192.0.2.999|$R_NUM" "OPS_ADMIN_URL|https://admin.123|$R_NUM" "OPS_ADMIN_URL|https://admin.0x1f|$R_NUM"
  "OPS_ADMIN_URL|https://admin.0X|$R_NUM" "OPS_ADMIN_URL|https://xn--a.org|$R_XN" "OPS_ADMIN_URL|https://admin.XN--abc.org|$R_XN"
  "OPS_ADMIN_URL|https://admin.example.org${NL}https://b.example.org|$R_NL" "OPS_ADMIN_URL|https://admin.example.org$CR|*$R_NL"
  "PLANET_MANAGER_API_HOSTS|api.example.org|ok" "PLANET_MANAGER_API_HOSTS|api-rehearsal.datadance.ai, api.example.org|ok"
  "PLANET_MANAGER_API_HOSTS|a.example.org,,b.example.org|ok" "PLANET_MANAGER_API_HOSTS| api.example.org |ok"
  "PLANET_MANAGER_API_HOSTS|https://api.example.org|entry #1 is not a host name"
  "PLANET_MANAGER_API_HOSTS|api.example.org/x|entry #1 is not a host name"
  "PLANET_MANAGER_API_HOSTS|api.example.org:443|entry #1 is not a host name"
  "PLANET_MANAGER_API_HOSTS|api.example.org,lt host.example.org|entry #2 is not a host name"
  "PLANET_MANAGER_API_HOSTS|$L63.$L63.$L63.$L63|entry #1 is not a host name" "PLANET_MANAGER_API_HOSTS|,|no host name"
  "PLANET_MANAGER_API_HOSTS|a.example.org${NL}b.example.org|$R_NL" "PLANET_MANAGER_API_HOSTS|a.example.org$CR|*$R_NL"
  "STAFF_UNLOCK_TOKEN|$TOK|ok" "STAFF_UNLOCK_TOKEN|$(printf '%s' "$TOK" | tr 'a-f' 'A-F')|$R_HEX"
  "STAFF_UNLOCK_TOKEN|0x$TOK|$R_HEX" "STAFF_UNLOCK_TOKEN|${TOK%?}|$R_HEX" "STAFF_UNLOCK_TOKEN|${TOK}0|$R_HEX"
  "STAFF_UNLOCK_TOKEN|$TOK |*$R_HEX" "STAFF_UNLOCK_TOKEN|lt-not-hex-staff-unlock|$R_HEX" "STAFF_UNLOCK_TOKEN|$TOK$CR|*$R_NL"
)
URL_OK=(); URL_STRICT=(); i=0; failed=" "
for c in "${CASES[@]}"; do
  i=$((i + 1)); name=${c%%|*}; rest=${c#*|}; want=${rest##*|}; val=${rest%|*}; strict=0
  case "$want" in \**) strict=1; want=${want#\*};; esac
  if got=$(ops_value_refused "$name" "$val"); then :; else got=ok; fi
  if [ "$got" != "$want" ]; then bad "case #$i $name: expected '$want', got '$got'"; failed="$failed$name "; continue; fi
  if [ "$name" = OPS_ADMIN_URL ]; then
    if [ "$got" = ok ]; then URL_OK+=("$val"); elif [ "$strict" = 1 ]; then URL_STRICT+=("$val"); fi
  fi
done
for name in OPS_SHARED_LOGIN OPS_USER_TOKEN_TTL_SEC OPS_ADMIN_URL PLANET_MANAGER_API_HOSTS STAFF_UNLOCK_TOKEN; do
  a=0; r=0
  for c in "${CASES[@]}"; do
    [ "${c%%|*}" = "$name" ] || continue
    case "${c##*|}" in ok) a=$((a + 1));; *) r=$((r + 1));; esac
  done
  case "$failed" in *" $name "*) ;; *) ok "ops_value_refused $name: $a accepted and $r refused cases, each with its expected verdict";; esac
done

if [ "$NODE" = --node ]; then
  # The backend's opsAdminUrl() rules (b6d01cb): trimmed, new URL(), no user, password, query, fragment or path; https,
  # or http://localhost:<port>. Prints each value of the first group that gives no origin, and of the second group
  # ("--strict" onwards) each value that gives none.
  JS='const a = process.argv.slice(1); const k = a.indexOf("--strict");
function opsAdminUrl(raw0) { const raw = String(raw0).trim(); let url;
  try { url = new URL(raw); } catch { return null; }
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== "/" && url.pathname !== "") return null;
  if (url.protocol === "https:") return url.origin;
  if (url.protocol === "http:" && url.hostname === "localhost" && url.port) return url.origin;
  return null; }
const accepted = a.slice(0, k), strict = a.slice(k + 1);
for (const v of accepted) if (!opsAdminUrl(v) || !opsAdminUrl(v).startsWith("https://")) console.log("accepted by the kit, refused by the backend: " + JSON.stringify(v));
for (const v of strict) if (!opsAdminUrl(v)) console.log("listed as read by the backend, but it gives no origin: " + JSON.stringify(v));'
  out=$(node -e "$JS" ${URL_OK[@]+"${URL_OK[@]}"} --strict ${URL_STRICT[@]+"${URL_STRICT[@]}"} 2>&1) || out="node failed: $out"
  if [ -z "$out" ] && [ "${#URL_OK[@]}" -gt 0 ] && [ "${#URL_STRICT[@]}" -gt 0 ]; then
    ok "node $(node --version): the backend's opsAdminUrl() gives an https origin for all ${#URL_OK[@]} OPS_ADMIN_URL values the kit accepts, and an origin for the ${#URL_STRICT[@]} it refuses although the backend reads them"
  else printf '%s\n' "$out"; bad "OPS_ADMIN_URL: the kit and the backend's opsAdminUrl() disagree (accepted=${#URL_OK[@]}, stricter=${#URL_STRICT[@]})"; fi
fi
echo "ops-shape cases: ${#CASES[@]}, fails=$fails (bash $BASH_VERSION, LC_ALL=${LC_ALL:-unset})"
[ "$fails" = 0 ]
