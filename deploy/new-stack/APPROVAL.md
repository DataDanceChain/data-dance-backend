# New production stack (`ddcnew`): approval package

What each script changes on the server, its pass criteria, its undo, and the safety rules built into all of them.
Nothing here runs on the server without Sloan's approval for that step (`DDC_APPROVED=yes`). The server's address,
the current findings about it, its measurements and the commands of the hardening steps are in the **private Drive
runbook**; this file describes the scripts only.

**In scope:** P1 backup, P2 disk cleanup, and a new stack `ddcnew` running on an **empty** rehearsal database behind
the rehearsal hosts `API_HOST` and `APP_HOST`, with the password-protected partner info page for the TGE partner
(section 8). The hosts and the three host ports are **settings** (`common.sh`): by default `api-rehearsal.datadance.ai`
and `app-rehearsal.datadance.ai`, the names Race gave the rehearsal on 10-05, and ports 10020, 9021 and 15434. Race runs
his own rehearsal stack under those names today; which stack serves them is being decided (section 9).
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
| F | DNS: proxied records for `API_HOST` and `APP_HOST` that point at the production host (address in the private runbook), and a WAF custom rule (Block): `(http.host in {"<API_HOST>" "<APP_HOST>"} and not ip.src in {<team addresses>})`. The default names' records exist since 10-05. | whoever holds the `datadance.ai` zone | external check |
| G | The team's address list for that WAF rule. | Sloan | F |
| H | Web3Auth **mainnet** project allow-list: add `https://<APP_HOST>`. | Sloan | logins in rehearsal |
| I | `local.env` on the operator's Mac (values from the private runbook) and 1Password CLI approval at each login. | Sloan | remote runs |
| J | The rehearsal keeps `OPS_ADMIN_USERNAME` / `OPS_ADMIN_PASSWORD` from production (own-stack ops console, not a third party; blank answers 503 "not configured"). Keep, or blank them for the rehearsal? Default: kept. | Sloan | data step |
| K | The gate in section 7, each item with its own approval, **before any production data is restored**. | Sloan | data step |
| L | Apple Wallet pass signing in the rehearsal. **Default: no production key.** The rehearsal gets a throwaway RSA key and a self-signed `signerCert.pem` (`10-build.sh`), so pass creation fails or yields a pass Wallet rejects; boot is unaffected. Real pass signing in the rehearsal needs an approval and a script change (`40-up.sh` refuses the production files). The cutover copies the production `signerKey.pem`, `signerCert.pem` and `apn_key.p8` under its own approval. | Sloan | nothing (default holds) |
| M | `P1_USERS_MIN` for `p1-backup.sh verify`: the minimum number of users in a complete dump. It is a production figure, so it is in the private runbook, not here. | Sloan | P1 verify |
| N | Partner info page (section 8): the page password, created once in 1Password; the partner server's address (`PARTNER_ALLOWED_IP`, also in the WAF rule of item F); the partner's callback and start-login addresses in `20-env.sh`. Sloan shares the page password with the partner. | Sloan | `50-partner-page.sh` |
| O | Which stack serves the rehearsal hosts (section 9): **A**, this stack takes over Race's names (`TAKE_OVER_VHOSTS=yes`, his vhost entries backed up first), or **B**, both stacks run side by side, this one under other names (their DNS, WAF rule, Web3Auth allow-list entry and a frontend commit built for them). | Sloan + Race | `30-nginx.sh apply` (A), or everything from `10-build.sh` on (B) |
| P | `REHEARSAL_CLIENT_ID`: the partner's client id for the rehearsal (`SSO_TGE_CLIENT_ID`). **Required, no default:** since backend fd2d4e9 the api refuses to boot with `tge` or `tge-rehearsal`, and any id that is not `[A-Za-z0-9._-]{1,64}`. Given on the first `20-env.sh` run, recorded, reused afterwards. | Sloan (with the partner) | `20-env.sh` |

## 2. Decisions taken in this package

