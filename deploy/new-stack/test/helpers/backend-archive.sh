#!/usr/bin/env bash
# backend-archive.sh <package dir> <new work dir> <input dir>   (local test helper; touches no server)
# 10-build.sh --backend-archive (build a reviewed commit that is not on GitHub yet, for example a release candidate, from
# an uploaded archive, like the frontend) in local test mode, on what run-local-tests.sh section 8b prepared in
# <input dir>: sets/<name>/ with the three files remote.sh pack-api made from a throwaway signed commit (its id in
# sets/<name>/sha, its tree as `<path> f-|fx|l <target>` lines in sets/<name>/tree), and upload/ with what upload-api
# sent through a stub ssh (ssh-cmd.<n>: the remote command, ssh-stdin.<n>: its stdin).
# Stubs: docker (a build only records its arguments and its context; a run answers what the checks expect; no container
# exists) and df; a scratch old tree. So the whole script runs, the unpacked tree goes through every later check, and
# step 6 writes .env. Runs on macOS (bash 3.2, BSD tools) and in ubuntu:jammy (bash 5.1, GNU tar, find, coreutils; git,
# python3, rsync and openssl installed). Prints PASS/FAIL lines; exit 1 on FAIL.
#   - upload-api's three remote commands, run against a scratch directory: sha256sum -c passes for both files;
#   - the happy path on that upload (old-App record 1) and on a commit without PR #38 (record 0): .env, the build
#     context, the unpacked tree; a re-run reuses the identical tree; a changed tree and a git clone in its place stop;
#   - each stops in step 1, before any build: wrong sha, commit id mismatch, tampered archive (also with a matching
#     sidecar), sidecar mismatches, a missing, malformed or contradicting old-App record, and trees that fail a later
#     check (.env* file, .dockerignore without **/.env);
#   - with BA_GIT (the real git) and BA_CLONE (the throwaway clone) set, on macOS: without the flag the clean public fetch
#     runs as before (a git wrapper points the public URL at the clone), even with an uploaded archive present.
set -u
PKG="$1"; WK="$2"; IN="$3"
fails=0; ok() { echo "PASS $*"; }; bad() { echo "FAIL $*"; fails=$((fails+1)); }
[ ! -e "$WK" ] || { echo "FAIL work dir $WK exists; pass a new one"; exit 1; }
mkdir -p "$WK"
h() { if command -v sha256sum >/dev/null 2>&1; then sha256sum | cut -c1-64; else shasum -a 256 | cut -c1-64; fi; }
AH=api-rehearsal.datadance.ai   # common.sh's default API_HOST
OAC=$( . "$PKG/common.sh"; printf '%s' "$OLD_APP_COMMIT")
S1=$(cat "$IN/sets/rc1/sha"); S0=$(cat "$IN/sets/rc0/sha"); SE=$(cat "$IN/sets/dotenv/sha"); SD=$(cat "$IN/sets/nodi/sha")

# --- stubs and the scratch old tree
ST="$WK/stub"; mkdir -p "$ST"
cat > "$ST/docker" <<'STUB'
#!/bin/sh
# stub docker for 10-build.sh: no container exists; a build records its arguments and its context's entries
case "$1" in
  ps) exit 0;;
  buildx) echo "Driver: docker"; exit 0;;
  info) echo "cgroupfs 2"; exit 0;;
  build) echo "build $*" >> "$STUB_DIR/calls"; for a; do ctx="$a"; done
         (cd "$ctx" && ls -A) > "$STUB_DIR/context-$(basename "$ctx").ls"; exit 0;;
  image) echo 1MB; exit 0;;
  inspect) exit 1;;
  system) printf 'Images 1GB 0B\nBuild Cache 0B 0B\n'; exit 0;;
  run) case "$*" in
         *ddc-build.json*) printf '{"mode":"tge","apiEnv":"tge","apiBaseUrl":"https://%s/api","w3aNetwork":"sapphire_mainnet","chainId":44508,"w3aClientId":"BBpkxUTUrStub"}\n' "$STUB_API_HOST";;
         *"find /app"*|*BGiGcxrX*) echo 0;;
       esac; exit 0;;
