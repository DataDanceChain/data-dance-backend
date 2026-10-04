# New production stack (`ddcnew`): approval package

What each script changes on the server, its pass criteria, its undo, and the safety rules built into all of them.
Nothing here runs on the server without Sloan's approval for that step (`DDC_APPROVED=yes`). The server's address,
the current findings about it, its measurements and the commands of the hardening steps are in the **private Drive
runbook**; this file describes the scripts only.

**In scope:** P1 backup, P2 disk cleanup, and a new stack `ddcnew` running on an **empty** rehearsal database behind
`tge-api.datadance.ai` and `tge-app.datadance.ai`.
**Out of scope, each with its own approval:** the disk expansion, the hardening gate (section 7), copying production
data into the new stack, and the cutover. Section 7 lists what must be done **before any production data lands on the
new stack**.

## 1. Approvals and inputs needed before execution

| # | Item | Who | Blocks |
|---|---|---|---|
| A | Approve P1 (`p1-backup.sh`: dump, verify, install-cron). Run the first dump before the next TGE data refresh in the old backend. | Sloan | P1 |
| B | Approve P2 cleanup (`p2-disk.sh apply`: build cache prune and journal vacuum only). Whether it is enough is printed by `p2-disk.sh preview` (section 3). | Sloan | P2 |
| C | Approve the new-stack scripts `10-build.sh`, `20-env.sh`, `30-nginx.sh`, `40-up.sh`, with `99-teardown.sh` as the undo. | Sloan | build |
| D | Reconcile the production-only code: the live backend runs overlay files and container-layer changes on top of its image (`00-preflight.sh` lists them). Merge them into this repository or drop them on purpose, pin the backend commit, and build with `--overlays-reconciled`. **Until then** only `--infra-only` builds are possible (section 2, image gate). | Race + audit owner | build for data; not for the empty stack |
| E | Merge the backend PRs that `10-build.sh` checks for (#25 `.dockerignore`, required; #27 mainnet switch; #19 if wanted) and name the backend commit. Merge frontend PR #18 (`env-split`) and name the frontend commit. | Race / orchestrator | build |
| F | DNS: proxied records `tge-api` and `tge-app` that point at the production host (address in the private runbook), and a WAF custom rule (Block): `(http.host in {"tge-api.datadance.ai" "tge-app.datadance.ai"} and not ip.src in {<team addresses>})`. | whoever holds the `datadance.ai` zone | external check |
| G | The team's address list for that WAF rule. | Sloan | F |
| H | Web3Auth **mainnet** project allow-list: add `https://tge-app.datadance.ai`. | Sloan | logins in rehearsal |
| I | `local.env` on the operator's Mac (values from the private runbook) and 1Password CLI approval at each login. | Sloan | remote runs |
| J | The rehearsal keeps `OPS_ADMIN_USERNAME` / `OPS_ADMIN_PASSWORD` from production (own-stack ops console, not a third party; blank answers 503 "not configured"). Keep, or blank them for the rehearsal? Default: kept. | Sloan | data step |
| K | The gate in section 7, each item with its own approval, **before any production data is restored**. | Sloan | data step |
| L | Apple Wallet pass signing in the rehearsal. **Default: no production key.** The rehearsal gets a throwaway RSA key and a self-signed `signerCert.pem` (`10-build.sh`), so pass creation fails or yields a pass Wallet rejects; boot is unaffected. Real pass signing in the rehearsal needs an approval and a script change (`40-up.sh` refuses the production files). The cutover copies the production `signerKey.pem`, `signerCert.pem` and `apn_key.p8` under its own approval. | Sloan | nothing (default holds) |
| M | `P1_USERS_MIN` for `p1-backup.sh verify`: the minimum number of users in a complete dump. It is a production figure, so it is in the private runbook, not here. | Sloan | P1 verify |

## 2. Decisions taken in this package

- **Images are built on the server, without a registry.**
  - **Backend:** clean `git fetch --depth 1` of this public repository at the pinned SHA. The script checks that HEAD
    equals the SHA, the tree is clean, `.dockerignore` (PR #25) and `scripts/mainnetSwitch.js` (PR #27) are present,
    and the image has 0 `.env*` files.
  - **Frontend (private repository):** `remote.sh pack-web` makes a `git archive` tarball of the pinned commit into
    `out/` (gitignored). `upload-web` copies it to the server, and `10-build.sh` checks its sha256 and its embedded
    commit id (`git get-tar-commit-id`), then builds with `VITE_MODE=tge VITE_API_ENV=tge`.
  - **Why not build the frontend locally and ship the image:** building on the server runs the same Dockerfile and vite
    guards as the team's builds; no credentials are placed on the server; there is no image transfer of more than 1 GB
    and no amd64 emulation on the Mac. The cost is a few GB of build cache and a node build on a host with no swap (see
    the watchdog below).
- **Image gate (`10-build.sh`, exactly one flag):**
  - `--overlays-reconciled`: after item D. Tags `ddcnew/backend:<sha12>`, writes `INFRA_ONLY=0` into `/root/ddcnew/.env`.
  - `--infra-only`: tags `ddcnew/backend:<sha12>-infra`, writes `INFRA_ONLY=1`, and `40-up.sh` prints a banner at start
    and end: *this image lacks the production-only code and must not be used for a rehearsal with production data or for
    the cutover.* Every future data-restore step must call `refuse_if_infra_only` (`common.sh`) first; it refuses unless
    `INFRA_ONLY=0` (fail-closed: a missing `.env` or value also refuses). `40-up.sh` refuses if the tag and the flag disagree.
  - Both flags together, no flag, or any other argument: refused.
- **Memory and disk watchdog (`10-build.sh`, `common.sh run_build_watched`):** the host has no swap, and the old
  Postgres and API share it and its disk. Before each build the script needs MemAvailable >= 3000 MB. During each
  `docker build` it polls every 2 s and stops the build when MemAvailable falls below **1000 MB** or the free space on
  `/` below **3 GB**, or when either cannot be read: SIGTERM to the docker client (BuildKit cancels the running step),
  SIGKILL after 10 s, then SIGKILL to every BuildKit RUN-step process still alive (this would also stop another build
  running on the host at that moment); it then fails with `BUILD STOPPED BY THE WATCHDOG: <reason>`. Only the embedded
  builder (buildx driver `docker`) is accepted. On the server the floors can only be raised (`BUILD_MEM_FLOOR_MB` >=
  1000, `BUILD_DISK_FLOOR_MB` >= 3072), and the meminfo and /proc paths cannot be overridden.
  - **OOM preference and SIGKILL fallback:** a RUN step inherits dockerd's `oom_score_adj` (-500), lower than the old
    containers' 0, so unmarked the kernel would pick the old Postgres before the build. On every poll the watchdog sets
    `oom_score_adj=1000` on the RUN-step processes. The selector (`common.sh buildkit_step_rows`) takes
    `/docker/buildkit/<id>` (cgroupfs driver), `/system.slice/system.slice:docker:<id>` (systemd driver, docker 29.1.3
    on cgroup v2) and, should another docker/runc version use systemd scopes for steps, a `/system.slice/docker-<id>.scope`
    whose id is a 25-character BuildKit id or 64 hex **and** is not a container listed by `docker ps -aq --no-trunc`
    before or after the scan; if either listing fails or is empty, no scope process is taken. A process of a listed
    container (the old stack included) is never touched. The SIGKILL fallback re-checks each process's cgroup right
    before the signal.
  - The watchdog prints the docker cgroup driver at start (`00-preflight.sh` prints it too) and **warns** after a build
    in which it never marked a step process (every step cached, or the selector inactive on that driver).
  - **Closed SSH session:** `remote.sh` allocates no tty, so a dropped connection or Ctrl-C on the Mac sends the script
    no SIGHUP. SIGPIPE is ignored while a build runs, `kill_build` runs before anything is printed, and every watchdog
    line tolerates a closed stdout. In normal use the stdout of a write script is the pipe to its server-side log
    (section 4), which stays open, so the script simply runs to its end.
- **Rehearsal credentials (`20-env.sh`; financial-grade rule).** The rehearsal must not be able to sign chain
  transactions with the production wallet or take a nonce from it, and must not send anything real to real users.
  Each name was checked against the backend code:

  | Name(s) | In rehearsal | When blank or absent |
  |---|---|---|
  | `BACKEND_WALLET_PRIVATE_KEY` | **removed** | Boot: not read. Use: `src/utils/commerceAttestChain.js` falls back to `CHAIN_SIGNER_PRIVATE_KEY`, gets no wallet and returns `pending` (soft). Commerce attestations stay `pending` in the rehearsal, which is expected. |
  | `CHAIN_SIGNER_PRIVATE_KEY` (in `env.example`) | **removed** if present | Boot: one warning (`src/server.js` `warnIfChainSignerUnavailable`, soft). Use: `src/utils/web3Utils.js` signing calls fail with an error naming the variable (commerce attestation catches it: `pending`). |
  | `BSC_PAYOUT_PRIVATE_KEY` | **removed** if present | Payouts also off: `DISBURSEMENT_PAUSED=true`. |
  | any other `*_PRIVATE_KEY` / mnemonic / seed name (rule `is_signing_key`) | **removed** | `GOOGLE_WALLET_PRIVATE_KEY` falls under it: see Google Wallet. |
  | `SMTP_*` | blank | Boot: `src/utils/email.js` warns, transporter disabled (soft). No mail. |
  | `X_CLIENT_ID`, `X_CLIENT_SECRET`, `X_BEARER_TOKEN` (+ `X_OAUTH_ACCESS_TOKEN*` if present) | blank | Boot: `src/utils/xClient.js` logs `Missing X_BEARER_TOKEN` (soft). Use: X post lookups get 401 from X; X account binding fails at the token exchange (hard for those requests). No X call in the production app's name. `X_API_URL`, `X_OAUTH_CALLBACK_URL` and the rate-limit values are kept (not credentials). |
  | `GOOGLE_WALLET_ISSUER_ID`, `GOOGLE_WALLET_SERVICE_ACCOUNT` blank; `GOOGLE_WALLET_PRIVATE_KEY` removed | blank / removed | Use: `googleWalletController.createGenericObject` and `googleWalletUtils.generateJWT` fail (hard per request). No Google Wallet object is created or updated. |
  | `GEMINI_API_KEY` | blank | Use: `src/services/lifeContextGemini.js` throws `NO_GEMINI` "Gemini is not configured" (soft, handled). No production quota used. `GEMINI_DEFAULT_MODEL` kept. |
  | `MAPBOX_ACCESS_TOKEN`, `REACT_APP_MAPBOX_TOKEN`, `SEESAW_DISBURSEMENT_API_KEY`, `DISBURSEMENT_PARTNER_KEYS` | blank if present | Geocoding returns nothing; partner disbursement auth refuses. |
  | `APNS_KEY_ID`, `APNS_TEAM_ID` | **kept: required to boot** | `src/controllers/passWebServiceController.js` builds an `apn.Provider` when it is loaded, and apn 2.2.0 throws without them or without a key file. So `10-build.sh` puts a **throwaway P-256 `apn_key.p8`** into `/root/ddcnew/keys_fixed` instead of the production key: the provider starts and Apple rejects every push (403 InvalidProviderToken), so no push reaches a real device. The mount covers `/app/keys_fixed`, so no key file baked into the image is used; `40-up.sh` checks that the running api sees the mounted throwaway key. |
  | `PASS_TYPE_ID` (identifier), `wwdr.pem` (Apple's public WWDR certificate) | kept | Needed by the pass code path; neither is a secret. |
  | `signerKey.pem` (**production private key**: signs Apple Wallet passes as DataDance) and `signerCert.pem` | **replaced by a throwaway pair** (item L) | `10-build.sh` writes a throwaway RSA-2048 key and a self-signed certificate (mode 400) into `/root/ddcnew/keys_fixed`, and regenerates them if they are missing, mismatched or equal to production. Boot: not read (`passController.js` reads them per request). `40-up.sh` refuses to start if either file equals production and checks that the running api sees the mounted throwaway `signerKey.pem`. |
  | `OPS_ADMIN_USERNAME`, `OPS_ADMIN_PASSWORD`, `OPS_ADMIN_TOKEN_EXPIRES` | kept (item J) | Own-stack ops console; tokens are signed with the rehearsal's own `JWT_SECRET`. |
  | `DDC_CHAIN_RPC_URL`, `DDC_CHAIN_ID`, `METADATA_BASE_URL`, `TEST_USER_EMAIL`, ... | kept | Not credentials. |

  **Fail-closed rule (every name, not only credential-looking ones):**
  - Removal rule `is_signing_key`: any name *containing* `PRIVATE_KEY`, `PRIVATEKEY`, `PRIVKEY`, `MNEMONIC`, `SEED`,
    `SECRET_PHRASE` or `KEYSTORE`, or with a `PK` token, is removed (e.g. `HOT_WALLET_PRIVATEKEY`, `DEPLOYER_PK`).
  - Every other name that still has a value must be in one class: set by `20-env.sh` (including the blanked ones), the
    unchanged Web3Auth list, the kept credentials (`APNS_KEY_ID`, `PASS_TYPE_ID`, `OPS_ADMIN_PASSWORD`,
    `OPS_ADMIN_TOKEN_EXPIRES`; the script's own `JWT_SECRET`, `SSO_SESSION_SECRET`, `SSO_TGE_CLIENT_SECRET_SHA256`), or
    `KEPT_PLAIN`, the explicit list of the known non-secret names. Any other name stops `20-env.sh`, printing the name and
    never the value. So `APIKEY`, `OSS_ACCESSKEYSECRET`, `REDIS_URL`, `SENTRY_DSN`, `SLACK_WEBHOOK_URL` or any new vendor
    key stop the script until someone classifies it.
  - Every copied value (except the declared `OPS_ADMIN_PASSWORD`) is also refused if it carries `user:password@` in a
    URL, a PEM key block, or a bare or `0x` 32-byte hex key, whatever its name.
  - All checks run on the temporary file. `.env.rehearsal` is installed only when every check passes; a failing run also
    removes a previous `.env.rehearsal`, so `40-up.sh` cannot start on it.
  - Limit: a credential stored under a name on `KEPT_PLAIN` in a shape none of the three patterns recognises would still
    be copied; `KEPT_PLAIN` is therefore kept short and reviewed whenever `backend.env` gains a name.
- **Env files:** `.env` holds only `API_IMAGE`/`WEB_IMAGE`/`INFRA_ONLY` (compose interpolation). The api reads
  `.env.api` = `.env.rehearsal` with the JWKS pins of the day (below), so secrets never sit in the compose
  interpolation file. `restart` does not re-read the file; use `docker compose up -d --force-recreate api`.
- **JWKS pins (`40-up.sh` step 1a):** computed **inside the new image** with `scripts/web3authJwksThumbprints.js`
  (`docker run --rm --pull never`, only the two public JWKS URLs passed, no env file, no secret) and written into
  `.env.api` as `WEB3AUTH_JWKS_PINNED_THUMBPRINTS`. `compose.yaml` and `.env.api` are installed only after this gate
  passed. `40-up.sh` **refuses to start the api** if the script fails, if no key is served, or if none of the pins
  configured in `.env.rehearsal` (copied from production) is served now. A served key that was never pinned is not
  trusted automatically: the operator checks it from a second network and re-runs with
  `JWKS_NEW_PINS_VERIFIED=<thumbprint,...>`. After start, the running api must carry exactly the written pins, and the
  money-path log line must contain, as exact fields, `nodeEnv=production`, `allowedVerifiers=5`,
  `issuer=https://tge-api.datadance.ai`, `consentOrigin=https://tge-app.datadance.ai`, `web3authVerify=enforce`,
  `legacyFallback=false`, `jwksPinMode=enforce`, `jwksPins=<served count>` and `sessionSecretSeparate=true`. The line is
  read from the api log since the container's last start. **Any missing or different field stops `40-up.sh`**
  (`common.sh money_path_fields_check`); only `publicClientRegistration=open` is a warning while that decision is open.
- **Mounts:** `keys_fixed` (mode 400 files) holds a copy of `wwdr.pem` (public), the throwaway pass signer and the
  throwaway APNs key: **no production private key**. Campaign covers and passes are **copies** under
  `/root/ddcnew/assets`. The old directories are only read. There are no source mounts.
- **nginx:** both tge vhosts are plain `sed` copies of the api and app vhosts with only `server_name` and the upstream
  port changed. The CORS lines are copied unchanged; `30-nginx.sh` refuses to render when the api vhost sets a literal
  `Access-Control-Allow-Origin` origin (the copy would then need the tge-app origin added by hand). `tge-app` keeps
  `/downloads/` and `/architecture/` (served by the host nginx from `/opt/ddc`) and the duplicated
  `map $connection_upgrade` block, which passes `nginx -t` on nginx 1.18 and stable.
- **Rehearsal TGE client:** `tge-rehearsal`. The secret is generated on the server and its plaintext is kept only in
  `/root/ddcnew/secrets/tge_rehearsal_client_secret`. `SSO_TGE_REDIRECT_URIS` defaults to
  `https://tge-rehearsal.invalid/oauth/callback`, a placeholder that passes the boot check and never resolves. Re-run
  `20-env.sh` with `REHEARSAL_REDIRECT_URIS=...` once the partner's test site is known.
- **Web3Auth verifier names:** Google is documented. The other three are the expected names and are confirmed from real
  tokens during the rehearsal; re-run with `W3A_EMAIL=... W3A_APPLE=... W3A_X=...`.

## 3. Disk

`p2-disk.sh preview` (read-only) measures the images, the database, the latest dump, `/app/public`, the reclaimable
build cache and the journal, and prints:
- `need_build_gb`: build both images + the empty stack + a P1 dump + a 3G margin;
- `need_gb`: the full rehearsal (three databases at 1.5x the old one, 11 dumps, two web images, public x2, a 5G margin)
  plus the build cache of building both images on the server;
- `window_need_gb`, and a `verdict=` line: whether `p2-disk.sh apply` (or `apply --all-cache`) is enough for
  `need_gb`, only for `need_build_gb`, or not even for that.

If the verdict asks for it, the online expansion of the system disk (80 GiB) must be approved and done **before any
production data is restored** (gate G1 in section 7). Procedure, in this order:

1. **Read-only check first:** `./remote.sh run p2-disk.sh expand-check` (no approval flag needed). It prints the root
   device, the disk and partition sizes from `/sys/class/block`, the ext4 size from `dumpe2fs -h`, `growpart_needed` /
   `resize2fs_needed`, whether `growpart` is installed, and the exact commands with the real device names. It stops on
   LVM, on a root partition that is not the last one, or on an unknown filesystem.
2. **Cloud console:** create a snapshot of the system disk first (P1 covers only the database), then resize it online.
   Wait until the console shows it done.
3. `./remote.sh run p2-disk.sh expand-check` again: the disk must show the new size and
   `growpart_needed=yes resize2fs_needed=yes`.
4. On the server (approved write step), with the device names that `expand-check` printed:
   ```bash
   command -v growpart || apt-get install -y cloud-guest-utils
   growpart /dev/<disk> <partition-number>
   resize2fs /dev/<disk><partition-number>        # online, ext4 mounted at /
   ```
5. `df -h /` shows the new size, `expand-check` shows `growpart_needed=no resize2fs_needed=no`, and
   `p2-disk.sh preview` shows avail >= `need_gb`.

Not reversible (billing). Without a dump, `p2-disk.sh preview` estimates the dump at 35% of the database; after P1 it
uses the real size.

## 4. Execution order

Run from the Mac in `deploy/new-stack/`, with `local.env` filled in. Every write call needs `DDC_APPROVED=yes`, and each
call is logged to `logs/` on the Mac **and**, for every write run, to `/root/ddcnew/logs/<ts>-<script>-<pid>.log` (600)
on the server. **Ctrl-C on the Mac does not stop a script on the server:** there is no tty, so Ctrl-C or a dropped
connection ends only the local ssh; the script runs to its end and keeps writing its server-side log. To stop it, log in
(approved) and `kill <pid>` with the pid on the log's **first line** or in `/root/ddcnew/.lock`, not the pid in the
log's file name (that one is the parent shell); for `10-build.sh` the TERM trap stops the docker build first. Only one
write script runs at a time (`flock` on `/root/ddcnew/.lock`); a second one stops at once and names the running one.
**Every write path fingerprints the old stack at start and end**: `p1-backup.sh` dump / verify / install-cron /
uninstall-cron, `p2-disk.sh apply`, `10-build.sh`, `20-env.sh`, `30-nginx.sh apply/undo`, `40-up.sh` and
`99-teardown.sh`. The fingerprint covers the old containers plus the sha256 of `backend.env`, every file in
`overlays/`, both compose files and every old vhost file except `tge-*`. The script FAILs loudly if anything changed and
tells the operator a teammate may have changed it (paths and 12-character hashes only). Read-only calls (`preflight`,
`p2-disk.sh preview/expand-check`, `p1-backup.sh status`, `30-nginx.sh status`) do not fingerprint.

| # | Command | Changes on the server | Pass criteria | Time | Undo |
|---|---|---|---|---|---|
| 0 | `./remote.sh preflight` | nothing | `PREFLIGHT PASS`; ports 10010/15433/9011 free; 6 old containers Up; disk layout and old-file fingerprints printed; `cgroup_driver=... cgroup_version=...` and `buildx_driver=docker` printed; `keys_fixed/apn_key.p8 identical to the git-tree copy:` printed with yes or no (reported, not judged here; the private runbook says what follows from it) | 2 min | - |
| 1 | `./remote.sh upload` | creates `/root/ddcnew/deploy` (700) with the scripts and `compose.yaml` | `files=10` (tar sent with `COPYFILE_DISABLE=1 --no-mac-metadata --no-xattrs`, extracted with `--no-same-owner`) | 1 min | `rm -rf /root/ddcnew/deploy` |
| 2 | `./remote.sh run p1-backup.sh dump pre-refresh` | `/root/backup/pg/ddc-pre-refresh-<ts>.dump` (+ .sha256), 600; read-only `pg_dump` of `ddc` | `PASS dump ... mode=600`; refuses unless free disk > db size + 2G; a failed dump removes its `.part` | 5-10 min | `rm` the dump |
| 3 | `./remote.sh run p1-backup.sh verify P1_USERS_MIN=<n>` (`<n>` from the private runbook) | throwaway `ddcnew-restore-test-20261004` (`--network none`, 1.5 GB), removed with its volume | refuses without a valid `P1_USERS_MIN` and below 6G free disk; sha256 match; `pg_restore --list` exit 0 with toc > 0; `pg_restore exit=0`; restored users >= `P1_USERS_MIN`; container removed. **Stops** on a failing or empty `pg_restore --list` and on a restored user count that is not a number or below `P1_USERS_MIN`; only a count above the live one is a warning (users deleted since the dump) | 15-25 min | none left behind |
| 4 | `./remote.sh run p1-backup.sh install-cron` | `/root/backup/ddc-pgdump.sh`, `/etc/cron.d/ddc-pgdump` (03:15 CST, keeps 7 days of `ddc-daily-*`) | syntax ok (`bash -n` runs **before** the cron entry is written; a failure removes the script and writes no entry); installed; next day `p1-backup.sh status` shows an `ok` line | 1 min | `p1-backup.sh uninstall-cron` |
| 5 | `./remote.sh run p2-disk.sh preview`, `run p2-disk.sh expand-check`, then `run p2-disk.sh apply` | prunes **build cache only**, vacuums the journal to 200M; writes `/root/backup/disk-need.txt` | avail >= `need_build_gb`; images still present; old stack unchanged | 5 min | not needed |
| 6 | Overlay reconcile (D), merges (E) -> `BE_SHA`, `FE_SHA` (full 40-hex) | - | audit signed off (or proceed with `--infra-only` for the empty stack) | separate | - |
| 7 | `./remote.sh pack-web $FE_SHA`, then `upload-web $FE_SHA` | `/root/ddcnew/src/ddc-frontend-<sha>.tar.gz` (+ .sha256) | `sha256sum -c: OK` | 3 min | `rm` the tarball |
| 8 | `./remote.sh run 10-build.sh $BE_SHA $FE_SHA --overlays-reconciled` (or `--infra-only`) | clean clone; images `ddcnew/backend:<sha12>[-infra]`, `ddcnew/web:tge-<sha12>`; `wwdr.pem` copy, throwaway pass signer and throwaway `apn_key.p8` (400); `assets/campaigns`, `assets/passes`; `/root/ddcnew/.env` | >= 12G free before the backend build, >= 7G before the web build, MemAvailable >= 3000 MB before each; watchdog never fires; `BuildKit step processes given oom_score_adj=1000: <n >= 1>` for each build and no `WARN watchdog: no BuildKit step process was marked` (unless every step came from the cache); 0 `.env*` in the image; PR #25/#27 present; build marker `mode=tge ... w3aClientId=BBpkxUTUr... chainId=44508`; no devnet client id in `/var/www`; `signerKey.pem and signerCert.pem are a throwaway pair`; `apn_key.p8 is a throwaway key`; old stack unchanged | 30-45 min | `99-teardown.sh --remove-images` |
| 9 | `./remote.sh run 20-env.sh` | `/root/ddcnew/secrets/*` (generated once), `.env.rehearsal`, `.env.db` (600) | `db_target=db:5432/ddc_rehearsal schema=public`; JWT differs from old; SSO secret differs from JWT; TGE hash = sha256(secret file); client id = the frontend's `.env.tge` (BBpkxUTUr...); `DISBURSEMENT_PAUSED` 1, `BSC_PAYOUT_PRIVATE_KEY` 0; **no private-key / mnemonic name left**; `BACKEND_WALLET_PRIVATE_KEY` and `CHAIN_SIGNER_PRIVATE_KEY` absent; blanked list printed; `every name with a value is classified`; `no copied value carries a URL credential, a PEM key block or a 32-byte hex key`; kept values byte-identical; `.env.rehearsal installed ... after every check passed`; old stack unchanged | 1 min | `rm` the env files (secrets only before pgdata exists) |
| 10 | `./remote.sh run 30-nginx.sh apply` | two vhost files + links `tge-*.datadance.ai`; `nginx -t`; reload | diff shows only `server_name` and port lines; `nginx -t ok`; old vhost codes unchanged (if not, the script prints the integrity check and **stops**: `run ./30-nginx.sh undo now`); old stack unchanged; tge codes 502 | 2 min | `30-nginx.sh undo` |
| 11 | `./remote.sh run 40-up.sh` (add `JWKS_NEW_PINS_VERIFIED=...` only if it asks) | `compose.yaml`, `.env.api` (with today's pins), `pgdata/`, empty `ddc_rehearsal` + migrated schema, containers `ddcnew-{db,api,web}-1` | INFRA banner if `-infra`; `apn_key.p8`, `signerKey.pem`, `signerCert.pem` differ from production; pins: `configured_and_served >= 1`, `.env.api = .env.rehearsal except the pins`; db healthy; `db_target` exact; `migrate status: Database schema is up to date`; log line `Partner SSO money-path assertions OK` with all 9 exact fields (any miss stops the script) and `publicClientRegistration=closed`; running api carries exactly the written pins, the throwaway `apn_key.p8` and the throwaway `signerKey.pem`; `/partner/tge/me` -> 401 JSON; `/ddc-build.json` -> tge/mainnet; old vhost codes unchanged (else it **stops**); old stack unchanged; `REHEARSAL_DB` only `ddc_rehearsal` or `ddc_rehearsal2` | 5-10 min | `99-teardown.sh` |
| 12 | External: from a team address open `https://tge-api.datadance.ai/partner/tge/me` (401) and `https://tge-app.datadance.ai/ddc-build.json`; from any other address expect the WAF block | - | runbook pass criteria | 5 min | - |

Total wall clock is about 2-2.5 h of execution plus the external waits (D-H).

**Undo for the whole stack:** `./remote.sh run 99-teardown.sh` runs compose down and removes the vhosts. If compose
cannot run (e.g. `/root/ddcnew/.env` missing), it removes the project by its compose label instead: containers labelled
`com.docker.compose.project=ddcnew` (all must be named `ddcnew-*`), then the networks with that label (`ddcnew_*`). The
base images the builds pulled, `postgres:17` and the build cache stay behind (`docker builder prune -f` or
`p2-disk.sh apply` frees the cache). Add `--remove-images` to remove the `ddcnew/*` images (including `-infra`), and
`--delete-dir` to remove `/root/ddcnew`. Teardown never touches the P1 dumps or the cron entry.

### 4.1 Accepted runbook deviation (40-up on an empty database)

The runbook creates `ddc_rehearsal` and leaves the api stopped until the rehearsal restores data. **This package
deliberately deviates:** `40-up.sh` migrates the EMPTY `ddc_rehearsal` and starts the api, to prove that the new image
boots with the rehearsal env, passes the money-path assertions and answers through nginx before any data is involved.
Consequences the data step (separate approval) must honour:

1. `refuse_if_infra_only` first (the image must be an `--overlays-reconciled` build).
2. Stop the api, then **`dropdb` / `createdb ddc_rehearsal`** before `pg_restore` (the database now holds the empty
   migrated schema), then the `db_target` check, then `migrate deploy`.
3. Add the **`./public:/app/public` mount** to `compose.yaml`, and seed it: the new image's `/app/public` first, then the
   old container's `/app/public` with `rsync --ignore-existing`, which includes the runtime uploads that exist only in
   the old container's layer (`00-preflight.sh` counts them).
4. Then `up -d --force-recreate api`.

## 5. Safety rules built into every script

- **Allowed writes:** only `/root/ddcnew`, `/root/backup`, `/root/mainnet-switch`, the two `tge-*` vhost files and
  links, and `/etc/cron.d/ddc-pgdump`. `/root/ddc`, `/root/ddc-backend`, `/root/deploy-src` and `/opt/ddc` are refused,
  except for reading `backend.env` and the key files (to prove the rehearsal ones differ) and copying `wwdr.pem`,
  campaign covers and passes from them. `guard_write_path` resolves every target with GNU `realpath -m` (symlinks
  followed, `..` applied after them).
- **Old-stack integrity (containers and files):** every write path records each `ddc-*` container (id, state, start
  time, restart count, policy) and the sha256 of `/root/ddc-backend/backend.env`, every file in
  `/root/ddc-backend/overlays/`, `/root/ddc-backend/docker-compose.yaml`, `/root/ddc/docker-compose.yml` and every
  `/etc/nginx/sites-available/*` except `tge-api.*` / `tge-app.*`, and fails loudly if anything changed. A restart or
  edit by a teammate (e.g. during the TGE data refresh) also trips it; the message says so. Output is paths and
  12-character hashes only.
- **Shared host memory:** builds start only with MemAvailable >= 3000 MB and are stopped by the watchdog below 1000 MB
  (or below 3 GB free disk); their RUN steps get `oom_score_adj=1000` (section 2). The new stack's containers run with
  `oom_score_adj: 500` and `mem_limit` api 1g, db 1g, web 128m (2.1 GB in all; reasoning in `compose.yaml`), so the
  kernel kills a new-stack process before the old Postgres or API.
- **One write run at a time, logged on the server:** every write script takes `flock` on `/root/ddcnew/.lock` (a child
  write script, such as `30-nginx.sh undo` started by `99-teardown.sh`, inherits it) and copies its output to
  `/root/ddcnew/logs/<ts>-<script>-<pid>.log` (600; names, counts and hashes only, like the screen output). Read-only
  modes write nothing. Every script that sources `common.sh` runs with `LC_ALL=C`.
- **Shared root disk:** the dump, restore test, nightly cron and both builds each check free space first, so none of
  them can fill the disk under the live Postgres.
- **Dump locks:** `pg_dump` holds ACCESS SHARE locks on `ddc`; DDL, TRUNCATE or `prisma migrate` on the old database
  during a dump would queue and stall production. Agree a no-DDL window with Race for step 2 and keep 03:15 clear of
  old-stack migrations.
- **remote.sh overrides (allowlist):** `run` passes only `REHEARSAL_DB`, `REHEARSAL_REDIRECT_URIS`,
  `REHEARSAL_INITIATE_LOGIN_URI`, `OAUTH_PUBLIC_REGISTRATION`, `W3A_GOOGLE/EMAIL/APPLE/X`, `JWKS_NEW_PINS_VERIFIED`,
  `BUILD_MEM_FLOOR_MB` and `P1_USERS_MIN` to the server; every other `NAME=value` (`PATH`, `BASH_ENV`, `LD_PRELOAD`,
  `DDC_LOCAL_TEST`, `NEW_DIR`, `BACKUP_DIR`, ...) is refused before connecting. On the server, `common.sh
  require_server` refuses again the overrides of `NEW_DIR`, `OLD_ENV`, `OLD_BACKEND_DIR`, `OLD_APP_DIR`, `BACKUP_DIR`,
  `SWITCH_DIR`, `NGINX_AVAIL`, `NGINX_ENABLED`, `DDC_MEMINFO`, `DDC_PROC` and `BUILD_WATCH_INTERVAL`, and allows
  `BUILD_MEM_FLOOR_MB` (>= 1000) and `BUILD_DISK_FLOOR_MB` (>= 3072) only upwards; `DDC_LOCAL_TEST=1` is refused as root.
- **SSH logins (`sshpw.sh`, used by `remote.sh` and `survey/ro-ssh.sh`):** the login and the 1Password reference come
  from the untracked `local.env`; nothing connects, and 1Password is not asked, while it is missing, empty, still the
  placeholder, or of the wrong shape (the target must be `user@host`, so it can never be read as an ssh option; the
  reference must be a 1Password secret reference, so a pasted password is refused and never printed). Then `op read`
  runs with all output discarded, and nothing connects if 1Password does not answer. Nothing connects either when the
  askpass file cannot be created completely (`mktemp` or write failure, disk full). If `op` fails later inside the
  askpass, the askpass kills its parent, only after checking that the parent is ssh, before ssh can send a password.
  Password method only, `NumberOfPasswordPrompts=1`. When the login method changes (gate G4), `sshpw.sh`, `remote.sh`
  and `survey/ro-ssh.sh` change with it.
- **Ports and database names:** ports are loopback-only and disjoint from 10000, 9000-9003 and 15432. The database
  names `ddc`, `postgres` and the templates are refused.
- **Never used:** no `docker system/image -a/volume prune`, no image deletion other than `ddcnew/*` in teardown, and no
  restart of an old container.
- **Output:** scripts print names, counts, sizes, hashes and pass/fail only.

## 6. Local tests

`bash test/run-local-tests.sh <new-scratch-dir>` runs on the Mac and touches no server (Docker Desktop, shellcheck 0.11
and GNU coreutils needed; throwaway containers and images are named `*-20261004` and removed at the end, and no existing
container is touched). It must end with `summary: fails=0`. It covers:
- `bash -n` and `shellcheck -x -S warning` on every script; `docker compose config` (ports loopback-only, memory limits).
- `20-env.sh` twice on a synthetic old env (multi-line quoted values, comments, `export`, duplicates, inline comments,
  signing keys and a mnemonic): idempotent, no secret in the output or the server-side log, compose's own parser
  agrees, the credential policy (removed, blanked, fail-closed on unclassified names and on credential-shaped values),
  and identical output on ubuntu:jammy (mawk, GNU tools).
- `30-nginx.sh` render on synthetic vhost fixtures and `nginx -t` on nginx 1.18 and stable; apply and undo stop when an
  old vhost's status code changes.
- Old-stack fingerprint on a fake tree; the memory and disk watchdog on Docker Desktop, after the SSH session ends
  (bash 3.2 and 5.1), on fake `/proc` trees for both cgroup drivers, and on a real dockerd 29.1.3 with the systemd
  cgroup driver in a privileged throwaway container.
- JWKS pin decisions, the `10-build.sh` flag gate, `refuse_if_infra_only`, the disk verdict and `expand_check` on a real
  ext4 partition; the throwaway pass signer; the money-path fields.
- The SSH login guard against a throwaway loopback sshd, using scratch copies with a test `local.env`; `local.env`
  refusals (missing, placeholders, empty, wrong shape) with stub `op` and `ssh` that record every call; the preflight's
  git-tree hash; `00-preflight.sh` as root in a throwaway container.
- Root mode in ubuntu:22.04: the write guard, `require_server`, the run lock and the server-side log.
- `p1-backup.sh verify` stop cases (synthetic counts) and the `99-teardown.sh` label fallback.
- Section 13: `test/helpers/public-repo-scan.sh` on every committable file of the package, with a negative control.

## 7. Gate: prerequisites before ANY production data lands on the new stack

Financial-grade rule (Sloan). All of these are separate approvals; none is in the scripts above. Tick each with its
evidence before the data step is approved. The commands and pass criteria of G3 to G6 are in the private runbook.

| # | Prerequisite | Pass condition |
|---|---|---|
| G1 | Disk expanded (section 3) | `expand-check`: `growpart_needed=no resize2fs_needed=no`; `p2-disk.sh preview` avail >= `need_gb` |
| G2 | Image built with `--overlays-reconciled` (section 2, item D) | `/root/ddcnew/.env` has `INFRA_ONLY=0`; `refuse_if_infra_only` passes |
| G3 | Origin TLS and firewall rules per the private runbook (P3) | the runbook's P3 pass criteria |
| G4 | SSH login hardening per the private runbook (P4); `sshpw.sh`, `remote.sh` and `survey/ro-ssh.sh` move to the new login method in the same change | the runbook's P4 pass criteria, and every listed person can still log in |
| G5 | The remaining host hardening items of the private runbook | each item's pass criteria in the runbook; the old api still up |
| G6 | Encrypted off-site backups running (design in the private runbook) | one encrypted daily dump off the host and a restore drill from it passed |
| G7 | The data-step script follows section 4.1 | dropdb/createdb, `./public` mount and seeding, `refuse_if_infra_only` first |
| G8 | Decide how the rehearsal treats sensitive columns in the restored data (private runbook) | an audit note on the reconciled commit |