- **Images are built on the server, without a registry.**
  - **Backend:** clean `git fetch --depth 1` of this public repository at the pinned SHA. The script checks that HEAD
    equals the SHA, the tree is clean, `.dockerignore` (PR #25) and `scripts/mainnetSwitch.js` (PR #27) are present,
    and the image has 0 `.env*` files.
  - **Frontend (private repository):** `remote.sh pack-web` makes a `git archive` tarball of the pinned commit into
    `out/` (gitignored). `upload-web` copies it to the server, and `10-build.sh` checks its sha256 and its embedded
    commit id (`git get-tar-commit-id`), then builds with `VITE_MODE=tge VITE_API_ENV=tge`. The frontend compiles its
    tge API in (`src/config/environment.ts` `API_BASE_URLS.tge`; `https://api-rehearsal.datadance.ai/api` since frontend
    a3ee809, 10-05): before any build `10-build.sh` reads that entry from the tarball and stops unless it is
    `https://<API_HOST>/api`, and after the web build `ddc-build.json` must say the same.
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
  interpolation file. `restart` does not re-read the file; re-run `40-up.sh`, or by hand
  `(set -a; . ./settings.env; docker compose -p ddcnew up -d --force-recreate api)` in `/root/ddcnew`.
- **Hosts and ports are settings (`common.sh`):** `API_HOST`, `APP_HOST`, `API_PORT`, `WEB_PORT`, `DB_PORT`, defaults
  `api-rehearsal.datadance.ai`, `app-rehearsal.datadance.ai`, 10020, 9021, 15434, overridable per call through
  `remote.sh` (`... run <script> API_HOST=<host> ...`). A host must be one label under `datadance.ai` and never a
  production host; a port must be 1024-65535, not an old-stack port, and the three must differ. The first write script
  records them in `/root/ddcnew/settings.env`; every later script uses the recorded values and stops on an override
  that differs (so the steps, and `99-teardown.sh`, always agree), and `99-teardown.sh` removes the record at its end.
  The record is written whole and renamed, so it always holds each of the five exactly once (and `REHEARSAL_CLIENT_ID`
  at most once, below): an empty or partial record, a repeated or unknown name, or an empty value stops every script.
  `compose.yaml` has no port of its own: `common.sh dc()` passes the three, and compose refuses to run without them.
- **JWKS pins (`40-up.sh` step 1a):** computed **inside the new image** with `scripts/web3authJwksThumbprints.js`
  (`docker run --rm --pull never`, only the two public JWKS URLs passed, no env file, no secret) and written into
  `.env.api` as `WEB3AUTH_JWKS_PINNED_THUMBPRINTS`. `compose.yaml` and `.env.api` are installed only after this gate
  passed. `40-up.sh` **refuses to start the api** if the script fails, if no key is served, or if none of the pins
  configured in `.env.rehearsal` (copied from production) is served now. A served key that was never pinned is not
  trusted automatically: the operator checks it from a second network and re-runs with
  `JWKS_NEW_PINS_VERIFIED=<thumbprint,...>`. After start, the running api must carry exactly the written pins, and the
  money-path log line must contain, as exact fields, `nodeEnv=production`, `allowedVerifiers=5`,
  `issuer=https://<API_HOST>`, `consentOrigin=https://<APP_HOST>`, `web3authVerify=enforce`,
  `legacyFallback=false`, `jwksPinMode=enforce`, `jwksPins=<served count>` and `sessionSecretSeparate=true`. The line is
  read from the api log since the container's last start. **Any missing or different field stops `40-up.sh`**
  (`common.sh money_path_fields_check`); only `publicClientRegistration=open` is a warning while that decision is open.
- **Mounts:** `keys_fixed` (mode 400 files) holds a copy of `wwdr.pem` (public), the throwaway pass signer and the
  throwaway APNs key: **no production private key**. Campaign covers and passes are **copies** under
  `/root/ddcnew/assets`. The old directories are only read. There are no source mounts.
- **nginx:** the two vhosts (`sites-available/<API_HOST>` and `<APP_HOST>`, linked from `sites-enabled`) are plain
  `sed` copies of the api and app vhosts with only `server_name` and the upstream port (`API_PORT`, `WEB_PORT`) changed,
  under a first line that marks them as this package's (`# ddcnew-vhost: ...`, common.sh `VHOST_MARKER`). The app copy
  alone also gets the `location ^~ /partner-info/` block of the partner info page (section 8), right after its
  `server_name` line. The CORS lines are copied unchanged; `30-nginx.sh` refuses to render when the api vhost sets a
  literal `Access-Control-Allow-Origin` origin (the copy would then need the app origin added by hand). The app copy
  keeps `/downloads/` and `/architecture/` (served by the host nginx from `/opt/ddc`) and the duplicated
  `map $connection_upgrade` block, which passes `nginx -t` on nginx 1.18 and stable. Both copies also get
  `location = /.well-known/ddcnew-vhost-token`, right after their `server_name` line: a random token (written once to
  `/root/ddcnew/vhost-token`, 600) answered to 127.0.0.1 only (403 to anyone else). The Host-header checks read it
  through the host nginx first: another stack behind the same names answers the same 401 and build marker, but not this
  token, so it proves that nginx really serves this package's vhosts.
  - **Only its own files.** `30-nginx.sh apply` refuses to create or overwrite anything at those names (the file, its
    `.new` temporary, the link) that does not carry the marker line, or a link that is not its own: on 10-05 Race's
    vhosts sit at the default names, so with the defaults apply stops and lists them. `TAKE_OVER_VHOSTS=yes` (only once
    Sloan and Race agree, section 9) first requires this stack to answer on its own ports (the api 401 on
    `127.0.0.1:API_PORT/partner/tge/me`, the web's build marker on `127.0.0.1:WEB_PORT`; so `40-up.sh` runs before it),
    then backs the entries up to `/root/ddcnew/vhost-takeover/<ts>-<pid>/` (copies with their mode, link targets, a
    `MANIFEST` with each sha256, written as `MANIFEST.part` and renamed only when complete), then replaces them.
  - **What can be taken over:** only the other party's rehearsal vhost of exactly that host: every `server_name` it
    declares is the host (a wildcard, a regex, `_` or `""` counts as another name), no `listen` of it is a default
    server, it includes nothing but certbot's `/etc/letsencrypt/options-ssl-nginx.conf` and `proxy_params`, it has a
    `proxy_pass` and no other `*_pass`, and every `proxy_pass` (comments removed, a statement may span lines) goes to
    `localhost` or `127.0.0.1` on a host port that a `ddc-mainnet-*` container binds (running or stopped; the preflight
    prints them). A static site (`docs.datadance.ai`, say), another stack's vhost, a remote upstream or a file that also
    serves another name stays refused, flag or not, so no name the other party serves can leave the before/after
    check. A take-over is also refused while this package has entries of its own at those names next to his (undo them
    first), so its rollback only ever removes what that run wrote.
  - **A take-over that does not complete is rolled back:** from the removal of the first entry until every check has
    passed, any failure (a command, a stop such as another host answering differently after the reload, nginx -t,
    failing Host-header checks, apply's final old-stack check, a signal to the script or to its whole process group
    such as Ctrl-C or a hangup in an interactive session) puts the backed-up entries back at once (the backup marked
    `RESTORED`), reloads nginx if apply had tried to (even when that reload reported a failure), and compares the other
    hosts again. Nothing stops the rollback once it runs (it ignores further signals and a closed log pipe; the log's
    `tee` ignores the signals too, so its lines reach the server-side log); it says so when its own reload fails. If it
    cannot finish, the script says to run `30-nginx.sh restore <backup>`.
  - `30-nginx.sh restore` sets this package's entries aside, puts the latest complete backup back (after checking it
    against the `MANIFEST`), then `nginx -t` and reload; if `nginx -t` fails with the restored entries they go again
    and this package's come back, so the names never end up with neither. An entry that is already back exactly as its
    `MANIFEST` line says (a rollback that stopped half way) is kept; anything else at those names stops it. It marks the
    backup `RESTORED`. An interrupted backup (no `MANIFEST`) never blocks `restore`, `undo` or `99-teardown.sh`.
  - **Recovery order after a take-over: `restore` first, then `99-teardown.sh`.** `undo` and `99-teardown.sh` (every
    mode) refuse while a take-over backup was never restored: `undo` first would leave his names with no vhost at all
    (nginx would answer them from its default server) until someone restored them, while `restore` swaps the entries in
    one reload. After the restore, teardown finds nothing of this package's at those names. `undo` removes this
    package's entries only.
  - apply also stops when **another** file that nginx loads (`sites-enabled/*`, `conf.d/*.conf`) declares one of the two
    hosts as a `server_name` (nginx would answer from only one of them; no flag overrides this), and when `API_PORT` or
    `WEB_PORT` is held by anything other than this stack's own container (Race's containers hold 10010 and 9011).
  - Around every reload, **every other host nginx serves** (the production api/app/business/admin hosts and each exact
    `server_name` of the other loaded vhosts, Race's included) must answer with the same status code as before: over
    http, and over https with SNI on 443 whenever something listens there.
    When something listens on 443 but https on 127.0.0.1 answers `000` for every host before and after, a WARN says
    that the comparison covered http only (nginx may listen on 443 on another address).
  - After the reload apply runs the Host-header checks through the new vhosts (this package's vhost token for both
    hosts first, then `<API_HOST>/partner/tge/me` 401 JSON and `<APP_HOST>/ddc-build.json` the build for
    `https://<API_HOST>/api`): always after a take-over (a stack that stopped answering since the check before it fails
    them, and the take-over is rolled back), otherwise when this stack answers on its ports; else `40-up.sh` runs them
    when it starts the stack. `40-up.sh` runs them only while this package's vhosts serve both hosts, and says that
    they are deferred otherwise.
- **Rehearsal client id: `REHEARSAL_CLIENT_ID`, required, no default** (item P). `20-env.sh` writes it as
  `SSO_TGE_CLIENT_ID` and checks it with the api's own rule: `[A-Za-z0-9._-]{1,64}`, and not `tge` or `tge-rehearsal`
  (retired in backend fd2d4e9: the api refuses both at boot). A run that passes records it in `settings.env`; later
  runs reuse it, an override that differs stops, and `99-teardown.sh` removes it with the record. The local test boots
  this checkout's own `src/server.js` on the env `20-env.sh` writes (`test/helpers/backend-boot.js`, nothing listens or
  connects) and checks that it refuses `tge-rehearsal`. The secret is generated on the server and its plaintext is kept
  only in `/root/ddcnew/secrets/tge_rehearsal_client_secret`. `SSO_TGE_REDIRECT_URIS` defaults to
  `https://tge-rehearsal.invalid/oauth/callback`, a placeholder that passes the boot check and never resolves. Re-run
  `20-env.sh` with `REHEARSAL_REDIRECT_URIS=...` once the partner's test site is known. The partner receives the secret
  through the partner info page (section 8), where it is only ciphertext.
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
uninstall-cron, `p2-disk.sh apply`, `10-build.sh`, `20-env.sh`, `30-nginx.sh apply/undo/restore`, `40-up.sh`,
`50-partner-page.sh apply/remove` and `99-teardown.sh`. The fingerprint covers every `ddc-*` container (Race's
`ddc-mainnet-*` included) plus the sha256 of `backend.env`, every file in `overlays/`, both compose files, every entry of
`sites-available` and `sites-enabled` that this package did not write (Race's at the rehearsal names included; a link
counts with its target), and every file under `/root/ddc-mainnet` except `.git/`, `node_modules/` and the directories a
container mounts read-write (data it writes itself). The script FAILs loudly if anything changed and tells the operator
a teammate may have changed it (paths and 12-character hashes only). Read-only calls (`preflight`,
`p2-disk.sh preview/expand-check`, `p1-backup.sh status`, `30-nginx.sh status`, `50-partner-page.sh status`) do not
fingerprint.