esac
exit 0
STUB
cat > "$ST/df" <<'STUB'
#!/bin/sh
# stub df: plenty of free space (GNU --output=avail and POSIX -Pk forms)
case "$*" in
  *--output=avail*) printf '     Avail\n%s\n' 1099511627776;;
  *) printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\nstub 2147483648 1 1073741824 1%% /\n';;
esac
STUB
chmod 755 "$ST/docker" "$ST/df"
# macOS only, where BSD tools differ from the server's GNU ones in what 10-build.sh relies on: BSD wc pads its count
# with blanks (10-build.sh compares one count as a string), and macOS zcat looks for <file>.Z (step 4 reads the
# frontend tarball with zcat).
if ! wc --version >/dev/null 2>&1; then printf '#!/bin/sh\n/usr/bin/wc "$@" | sed "s/^ *//"\n' > "$ST/wc"; chmod 755 "$ST/wc"; fi
printf 'z\n' | gzip -c > "$ST/z.gz"
if ! zcat "$ST/z.gz" >/dev/null 2>&1; then printf '#!/bin/sh\nexec gzip -dc "$@"\n' > "$ST/zcat"; chmod 755 "$ST/zcat"; fi
rm -f "$ST/z.gz"
OB="$WK/old/ddc-backend"; mkdir -p "$OB/keys_fixed" "$OB/campaign-covers" "$OB/passes" "$WK/none"
printf 'synthetic public certificate\n' > "$OB/keys_fixed/wwdr.pem"
printf 'synthetic production apn key\n' > "$OB/keys_fixed/apn_key.p8"
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=fake production signer" -keyout "$OB/keys_fixed/signerKey.pem" -out "$OB/keys_fixed/signerCert.pem" >/dev/null 2>&1 \
  || bad "setup: openssl could not make the fake production signer"
printf 'c\n' > "$OB/campaign-covers/a.png"; printf 'p\n' > "$OB/passes/b.pkpass"
printf 'MemTotal:       16000000 kB\nMemAvailable:    8000000 kB\n' > "$WK/meminfo"
# The frontend upload every case gets, made the way pack-web makes it (git archive of a throwaway commit, whose id is
# then the frontend sha), for the default API host.
mkdir -p "$WK/fe/src/config"
printf "export const API_BASE_URLS = {\n  tge: 'https://%s/api',\n};\n" "$AH" > "$WK/fe/src/config/environment.ts"
printf 'VITE_MODE=tge\n' > "$WK/fe/.env.tge"; printf 'FROM nginx:stable\nARG VITE_MODE\nARG VITE_API_ENV\n' > "$WK/fe/Dockerfile"
FE40=$(export GIT_AUTHOR_DATE=2026-10-10T12:00:00+0800 GIT_COMMITTER_DATE=2026-10-10T12:00:00+0800   # the same id on every run
       git -C "$WK/fe" init -q && git -C "$WK/fe" add -A && git -C "$WK/fe" -c user.name=ddcnew-local-test -c user.email=ddcnew-local-test@example.invalid -c core.hooksPath=/dev/null \
         commit -q --no-gpg-sign -m "throwaway frontend of the local test" && git -C "$WK/fe" rev-parse HEAD) || bad "setup: the throwaway frontend commit"
git -C "$WK/fe" archive --format=tar.gz -o "$WK/fe.tgz" HEAD && h < "$WK/fe.tgz" > "$WK/fe.tgz.sha256" || bad "setup: the frontend archive"

nd_for() { # <case> [set name]: a fresh NEW_DIR (in $ND) with the frontend upload and that set's three files
  ND="$WK/case-$1"; mkdir -p "$ND/src" "$ND.stub"
  cp "$WK/fe.tgz" "$ND/src/ddc-frontend-$FE40.tar.gz"; cp "$WK/fe.tgz.sha256" "$ND/src/ddc-frontend-$FE40.tar.gz.sha256"
  if [ -n "${2:-}" ]; then cp "$IN/sets/$2"/ddc-backend-* "$ND/src/"; fi
}
b10() { # <be sha> [10-build.sh flags...]: runs on $ND; output in $ND.out, status in $RC; the stub's calls start empty
  local sha="$1"; shift; RC=0; rm -f "$ND.stub/calls"
  env PATH="${BA_PATH_PREFIX:-}$ST:$PATH" STUB_DIR="$ND.stub" STUB_API_HOST="$AH" DDC_LOCAL_TEST=1 NEW_DIR="$ND" \
    OLD_BACKEND_DIR="$OB" OLD_APP_DIR="$WK/old/ddc" OLD_ENV="$OB/backend.env" NGINX_AVAIL="$WK/none" NGINX_ENABLED="$WK/none" \
    NGINX_CONFD="$WK/none" MAINNET_DIR="$WK/none" DDC_MEMINFO="$WK/meminfo" BUILD_WATCH_INTERVAL=1 \
    bash "$PKG/10-build.sh" "$sha" "$FE40" --infra-only "$@" > "$ND.out" 2>&1 || RC=$?
}
builds() { if [ -f "$ND.stub/calls" ]; then grep -c '^build ' "$ND.stub/calls" || true; else echo 0; fi; }
has() { grep -qxF -- "$1" "$ND.out"; }
listing() { # <dir>: "<path> f-|fx|l <target>" for every entry that is not a directory, sorted (the form of sets/*/tree)
  ( cd "$1" && find . -mindepth 1 ! -type d | while IFS= read -r p; do
      q="${p#./}"
      if [ -L "$p" ]; then printf '%s l %s\n' "$q" "$(readlink "$p")"
      elif [ -x "$p" ]; then printf '%s fx\n' "$q"
      else printf '%s f-\n' "$q"; fi
    done | LC_ALL=C sort )
}
envfile() { # <old-App 0|1> <sha12> [archive]: the .env that 10-build.sh writes for an --infra-only build
  printf 'API_IMAGE=ddcnew/backend:%s-infra\nWEB_IMAGE=ddcnew/web:tge-%s\nINFRA_ONLY=1\nOLD_APP_SWITCHES=%s\n' "$2" "${FE40:0:12}" "$1"
  if [ "${3:-}" = archive ]; then printf 'BACKEND_SOURCE=archive\n'; fi
}
stops() { # <label> <expected FAIL text (fixed string, a prefix of the line)> [dir that must not exist]
  if [ "$RC" = 1 ] && grep -qF -- "FAIL $2" "$ND.out" && [ "$(builds)" = 0 ] && { [ -z "${3:-}" ] || [ ! -e "$3" ]; } && ! ls -d "$ND"/src/*.unpack >/dev/null 2>&1; then
    ok "$1: stops in step 1 before any build ($(grep -F -- "FAIL $2" "$ND.out" | head -n 1 | cut -c1-150))"
  else tail -n 4 "$ND.out" | sed 's/^/    /'; bad "$1 (rc=$RC builds=$(builds))"; fi
}

# --- upload-api's three remote commands against a scratch directory (the server's /root/ddcnew/src)
SRV="$WK/srv/src"
n=0; uout=""
for i in 1 2 3; do
  cmd=$(sed "s#/root/ddcnew/src#$SRV#g" "$IN/upload/ssh-cmd.$i")
  uout="$uout$(sh -c "$cmd" < "$IN/upload/ssh-stdin.$i" 2>&1)" && n=$((n + 1))
done
B1="ddc-backend-$S1.tar.gz"
if [ "$n" = 3 ] && printf '%s\n' "$uout" | grep -qx "$B1: OK" && printf '%s\n' "$uout" | grep -qx "$B1.old-app: OK" \
   && cmp -s "$SRV/$B1" "$IN/sets/rc1/$B1" && cmp -s "$SRV/$B1.old-app" "$IN/sets/rc1/$B1.old-app" && cmp -s "$SRV/$B1.sha256" "$IN/sets/rc1/$B1.sha256"; then
  ok "upload-api's three remote commands on a scratch src/: the three files arrive byte for byte and sha256sum -c ($(command -v sha256sum)) says OK for the tarball and the old-App record"
else printf '%s\n' "$uout" | sed 's/^/    /'; bad "upload-api's remote commands (ran $n of 3)"; fi

# --- happy path: the uploaded files, then 10-build.sh --backend-archive to its end
nd_for happy; cp "$SRV"/ddc-backend-* "$ND/src/"
b10 "$S1" --backend-archive
D="$ND/src/backend-${S1:0:12}"
if [ "$RC" = 0 ] && has "== 1. backend source: uploaded git-archive tarball of $S1 (--backend-archive)" \
   && has "backend PR #38's old-App line (${OAC:0:12}): in this commit: 40-up.sh requires it" \
   && has "PASS backend source: tarball and old-App record sha256 ok, commit id ${S1:0:12}, unpacked to $D" \
   && has "PASS PR #25 (.dockerignore) and #27 (mainnetSwitch.js) present; no .env* in the clone" \
   && cmp -s "$ND/.env" <(envfile 1 "${S1:0:12}" archive) && [ "$(builds)" = 2 ] \
   && grep -qE "^build .* -t ddcnew/backend:${S1:0:12}-infra $D\$" "$ND.stub/calls"; then
  ok "happy path: 10-build.sh --backend-archive runs to its end; the old-App record's 1 is in .env with BACKEND_SOURCE=archive; the backend image is built from $D"
else tail -n 8 "$ND.out" | sed 's/^/    /'; bad "happy path (rc=$RC builds=$(builds))"; fi
if [ -d "$D" ] && [ ! -e "$D/.git" ] && [ ! -e "$D.unpack" ] && [ "$(listing "$D")" = "$(cat "$IN/sets/rc1/tree")" ] \
   && cmp -s "$ND.stub/context-backend-${S1:0:12}.ls" <(cd "$D" && ls -A); then
  ok "the unpacked tree is exactly the commit's tree ($(grep -c . "$IN/sets/rc1/tree") entries: contents, the executable bit and the symlink), no .git, no temporary directory left; it is the build context"
else listing "$D" | diff - "$IN/sets/rc1/tree" | head -10 | sed 's/^/    /'; bad "unpacked tree"; fi
b10 "$S1" --backend-archive
[ "$RC" = 0 ] && has "reusing $D: identical to the archive" && cmp -s "$ND/.env" <(envfile 1 "${S1:0:12}" archive) \
  && ok "a re-run reuses the identical unpacked tree" || { tail -n 4 "$ND.out" | sed 's/^/    /'; bad "re-run (rc=$RC)"; }
printf 'changed\n' >> "$D/env.example"; b10 "$S1" --backend-archive
stops "an unpacked tree changed since" "$D exists and differs from the archive"
grep -qx changed "$D/env.example" && ok "  ... and the changed tree is left as it was (refused, not replaced)" || bad "the changed tree was replaced"
rm -rf "$D"; b10 "$S1" --backend-archive; [ "$RC" = 0 ] || bad "fresh unpack after removing the tree (rc=$RC)"
mkdir "$D/.git"; printf 'ref: refs/heads/main\n' > "$D/.git/HEAD"; b10 "$S1" --backend-archive
stops "a git clone at that path (an earlier build from the public repository)" "$D exists and differs from the archive"

nd_for zero rc0; b10 "$S0" --backend-archive
[ "$RC" = 0 ] && has "backend PR #38's old-App line (${OAC:0:12}): not in this commit: inert" && cmp -s "$ND/.env" <(envfile 0 "${S0:0:12}" archive) \
  && ok "a commit without PR #38 (old-App record 0): 'not in this commit: inert', OLD_APP_SWITCHES=0 in .env" || { tail -n 6 "$ND.out" | sed 's/^/    /'; bad "record 0 (rc=$RC)"; }

# --- each stops in step 1, before any build
B="ddc-backend-$S1.tar.gz"
d1() { printf '%s/src/backend-%s' "$ND" "${S1:0:12}"; }   # where this case would unpack $S1
resum() { (cd "$ND/src" && { printf '%s  %s\n' "$(h < "$B")" "$B"; printf '%s  %s\n' "$(h < "$B.old-app")" "$B.old-app"; } > "$B.sha256"); }
nd_for wrongsha rc1; b10 "$S0" --backend-archive
stops "wrong sha (only another commit's archive uploaded)" "upload first: remote.sh pack-api $S0, then upload-api $S0" "$ND/src/backend-${S0:0:12}"
nd_for commitid; for f in "$IN/sets/rc0"/ddc-backend-*; do cp "$f" "$ND/src/$(basename "$f" | sed "s/$S0/$S1/")"; done; resum
b10 "$S1" --backend-archive
stops "commit id mismatch (another commit's archive under this sha's names, sidecar rewritten to match)" "backend tarball commit id is '$S0', expected $S1" "$(d1)"
nd_for tamper rc1; printf 'x' >> "$ND/src/$B"; b10 "$S1" --backend-archive
stops "tampered archive (one byte appended)" "backend tarball sha256 mismatch ($B)" "$(d1)"
nd_for tamper2 rc1; gzip -dc < "$IN/sets/rc1/$B" | gzip -1 > "$ND/src/$B"; resum; b10 "$S1" --backend-archive
stops "another archive of the same commit with a matching sidecar (recompressed)" "the old-App record $ND/src/$B.old-app is for another archive" "$(d1)"
nd_for sidecar rc1; sed "1s/^./$(head -c 1 "$IN/sets/rc1/$B.sha256" | tr '0-9a-f' '1-9a-f0')/" "$IN/sets/rc1/$B.sha256" > "$ND/src/$B.sha256"; b10 "$S1" --backend-archive
stops "sidecar mismatch (the tarball's sum changed)" "backend tarball sha256 mismatch ($B)" "$(d1)"
nd_for sidecar1 rc1; head -n 1 "$IN/sets/rc1/$B.sha256" > "$ND/src/$B.sha256"; b10 "$S1" --backend-archive
stops "sidecar with the tarball only (the frontend's one-line form)" "$ND/src/$B.sha256 does not list exactly $B and $B.old-app" "$(d1)"
nd_for sidecar2 rc1; sed 's/old_app_switches=1/old_app_switches=0/' "$IN/sets/rc1/$B.old-app" > "$ND/src/$B.old-app"; b10 "$S1" --backend-archive
stops "old-App record changed after packing (sidecar not rewritten)" "old-App record sha256 mismatch ($B.old-app)" "$(d1)"
nd_for norecord rc1; rm "$ND/src/$B.old-app"; b10 "$S1" --backend-archive
stops "old-App record missing" "the old-App record $ND/src/$B.old-app is missing" "$(d1)"
R="$IN/sets/rc1/$B.old-app"
malformed() { # <label> <case name>; the changed record on stdin
  nd_for "malformed-$2" rc1; cat > "$ND/src/$B.old-app"
  if cmp -s "$R" "$ND/src/$B.old-app"; then bad "test setup: the record for '$1' is unchanged"; return 0; fi
  resum; b10 "$S1" --backend-archive
  stops "malformed old-App record ($1; sidecar rewritten to match)" "the old-App record $ND/src/$B.old-app is malformed" "$(d1)"
}
malformed "old_app_switches=2" two < <(sed 's/^old_app_switches=1$/old_app_switches=2/' "$R")
malformed "an empty value" empty < <(sed 's/^old_app_switches=1$/old_app_switches=/' "$R")
malformed "a fifth line" fifth < <(cat "$R"; echo extra=1)
malformed "the commit line twice" twice < <(sed -n '1p' "$R"; cat "$R")
malformed "CRLF line ends" crlf < <(sed "s/\$/$(printf '\r')/" "$R")
malformed "the first two lines swapped" swapped < <(awk 'NR == 1 { a = $0; next } NR == 2 { print; print a; next } { print }' "$R")
malformed "no newline at the end" nonl < <(printf '%s' "$(cat "$R")")
malformed "upper-case hex in the commit id" upper < <(sed "s/^commit=.*/commit=$(printf '%s' "$S1" | tr 'a-f' 'A-F')/" "$R")
nd_for othercommit rc1; sed "s/^commit=.*/commit=$S0/" "$R" > "$ND/src/$B.old-app"; resum; b10 "$S1" --backend-archive
stops "old-App record for another commit (sidecar rewritten)" "the old-App record $ND/src/$B.old-app is for commit $S0, not $S1" "$(d1)"
nd_for otherpr rc1; sed "s/^old_app_commit=.*/old_app_commit=$S0/" "$R" > "$ND/src/$B.old-app"; resum; b10 "$S1" --backend-archive
stops "old-App record naming another PR #38 commit (sidecar rewritten)" "the old-App record $ND/src/$B.old-app checked ${S0:0:12} as backend PR #38's commit" "$(d1)"
# the later checks of step 1, unchanged, on the unpacked tree
nd_for dotenv dotenv; b10 "$SE" --backend-archive
stops "a commit whose tree has a .env* file: the unchanged .env* check on the unpacked tree" "1 .env* files in the clone"
nd_for nodi nodi; b10 "$SD" --backend-archive
stops "a commit whose .dockerignore lacks **/.env: the unchanged PR #25 check on the unpacked tree" ".dockerignore with **/.env missing: PR #25 is not in this commit"

# --- without the flag: the clean public fetch, as before (macOS only: needs the throwaway clone)
if [ -n "${BA_GIT:-}" ] && [ -n "${BA_CLONE:-}" ]; then
  GW="$WK/gitwrap"; mkdir -p "$GW"
  cat > "$GW/git" <<EOF
#!/bin/sh
# git wrapper: the public repository URL becomes the throwaway clone (no network); every call is recorded
for a; do shift; if [ "\$a" = https://github.com/DataDanceChain/data-dance-backend.git ]; then set -- "\$@" "file://$BA_CLONE"; else set -- "\$@" "\$a"; fi; done
echo "git \$*" >> "$GW/calls"
exec "$BA_GIT" "\$@"
EOF
  chmod 755 "$GW/git"
  nd_for public rc1; D=$(d1); before=$(cat "$ND/src/$B" "$ND/src/$B.old-app" "$ND/src/$B.sha256" | h)
  BA_PATH_PREFIX="$GW:" b10 "$S1"
  if [ "$RC" = 0 ] && has "== 1. backend source: clean clone of https://github.com/DataDanceChain/data-dance-backend.git at $S1" \
     && grep -qF "PASS backend HEAD=${S1:0:12} \"lt release candidate" "$ND.out" && has "backend PR #38's old-App line (${OAC:0:12}): in this commit: 40-up.sh requires it" \
     && ! grep -q 'backend-archive\|old-App record\|BACKEND_SOURCE' "$ND.out" && cmp -s "$ND/.env" <(envfile 1 "${S1:0:12}") && [ -d "$D/.git" ] \
     && grep -qx "git -C $D fetch -q --depth 1 file://$BA_CLONE $S1" "$GW/calls" && grep -qx "git -C $D fetch -q --shallow-since=2026-10-01 file://$BA_CLONE $S1" "$GW/calls" \
     && [ "$(cat "$ND/src/$B" "$ND/src/$B.old-app" "$ND/src/$B.sha256" | h)" = "$before" ]; then
    ok "without --backend-archive (an uploaded archive present): the clean public fetch at the sha and its history since 2026-10-01, the ancestor check on that history, .env with the four lines as before (no BACKEND_SOURCE); the archive is not used"
  else tail -n 8 "$ND.out" | sed 's/^/    /'; sed 's/^/    git> /' "$GW/calls" 2>/dev/null | head -8; bad "flag absent (rc=$RC)"; fi
else echo "(the case without the flag runs on macOS only: BA_GIT and BA_CLONE not set)"; fi

[ "$fails" = 0 ] && echo "backend-archive.sh: all passed" || echo "backend-archive.sh: $fails failed"
[ "$fails" = 0 ]