| # | Command | Changes on the server | Pass criteria | Time | Undo |
|---|---|---|---|---|---|
| 0 | `./remote.sh preflight` (add the overrides of section 9 if the hosts or ports differ from the defaults) | nothing | `PREFLIGHT PASS`; the settings printed; `API_PORT`/`DB_PORT`/`WEB_PORT` free (or held by this stack's own containers); 6 old containers Up and the `ddc-mainnet-*` containers listed apart; the entries at `API_HOST`/`APP_HOST` (`absent`, `written by this package`, or a WARN naming what sits there) and no FAIL for a `server_name` clash; disk layout and old-file fingerprints (`/root/ddc-mainnet` included) printed; `cgroup_driver=... cgroup_version=...` and `buildx_driver=docker` printed; `keys_fixed/apn_key.p8 identical to the git-tree copy:` printed with yes or no (reported, not judged here; the private runbook says what follows from it) | 2 min | - |
| 1 | `./remote.sh upload` | creates `/root/ddcnew/deploy` (700) with the scripts, `compose.yaml` and `partner-info/index.html` | `files=12` (tar sent with `COPYFILE_DISABLE=1 --no-mac-metadata --no-xattrs`, extracted with `--no-same-owner`) | 1 min | `rm -rf /root/ddcnew/deploy` |
| 2 | `./remote.sh run p1-backup.sh dump pre-refresh` | `/root/backup/pg/ddc-pre-refresh-<ts>.dump` (+ .sha256), 600; read-only `pg_dump` of `ddc` | `PASS dump ... mode=600`; refuses unless free disk > db size + 2G; a failed dump removes its `.part` | 5-10 min | `rm` the dump |
| 3 | `./remote.sh run p1-backup.sh verify P1_USERS_MIN=<n>` (`<n>` from the private runbook) | throwaway `ddcnew-restore-test-20261004` (`--network none`, 1.5 GB), removed with its volume | refuses without a valid `P1_USERS_MIN` and below 6G free disk; sha256 match; `pg_restore --list` exit 0 with toc > 0; `pg_restore exit=0`; restored users >= `P1_USERS_MIN`; container removed. **Stops** on a failing or empty `pg_restore --list` and on a restored user count that is not a number or below `P1_USERS_MIN`; only a count above the live one is a warning (users deleted since the dump) | 15-25 min | none left behind |
| 4 | `./remote.sh run p1-backup.sh install-cron` | `/root/backup/ddc-pgdump.sh`, `/etc/cron.d/ddc-pgdump` (03:15 CST, keeps 7 days of `ddc-daily-*`) | syntax ok (`bash -n` runs **before** the cron entry is written; a failure removes the script and writes no entry); installed; next day `p1-backup.sh status` shows an `ok` line | 1 min | `p1-backup.sh uninstall-cron` |
| 5 | `./remote.sh run p2-disk.sh preview`, `run p2-disk.sh expand-check`, then `run p2-disk.sh apply` | prunes **build cache only**, vacuums the journal to 200M; writes `/root/backup/disk-need.txt` | avail >= `need_build_gb`; images still present; old stack unchanged | 5 min | not needed |
| 6 | Overlay reconcile (D), merges (E) -> `BE_SHA`, `FE_SHA` (full 40-hex) | - | audit signed off (or proceed with `--infra-only` for the empty stack) | separate | - |
| 7 | `./remote.sh pack-web $FE_SHA`, then `upload-web $FE_SHA` | `/root/ddcnew/src/ddc-frontend-<sha>.tar.gz` (+ .sha256) | `sha256sum -c: OK` | 3 min | `rm` the tarball |
| 8 | `./remote.sh run 10-build.sh $BE_SHA $FE_SHA --overlays-reconciled` (or `--infra-only`) | clean clone; images `ddcnew/backend:<sha12>[-infra]`, `ddcnew/web:tge-<sha12>`; `wwdr.pem` copy, throwaway pass signer and throwaway `apn_key.p8` (400); `assets/campaigns`, `assets/passes`; `/root/ddcnew/.env` | `PASS frontend source: API_BASE_URLS.tge = https://<API_HOST>/api` before any build (and before the settings are recorded); `backend PR #38's old-App line (42005bebf9d4): in this commit` or `not in this commit` (an ancestor check on the history since 2026-10-01, recorded as `OLD_APP_SWITCHES` in `/root/ddcnew/.env`); >= 12G free before the backend build, >= 7G before the web build, MemAvailable >= 3000 MB before each; watchdog never fires; `BuildKit step processes given oom_score_adj=1000: <n >= 1>` for each build and no `WARN watchdog: no BuildKit step process was marked` (unless every step came from the cache); 0 `.env*` in the image; PR #25/#27 present; build marker `mode=tge apiBaseUrl=https://<API_HOST>/api ... w3aClientId=BBpkxUTUr... chainId=44508`; no devnet client id in `/var/www`; `signerKey.pem and signerCert.pem are a throwaway pair`; `apn_key.p8 is a throwaway key`; old stack unchanged | 30-45 min | `99-teardown.sh --remove-images` |
| 9 | `./remote.sh run 20-env.sh REHEARSAL_CLIENT_ID=<the partner's client id>` (required on the first run, recorded, then reused; item P) | `/root/ddcnew/secrets/*` (generated once), `.env.rehearsal`, `.env.db` (600) | `db_target=db:5432/ddc_rehearsal schema=public`; JWT differs from old; SSO secret differs from JWT; TGE hash = sha256(secret file); client id = the frontend's `.env.tge` (BBpkxUTUr...); `rehearsal client id: <id> (override)` or `(recorded in ...)`; `PASS SSO_TGE_CLIENT_ID=<id>: matches [A-Za-z0-9._-]{1,64} and is neither tge nor tge-rehearsal`; refused before anything is written without it (no default) or with `tge`, `tge-rehearsal` or another shape; `PASS issuer PUBLIC_BASE_URL = API_BASE_URL = https://<API_HOST>; consent origin APP_PUBLIC_URL = FRONTEND_URL = https://<APP_HOST>`; `PASS WEB3AUTH_RETIRED_CLIENT_IDS = the old WEB3AUTH_CLIENT_ID (<8 characters>..., the devnet id being retired), not the mainnet id` (stops when the old id is empty, equals the mainnet id or is not 87 base64url characters starting with B; only its first 8 characters are printed) and `PASS LOGIN_MISSING_IDTOKEN_MEANS_OLD_APP=on; WEB3AUTH_RETIRED_CLIENT_IDS: 1 entry, equal to neither WEB3AUTH_CLIENT_ID nor a WEB3AUTH_EXTERNAL_AUDIENCE entry` (backend PR #38's boot checks, so a bad value stops here and not at the api's boot); `DISBURSEMENT_PAUSED` 1, `BSC_PAYOUT_PRIVATE_KEY` 0; **no private-key / mnemonic name left**; `BACKEND_WALLET_PRIVATE_KEY` and `CHAIN_SIGNER_PRIVATE_KEY` absent; blanked list printed; `every name with a value is classified`; `no copied value carries a URL credential, a PEM key block or a 32-byte hex key`; kept values byte-identical; `.env.rehearsal installed ... after every check passed`; old stack unchanged | 1 min | `rm` the env files (secrets only before pgdata exists) |
| 10 | `./remote.sh run 40-up.sh` (add `JWKS_NEW_PINS_VERIFIED=...` only if it asks) | `compose.yaml`, `.env.api` (with today's pins), `pgdata/`, empty `ddc_rehearsal` + migrated schema, containers `ddcnew-{db,api,web}-1` on 127.0.0.1:`API_PORT`/`DB_PORT`/`WEB_PORT` | INFRA banner if `-infra`; `apn_key.p8`, `signerKey.pem`, `signerCert.pem` differ from production; pins: `configured_and_served >= 1`, `.env.api = .env.rehearsal except the pins`; `published ports: ...` = the settings and `ports ... are free or published by this stack's own containers`; db healthy; `db_target` exact; `migrate status: Database schema is up to date`; log line `Partner SSO money-path assertions OK` with all 9 exact fields, `issuer=https://<API_HOST>` and `consentOrigin=https://<APP_HOST>` included (any miss stops the script), and `publicClientRegistration=closed`; when the image has backend PR #38, its line `Old App update answer (426 APP_UPDATE_REQUIRED): ... count=1 first8=<the old id's 8 characters> LOGIN_MISSING_IDTOKEN_MEANS_OLD_APP=on` (any difference stops; a missing line stops when `OLD_APP_SWITCHES=1`, and is said otherwise); running api carries exactly the written pins, the throwaway `apn_key.p8` and the throwaway `signerKey.pem`; step 7, the Host-header checks: `/partner/tge/me` through `<API_HOST>` -> 401 JSON and `/ddc-build.json` through `<APP_HOST>` -> tge/mainnet for `https://<API_HOST>/api` when this package's vhosts serve both hosts, else `DEFERRED` (step 11 runs them); every other host's code unchanged (else it **stops**); old stack unchanged; `REHEARSAL_DB` only `ddc_rehearsal` or `ddc_rehearsal2` | 5-10 min | `99-teardown.sh` |
| 11 | `./remote.sh run 30-nginx.sh apply` (outcome A: add `TAKE_OVER_VHOSTS=yes`, section 9) | two vhost files `<API_HOST>`, `<APP_HOST>` + their links; with `TAKE_OVER_VHOSTS=yes` first a backup of what sat there (refused until this stack answers on its ports: step 10 first); `nginx -t`; reload | `PASS nothing at these names that this package did not write` (or, with the flag, `take-over backup: ...` and `taken over: ...` per entry); `PASS no other loaded vhost declares ...`; `PASS API_PORT ... and WEB_PORT ... are free or held by this stack's own containers`; the diff shows only the marker lines, `server_name` and port lines, plus the `/partner-info/` location block in the app copy (section 8); `nginx -t ok`; `PASS every other host answers exactly as before` over http (and https with SNI when 443 is served; if not, the script prints the integrity check and **stops**: `run ./30-nginx.sh undo now`, or, after a take-over, it rolls the take-over back and names undo and restore); the Host-header checks pass through the new vhosts (`PASS <API_HOST> answers 401 JSON`, `PASS <APP_HOST> serves the tge mainnet build ...`); with the flag `PASS take-over complete`; old stack unchanged | 2 min | `30-nginx.sh undo`; after a take-over `30-nginx.sh restore` instead (undo refuses until then) |
| 12 | External: from a team address open `https://<API_HOST>/partner/tge/me` (401) and `https://<APP_HOST>/ddc-build.json`; from any other address expect the WAF block | - | runbook pass criteria | 5 min | - |
| 13 | Partner info page: the commands of section 8 (`op read ... \| DDC_APPROVED=yes ./remote.sh run 50-partner-page.sh apply PARTNER_ALLOWED_IP=<ip>`, then `verify` and `status`) | `/srv/ddcnew/partner-info/` (`index.html`, `secret.json`) | section 8 | 10 min | `50-partner-page.sh remove` |

Total wall clock is about 2-2.5 h of execution plus the external waits (D-H).

**Undo for the whole stack:** after a take-over (outcome A), first `./remote.sh run 30-nginx.sh restore` (the other
party's entries back, this package's removed, in one reload): `99-teardown.sh` refuses in every mode, before it changes
anything, while a take-over backup was never restored. Then `./remote.sh run 99-teardown.sh` runs compose down and
removes this package's vhosts (never anything else at those names), then the settings record. If compose cannot run
(e.g. `/root/ddcnew/.env` missing), it removes the project by its compose label instead: containers labelled
`com.docker.compose.project=ddcnew` (all must be named `ddcnew-*`), then the networks with that label (`ddcnew_*`). The
base images the builds pulled, `postgres:17` and the build cache stay behind (`docker builder prune -f` or
`p2-disk.sh apply` frees the cache). Add `--remove-images` to remove the `ddcnew/*` images (including `-infra`), and
`--delete-dir` to remove `/root/ddcnew`. Teardown never touches the P1 dumps, the cron entry or Race's rehearsal
(`ddc-mainnet-*`, `/root/ddc-mainnet`, his vhosts).

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

- **Allowed writes:** only `/root/ddcnew`, `/root/backup`, `/root/mainnet-switch`, `/srv/ddcnew` (the partner info
  page, which nginx must read: www-data cannot traverse `/root`), the vhost entries of the two hosts of the settings
  (file, `.new` temporary, link; and of those only what this package wrote, or what `TAKE_OVER_VHOSTS=yes` took over
  after a backup), and `/etc/cron.d/ddc-pgdump`. `/root/ddc`, `/root/ddc-backend`, `/root/deploy-src`, `/opt/ddc` and
  Race's `/root/ddc-mainnet` are refused, except for reading `backend.env` and the key files (to prove the rehearsal
  ones differ) and copying `wwdr.pem`, campaign covers and passes from them. `guard_write_path` resolves every target
  with GNU `realpath -m` (symlinks followed, `..` applied after them); a vhost link is replaced as an entry, never
  written through.
- **Old-stack integrity (containers and files):** every write path records each `ddc-*` container (id, state, start
  time, restart count, policy; Race's `ddc-mainnet-*` included) and the sha256 of `/root/ddc-backend/backend.env`,
  every file in `/root/ddc-backend/overlays/`, `/root/ddc-backend/docker-compose.yaml`, `/root/ddc/docker-compose.yml`,
  every entry of `/etc/nginx/sites-available` and `sites-enabled` that this package did not write (Race's at the
  rehearsal names included), and every file under `/root/ddc-mainnet` (read only; `.git/`, `node_modules/` and the
  directories a container mounts read-write are left out), and fails loudly if anything changed. A restart or edit by
  a teammate (e.g. during the TGE data refresh) also trips it; the message says so. Output is paths and 12-character
  hashes only. Only an approved take-over removes Race's entries at the rehearsal names from the fingerprint (each
  checked unchanged since the start); `restore` adds them back.
- **Shared host memory:** builds start only with MemAvailable >= 3000 MB and are stopped by the watchdog below 1000 MB
  (or below 3 GB free disk); their RUN steps get `oom_score_adj=1000` (section 2). The new stack's containers run with
  `oom_score_adj: 500` and `mem_limit` api 1g, db 1g, web 128m (2.1 GB in all; reasoning in `compose.yaml`), so the
  kernel kills a new-stack process before the old Postgres or API.
- **One write run at a time, logged on the server:** every write script takes `flock` on `/root/ddcnew/.lock` (a child
  write script, such as `30-nginx.sh undo` started by `99-teardown.sh`, inherits it) and copies its output to
  `/root/ddcnew/logs/<ts>-<script>-<pid>.log` (600; names, counts and hashes only, like the screen output). The log's
  `tee` ignores HUP, INT, TERM and QUIT, so a signal to the whole process group (Ctrl-C or a hangup when a script is
  run in an interactive session on the server) reaches the script, and what it does about it (a take-over's
  rollback) still reaches the log. Read-only modes write nothing. Every script that sources `common.sh` runs with
  `LC_ALL=C`.
- **Shared root disk:** the dump, restore test, nightly cron and both builds each check free space first, so none of
  them can fill the disk under the live Postgres.
- **Dump locks:** `pg_dump` holds ACCESS SHARE locks on `ddc`; DDL, TRUNCATE or `prisma migrate` on the old database
  during a dump would queue and stall production. Agree a no-DDL window with Race for step 2 and keep 03:15 clear of
  old-stack migrations.
- **remote.sh overrides (allowlist):** `run` passes only `REHEARSAL_DB`, `REHEARSAL_REDIRECT_URIS`,
  `REHEARSAL_INITIATE_LOGIN_URI`, `OAUTH_PUBLIC_REGISTRATION`, `W3A_GOOGLE/EMAIL/APPLE/X`, `JWKS_NEW_PINS_VERIFIED`,
  `BUILD_MEM_FLOOR_MB`, `P1_USERS_MIN`, `PARTNER_ALLOWED_IP`, the settings `API_HOST`, `APP_HOST`, `API_PORT`,
  `WEB_PORT`, `DB_PORT`, `REHEARSAL_CLIENT_ID` and `TAKE_OVER_VHOSTS` to the server; every other `NAME=value` (`PATH`,
  `BASH_ENV`, `LD_PRELOAD`, `DDC_LOCAL_TEST`, `NEW_DIR`, `SRV_DIR`, `BACKUP_DIR`, `MAINNET_DIR`, `NGINX_*`, ...) is
  refused before connecting. Every argument must consist of `[A-Za-z0-9._/=:,-]` only (no `;`, `$()`, backticks, blank,
  newline or carriage return can reach the server's root shell), and the settings, `REHEARSAL_CLIENT_ID` and
  `TAKE_OVER_VHOSTS` among the overrides are checked with the server's own rules (`common.sh
  remote_overrides_check`) before anything connects (a setting not given counts with its default there, as in
  `preflight`; the server checks again against its record). `preflight` takes the five settings only, and `run
  00-preflight.sh` is refused (the preflight needs the lines `preflight` prepends). `run` forwards its stdin to the
  remote script untouched (`op` never reads it) and refuses a terminal on stdin for `50-partner-page.sh apply` and
  `verify`. On the server, `common.sh require_server` refuses again the overrides of `NEW_DIR`, `SRV_DIR`, `OLD_ENV`,
  `OLD_BACKEND_DIR`, `OLD_APP_DIR`, `MAINNET_DIR`, `BACKUP_DIR`, `SWITCH_DIR`, `NGINX_AVAIL`, `NGINX_ENABLED`,
  `NGINX_CONFD`, `NGINX_LOCAL_URL`, `NGINX_LOCAL_TLS_PORT`, `DDC_MEMINFO`, `DDC_PROC` and `BUILD_WATCH_INTERVAL`,
  validates the settings (section 2) and `TAKE_OVER_VHOSTS` (`yes` or unset), and allows `BUILD_MEM_FLOOR_MB`
  (>= 1000) and `BUILD_DISK_FLOOR_MB` (>= 3072) only upwards; `DDC_LOCAL_TEST=1` is refused as root.
- **SSH logins (`sshpw.sh`, used by `remote.sh` and `survey/ro-ssh.sh`):** the login and the 1Password reference come
  from the untracked `local.env`; nothing connects, and 1Password is not asked, while it is missing, empty, still the
  placeholder, or of the wrong shape (the target must be `user@host`, so it can never be read as an ssh option; the
  reference must be a 1Password secret reference, so a pasted password is refused and never printed). Then `op read`
  runs with all output discarded, and nothing connects if 1Password does not answer. Nothing connects either when the
  askpass file cannot be created completely (`mktemp` or write failure, disk full). If `op` fails later inside the
  askpass, the askpass kills its parent, only after checking that the parent is ssh, before ssh can send a password.
  Password method only, `NumberOfPasswordPrompts=1`. When the login method changes (gate G4), `sshpw.sh`, `remote.sh`
  and `survey/ro-ssh.sh` change with it.
- **Ports and database names:** ports (`API_PORT`, `WEB_PORT`, `DB_PORT`) are loopback-only, disjoint from 10000,
  9000-9003 and 15432, and refused while anything but this stack's own container listens on them (`30-nginx.sh` checks
  the two it points the vhosts at, `40-up.sh` all three, `00-preflight.sh` reports them). The database names `ddc`,
  `postgres` and the templates are refused.
- **Never used:** no `docker system/image -a/volume prune`, no image deletion other than `ddcnew/*` in teardown, and no
  restart of an old container.
- **Output:** scripts print names, counts, sizes, hashes and pass/fail only.

## 6. Local tests

`bash test/run-local-tests.sh <new-scratch-dir>` runs on the Mac and touches no server (Docker Desktop, shellcheck 0.11,
GNU coreutils, and node with the backend's `node_modules` needed). Every container and image it creates carries the label `ddcnew-localtest=<run id>` (a new id
per run) and a name or tag with that id; its cleanup (an exit trap, so it also runs when a check fails or the run is
interrupted) and every count select by that label only, never by name, and an image is removed only when this run built
it, so other sessions' containers are never touched. A failing check prints a `FAIL` line naming it and the run goes
on; the watchdog checks look only at this run's own processes (markers unique to the run), so two suites can run side
by side. It must end with `summary: fails=0`. It covers:
- `bash -n` and `shellcheck -x -S warning` on every script; `docker compose config` (ports loopback-only, memory limits).
- `20-env.sh` twice on a synthetic old env (multi-line quoted values, comments, `export`, duplicates, inline comments,
  signing keys and a mnemonic): idempotent, no secret in the output or the server-side log, compose's own parser
  agrees, the credential policy (removed, blanked, fail-closed on unclassified names and on credential-shaped values),
  and identical output on ubuntu:jammy (mawk, GNU tools). `REHEARSAL_CLIENT_ID`: required on the first run (no
  default), refused when malformed (65 characters, a blank, a symbol), when `tge` or `tge-rehearsal`, or when it differs
  from the recorded one; a failing run does not record it; a re-run reuses the recorded value. The backend's own boot
  checks (`test/helpers/backend-boot.js` runs the checkout's real `src/server.js` with `src/app.js` stubbed, so nothing
  listens) accept the env file `20-env.sh` wrote and refuse the same file with `tge-rehearsal`.
- `30-nginx.sh` render on synthetic vhost fixtures (default and overridden hosts and ports) and `nginx -t` on nginx 1.18
  and stable; apply and undo stop when another host's status code changes (over https too when 443 is served); with
  Race-like entries at the default names: apply stops and changes nothing; `TAKE_OVER_VHOSTS=yes` is refused while
  this stack does not answer on its ports, and for an entry that does not proxy to a `ddc-mainnet-*` port (another
  upstream, a static root, no mainnet containers at all); otherwise it backs up and replaces and runs the Host-header
  checks after the reload; `restore` puts them back byte for byte (modes and link target included); a failing `nginx
  -t`, a failing copy, failing Host-header checks after the reload and a failure while putting them back each leave
  his entries in place or print the `restore` command; a backup interrupted by SIGKILL never counts as a backup and
  never blocks `restore`, `undo` or teardown; `restore` keeps this package's entries aside until `nginx -t` passes; a
  `server_name` clash and a port held by another container stop apply, and outcome B leaves them untouched (and stops
  if his hosts answer differently after the reload). Since the review of #42: both copies carry the vhost token (127.0.0.1
  only) and the checks after a reload start with it; after a take-over they always run, and a stack that stops
  answering after the check before it, a host nginx that still serves his stack (same 401 and marker, no token), a
  reload that reports a failure and apply's final old-stack check each roll the take-over back exactly; the rollback
  compares the other hosts again and reports its own failed reload; `undo` and `99-teardown.sh` (every mode, before
  any change) refuse until a take-over is restored, and `restore` right after the take-over swaps the entries in one
  reload; `restore` keeps what a half-finished rollback already put back, and arms its own rollback before it sets
  anything aside; a take-over next to an entry of this package's is refused; S4 also refuses wildcard, regex and `_`
  names, a default server, other includes, `fastcgi_pass`, a commented-out `proxy_pass`, a remote host on a
  `ddc-mainnet-*` port number and the old stack's ports (the stub docker lists old-stack containers too), and takes over
  a certbot-style vhost; an api answering 200 instead of 401 is refused; a listener on 443 that never answers ends each
  probe at its time limit, with a WARN; the https probe is checked with SNI only. Section 12c sends TERM to the script,
  and TERM, HUP and INT to its whole process group, right after the removal: under bash 3.2 (macOS) and bash 5.1
  (ubuntu:jammy) the entries come back exactly and the rollback reaches the server-side log.
- The settings: defaults, overrides reaching every host value and compose's ports, the record and a conflicting
  override, the refusals (production host, other domain, old-stack port, bad values), and a record that is empty,
  lacks a name or holds one twice (each stops). `10-build.sh` records the settings only after the frontend tarball's
  API check passed; the old-App startup line is required exactly when the built backend commit contains PR #38 (git
  ancestry, cases on both sides).
- Old-stack fingerprint on a fake tree (Race's vhost, link and `/root/ddc-mainnet` stand-in detected; this package's
  own files ignored; read-write mounted data left out; a restarted `ddc-mainnet-*` container detected); the memory and
  disk watchdog on Docker Desktop, after the SSH session ends
  (bash 3.2 and 5.1), on fake `/proc` trees for both cgroup drivers, and on a real dockerd 29.1.3 with the systemd
  cgroup driver in a privileged throwaway container.
- JWKS pin decisions, the `10-build.sh` flag gate, `refuse_if_infra_only`, the disk verdict and `expand_check` on a real
  ext4 partition; the throwaway pass signer; the money-path fields.
- The SSH login guard against a throwaway loopback sshd, using scratch copies with a test `local.env`; `local.env`
  refusals (missing, placeholders, empty, wrong shape) with stub `op` and `ssh` that record every call; `remote.sh`'s
  refusals before connecting (`;`, `$()`, backticks, a blank, a newline and a carriage return in each override, bad
  settings or client ids, `run 00-preflight.sh`); the preflight's git-tree hash and settings lines; `00-preflight.sh` as root in a throwaway container (Race's stand-ins listed and
  fingerprinted, a foreign entry at the default names a WARN, a `server_name` clash a FAIL).
- Root mode in ubuntu:22.04: the write guard (`/srv/ddcnew` and the settings' vhost names included, `/root/ddc-mainnet`
  refused), `require_server` (settings validated, the record honoured), the run lock and the server-side log, and
  `50-partner-page.sh`'s refusals as root (page directory under `/root` or a symlink, overrides).
- `p1-backup.sh verify` stop cases (synthetic counts) and the `99-teardown.sh` label fallback.
- Section 13: `test/helpers/public-repo-scan.sh` on every committable file of the package, with a negative control.
- Section 14, the partner info page: `50-partner-page.sh` on a `20-env.sh` output (its generated secret) with dummy
  32-character page passwords: `apply` writes the two files (modes, `secret.json` fields, a new salt and IV per run),
  `verify` gives `match=yes`, and `match=no` for a wrong password; the refusals (empty password, 31 or 33 characters, a
  symbol, a blank or a carriage return, a terminal on stdin, `bash -x`, a missing or malformed `PARTNER_ALLOWED_IP`,
  the `.invalid` placeholder, a secret that does not match `SSO_TGE_CLIENT_SECRET_SHA256`, a missing image) change
  nothing; neither value appears in the files, the output, the server-side logs or anything `ps` shows (arguments and
  environment, sampled during the runs, with the throwaway container's configuration, whose core ulimit is 0). The
  page has no `<form>`, a password field without a name, an unlock box hidden until the script shows it and
  `translate="no"` on the secret. Then nginx:stable serves the page with the rendered app vhost (headers checked:
  nosniff and the CSP with `form-action 'none'` and `base-uri 'none'`), `status` compares each served body with its
  file, and headless Chromium (playwright-core 1.60.0, `test/helpers/partner-browser.js`) checks the filled values, a
  wrong password (error), the right one (exactly the secret), copy, hide, an unreachable `secret.json`, phone width in
  dark mode, that the page requests nothing from another origin, and, with JavaScript disabled: no field is offered;
  forced into view, Enter and the button send nothing; a `<form>` injected around the field is blocked by the CSP;
  with the CSP stripped the native submit goes out without the password. In 10c-10e: the piped password reaches the
  remote script through the real ssh, `op` reads none of it, a terminal is refused, and `upload` ships the new files.

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

## 8. Partner info page (`50-partner-page.sh`)

One page that gives the TGE partner everything needed to integrate DDC login with the test environment:
`https://<APP_HOST>/partner-info/` (by default `https://app-rehearsal.datadance.ai/partner-info/`). Only the addresses
that the WAF rule of item F admits can open it (the team's and the partner server's).

**What it shows** (Chinese; light and dark; phone width): the values for the partner's config file (`issuer`,
`client_id`, `client_secret`, `redirect_uri`); the registered callback and start-login addresses; the allow-listed
address; the endpoints (discovery, `/oauth/authorize`, `/oauth/token`, `/oauth/revoke`,
`/.well-known/oauth-protected-resource/partner/tge`, `/partner/tge/me`, `/partner/tge/status`); the rules (PKCE S256;
`state` of 22 to 512 characters; `redirect_uri` byte for byte as registered, also at the token endpoint; scopes
`tge:identity tge:status`; `client_secret_basic` or `client_secret_post`; the code exchange on the partner's server; a
code is single-use and valid for 60 seconds, the whole login request for 10 minutes; a reused code also revokes the
token it gave); and production (issuer `https://api.datadance.ai`, separate credentials, a domain with a public
certificate, no IP address). The code lifetime is the backend's `PARTNER_CODE_TTL_MS` (60 s); 10 minutes is the consent
window, `PARTNER_REQUEST_TTL_MS`. The template `partner-info/index.html` holds no secret and no partner value: `apply`
fills in the values from `/root/ddcnew/.env.rehearsal`, `PARTNER_ALLOWED_IP` and the two hosts, HTML-escaped. The issuer
must be `https://<API_HOST>`.

**Encryption.** `client_secret` is on the page only as `secret.json` = `{"v":1,"kdf":"PBKDF2-SHA256","iter":600000,
"salt":..,"iv":..,"ct":..}` (base64). Key: PBKDF2-SHA256 of the page password with a random 16-byte salt, 600,000
iterations, 256 bits. Cipher: AES-256-GCM with a random 12-byte IV; `ct` ends with the 16-byte tag. Every `apply` draws a
new salt and IV. The page fetches `./secret.json` (`cache: 'no-store'`) and decrypts it with WebCrypto in the reader's
browser; nothing is sent back. A wrong password shows 密码不正确，请检查后重试。 and nothing else. The decrypted secret's
element carries `translate="no"`, so a browser's page translation never sends it out. On the server the encryption runs
in a throwaway container of the ddcnew backend image (`docker run --rm -i --network none --pull never`, read-only, no
capabilities, user nobody, no log driver, `--ulimit core=0` so no core file can hold either value): the password and
the secret reach node on stdin only, never as an argument or an environment variable, and node decrypts its result once
more before anything is installed. The secret
must hash to `SSO_TGE_CLIENT_SECRET_SHA256`, so the page never shows a secret the api refuses. Git and the server never
hold the page password; the server holds the secret only where `20-env.sh` generated it.

**The password never leaves by a form.** The password field has no `name` and sits in no `<form>` (so there is no
method or action to fall back on), the button is `type="button"`, and the unlock box is `hidden` in the HTML: only the
page's script shows it. Without JavaScript the reader sees no field, only 查看 client_secret 需要开启 JavaScript。, and
the CSP's `form-action 'none'` would block a form submission even if one were injected. The local test proves it in
headless Chromium with JavaScript disabled (section 6).

**Files and nginx.** `/srv/ddcnew/partner-info/index.html` and `secret.json`, which nginx reads
(`chmod 644 index.html secret.json`; ciphertext only), in directories with mode 755: www-data cannot traverse `/root`,
and the page is never under `/root/ddc*` or `/opt/ddc`. `30-nginx.sh` gives the app vhost (not the api one)
`location ^~ /partner-info/` with `alias /srv/ddcnew/partner-info/`, `index index.html` and the headers
`Cache-Control: no-store`, `X-Robots-Tag: noindex, nofollow`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`,
`X-Content-Type-Options: nosniff` and `Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline';
style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; form-action 'none';
base-uri 'none'`. The page loads nothing from another origin: system fonts, inline CSS and JS.

**The page password is created in, and read from, 1Password only.** Once, by Sloan:

```bash
op item create --category=password --title='TGE 对接页密码（测试环境）' --generate-password='32,letters,digits'
# optional: --vault '<vault>'. The output gives the item's ID; the reference is op://<vault>/<item ID>/password
# (or, in the 1Password app, the password field's "Copy Secret Reference").
```

It is never typed into a terminal, passed as an argument, written to a file or set as an environment variable: `op read`
pipes it into `remote.sh`, which forwards its stdin to the script through ssh (the login's own `op read` calls take
`/dev/null` as stdin, so they cannot swallow it). `remote.sh` refuses `apply` and `verify` when stdin is a terminal. The
script accepts exactly the generator's shape, 32 letters and digits (anything else, a blank or a line-ending character
included, is refused without printing it), and refuses any run with xtrace. Sloan shares the password with the
partner.

**Steps** (from the Mac in `deploy/new-stack/`, each with Sloan's approval):

| # | Command | Changes on the server | Pass criteria | Undo |
|---|---|---|---|---|
| P1 | `DDC_APPROVED=yes ./remote.sh upload` | this package's scripts and `partner-info/index.html` in `/root/ddcnew/deploy` | `files=12` | `rm -rf /root/ddcnew/deploy` |
| P2 | Only while the rehearsal env still has the `.invalid` placeholder (P4 says so): `DDC_APPROVED=yes ./remote.sh run 20-env.sh REHEARSAL_REDIRECT_URIS=<partner callback> REHEARSAL_INITIATE_LOGIN_URI=<partner start-login URL>`, then `DDC_APPROVED=yes ./remote.sh run 40-up.sh` | `.env.rehearsal`; the api runs with it | section 4, steps 9 and 10 | as there |
| P3 | `DDC_APPROVED=yes ./remote.sh run 30-nginx.sh apply` (with section 9's flag or overrides) | both vhosts written again, the app one with `/partner-info/`; nginx reload | section 4, step 11; the printed diff adds the location to the app copy only | `./remote.sh run 30-nginx.sh undo` (approved) |
| P4 | `op read "op://<vault>/<item>/password" \| DDC_APPROVED=yes ./remote.sh run 50-partner-page.sh apply PARTNER_ALLOWED_IP=<partner server IP>` | `/srv/ddcnew/partner-info/index.html` and `secret.json`; one throwaway container, removed | `PASS sha256(secrets/tge_rehearsal_client_secret) = SSO_TGE_CLIENT_SECRET_SHA256`, `PASS secret.json: v=1 kdf=PBKDF2-SHA256 iter=600000 ...`, the two paths with their mode and sha256, old stack unchanged | `50-partner-page.sh remove` |
| P5 | `op read "op://<vault>/<item>/password" \| DDC_APPROVED=yes ./remote.sh run 50-partner-page.sh verify` | nothing but its log | `match=yes` | - |
| P6 | `./remote.sh run 50-partner-page.sh status` (read-only) | nothing | both files with the sha256 that P4 printed; `/partner-info/ location count=1`; `PASS local nginx: /partner-info/ -> 200, served body = index.html` and the same for `secret.json` (the sha256 of what nginx serves equals the file's) | - |
| P7 | From a team address: open `https://<APP_HOST>/partner-info/`, enter the password from 1Password, see the secret, press 隐藏 | - | the page decrypts; the browser's network panel lists `<APP_HOST>` only (a script the CDN might inject is blocked by the CSP) | - |

**After the joint test, rotate both.** New client secret: in an approved login,
`rm /root/ddcnew/secrets/tge_rehearsal_client_secret`, then `20-env.sh` (it generates a new one) and `40-up.sh`. New
page password: `op item edit <item ID> --generate-password='32,letters,digits'`. Then P4 to P6 again, or `remove` when
the page is no longer needed.

**Undo:** `DDC_APPROVED=yes ./remote.sh run 50-partner-page.sh remove` deletes `/srv/ddcnew/partner-info` (and
`/srv/ddcnew` when it is then empty). `99-teardown.sh` removes the vhost, so the page is no longer served, but not these
files.

**Risks.**
- The page password is shared by Sloan, outside these scripts. Anyone who can reach the page (the team's addresses and
  the partner server's, through the WAF rule) and has the password sees the client secret.
- `secret.json` can be downloaded by anyone who can reach the page. Each offline guess costs 600,000 PBKDF2 iterations,
  which protects only a random password: use the generator (32 letters and digits); the script checks that shape, not
  the randomness.
- Both are test-environment credentials: rotate the client secret and the page password after the joint test.
- If the CDN injects a script into pages (an analytics beacon, for example), the CSP blocks it: check once in P7.

## 9. Which stack serves the rehearsal hosts (decision pending, 10-05)

On 10-05 Race started his own mainnet rehearsal on the production host: containers `ddc-mainnet-api` (127.0.0.1:10010)
and `ddc-mainnet-app` (127.0.0.1:9011), files in `/root/ddc-mainnet`, and vhosts `api-rehearsal.datadance.ai` and
`app-rehearsal.datadance.ai` (plus older `tge-api.datadance.ai` / `tge.datadance.ai` files) that point at them. The
frontend (a3ee809) builds its tge web app for `https://api-rehearsal.datadance.ai/api`. This package therefore treats his
containers, files and vhosts like the old stack (fingerprinted, never written), uses other ports by default (10020,
9021, 15434), and never overwrites his vhosts unless told to. Sloan and Race decide (item O):

**A. This stack takes over Race's names** (after his OK). The defaults already name his hosts; only `30-nginx.sh apply`
needs the flag. The stack boots first (`40-up.sh`), so his hosts are never pointed at a stack that has not booted:
`30-nginx.sh apply` refuses the take-over until this stack answers on its ports, backs his four entries up, and runs
the Host-header checks through the new vhosts right after the reload, this package's vhost token first (`40-up.sh`
defers them while his vhosts still serve the names). Any failure after his entries were removed, a signal included,
puts them back at once.

```bash
./remote.sh preflight                                    # WARN lines name his entries at the two names; no FAIL
DDC_APPROVED=yes ./remote.sh upload
./remote.sh pack-web <FE_SHA>                            # a frontend commit at or after a3ee809 (api-rehearsal)
DDC_APPROVED=yes ./remote.sh upload-web <FE_SHA>
DDC_APPROVED=yes ./remote.sh run 10-build.sh <BE_SHA> <FE_SHA> --infra-only
DDC_APPROVED=yes ./remote.sh run 20-env.sh REHEARSAL_CLIENT_ID=<the partner's client id>
DDC_APPROVED=yes ./remote.sh run 40-up.sh                # the stack boots; step 7 (Host-header checks) is DEFERRED
DDC_APPROVED=yes ./remote.sh run 30-nginx.sh apply TAKE_OVER_VHOSTS=yes   # refused until the stack answers; Host checks after the reload
./remote.sh run 30-nginx.sh status                       # four entries "ours"; the backup listed
```

Undo, in this order: `DDC_APPROVED=yes ./remote.sh run 30-nginx.sh restore` FIRST (his entries back exactly as they
were and this package's removed, in one reload; whether his containers still serve them is his to check), THEN
`DDC_APPROVED=yes ./remote.sh run 99-teardown.sh`. `99-teardown.sh` and `30-nginx.sh undo` refuse until the restore:
run first, they would leave his names without any vhost (nginx would answer them from its default server) until
someone restored them. Clean-ups of his own
(his older `tge-api.datadance.ai` / `tge.datadance.ai` files) are his: this package never touches them.

**B. Both stacks run side by side**, this one under other names. Prerequisites: DNS records, the WAF rule and the
Web3Auth allow-list entry for the two new hosts (items F to H), and a frontend commit whose `API_BASE_URLS.tge` is
`https://<new api host>/api` (`10-build.sh` refuses any other before it builds). The default ports already differ from
his. Pass the names on the first write call; the record keeps them for every later one:

```bash
./remote.sh preflight API_HOST=<api host> APP_HOST=<app host>
DDC_APPROVED=yes ./remote.sh upload
./remote.sh pack-web <FE_SHA>                            # a frontend commit built for https://<api host>/api
DDC_APPROVED=yes ./remote.sh upload-web <FE_SHA>
DDC_APPROVED=yes ./remote.sh run 10-build.sh <BE_SHA> <FE_SHA> --infra-only API_HOST=<api host> APP_HOST=<app host>
DDC_APPROVED=yes ./remote.sh run 20-env.sh REHEARSAL_CLIENT_ID=<the partner's client id>
DDC_APPROVED=yes ./remote.sh run 40-up.sh                # step 7 DEFERRED until the vhosts exist
DDC_APPROVED=yes ./remote.sh run 30-nginx.sh apply       # Host-header checks after the reload
```

`30-nginx.sh apply` checks around the reload that his hosts answer exactly as before, and stops if another loaded vhost
already declares one of the new names. In both outcomes the partner page follows with section 8's P4 to P6. Undo:
`DDC_APPROVED=yes ./remote.sh run 99-teardown.sh`. To move from B to A
later: `99-teardown.sh` (it removes the record), then the A sequence from `10-build.sh` on (the web image must be built
for `api-rehearsal`).
