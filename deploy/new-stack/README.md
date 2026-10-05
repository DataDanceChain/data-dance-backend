# deploy/new-stack

Operator scripts that build DataDance's new production stack (compose project `ddcnew`: api, db, web) next to the
live stack on the production host, plus the P1 database backups, the P2 disk cleanup and the password-protected
partner info page for the TGE partner (test environment). An operator runs them by hand
from a Mac through `remote.sh`. **No CI job and no deploy runs them**, and nothing in the backend application uses them.

- What each step changes on the server, its pass criteria and its undo: [APPROVAL.md](APPROVAL.md).
- The server's address, the current findings about it and its measurements are in the **private Drive runbook**, not
  in this repository. This repository is public (see "Public repository" below).

## Before running anything

1. `cp local.env.example local.env` and fill in `DDC_SSH_TARGET` and `DDC_OP_SECRET_REF` from the private runbook.
   `local.env` is gitignored. `remote.sh` and `survey/ro-ssh.sh` refuse to connect, and do not ask 1Password, while it
   is missing, a value is empty, a value is still `CHANGE_ME`, or a value has the wrong shape.
2. Read-only calls need no flag: `./remote.sh preflight`, `./remote.sh run p2-disk.sh preview` (or `expand-check`),
   `./remote.sh run p1-backup.sh status`, `./remote.sh run 30-nginx.sh status`, `./remote.sh run 50-partner-page.sh status`.
3. **Every call that writes to the server needs Sloan's approval**, given per call as `DDC_APPROVED=yes`; `remote.sh`
   refuses a write call without it. The order of the steps is in [APPROVAL.md](APPROVAL.md) section 4.

## Hosts and ports

The rehearsal hosts and the new stack's host ports are settings in `common.sh`: `API_HOST`, `APP_HOST`, `API_PORT`,
`WEB_PORT`, `DB_PORT`, by default `api-rehearsal.datadance.ai`, `app-rehearsal.datadance.ai`, 10020, 9021 and 15434.
Override them per call (`./remote.sh run <script> API_HOST=<host> ...`); the first write script records them in
`/root/ddcnew/settings.env`, later scripts use the record and stop on a different override, and `99-teardown.sh`
removes it. Race's own rehearsal (containers `ddc-mainnet-*`, `/root/ddc-mainnet`, his vhosts) is only read and
fingerprinted like the old stack: `30-nginx.sh` never overwrites a vhost it did not write unless
`TAKE_OVER_VHOSTS=yes` is passed after Sloan and Race agree (it backs the entries up first; `restore` puts them back).
Which stack serves the rehearsal hosts, and the commands for either outcome: [APPROVAL.md](APPROVAL.md) section 9.

## Files

| File | What it is |
|---|---|
| `remote.sh` | the only entry point from the Mac: preflight, upload, run; every call's output goes to `logs/` (gitignored) |
| `sshpw.sh` | login guard: reads `local.env`, asks 1Password before anything connects, never lets ssh send an empty password |
| `local.env.example` | template for the untracked `local.env` |
| `00-preflight.sh` | read-only checks on the server |
| `p1-backup.sh`, `p2-disk.sh` | P1 backups (dump, verify, nightly cron) and P2 disk cleanup and expansion check |
| `10-build.sh`, `20-env.sh`, `30-nginx.sh`, `40-up.sh`, `compose.yaml` | build, rehearsal env, nginx vhosts (apply, undo, restore after a take-over) and start of `ddcnew` |
| `50-partner-page.sh`, `partner-info/index.html` | the partner info page: the template, filled and published to `/srv/ddcnew/partner-info/` with client_secret as AES-256-GCM ciphertext; the page password comes from 1Password on stdin ([APPROVAL.md](APPROVAL.md) section 8) |
| `99-teardown.sh` | removes the new stack only (the undo) |
| `common.sh` | the settings (hosts, ports) and shared guards: write allowlist, old-stack fingerprint, run lock, build watchdog |
| `survey/` | read-only survey scripts and the read-only SSH runner; their outputs never go into the repository |
| `test/` | the local test suite (no server access) |

## Local tests

    bash test/run-local-tests.sh <new-scratch-dir>

Needs Docker Desktop, shellcheck 0.11, GNU coreutils (`grealpath`, `timeout`) and, for the partner page's browser test,
npm (it installs playwright-core 1.60.0 into the scratch directory and uses the local Playwright Chromium). Throwaway
containers and images are named `*-<DDC_TEST_SUFFIX>` (default `*-20261005`) and removed at the end; existing
containers are never touched. The run must end with
`summary: fails=0`. The SSH tests run on scratch copies of the scripts with a test `local.env` that points at a
throwaway loopback sshd, and the real 1Password CLI is never called. Section 13 scans every committable file of this
package for server addresses, 1Password references or ids, hashes or keys, statements about a server's security state
and, on the operator's Mac, the values of `local.env`.

## Public repository

The scripts name the old stack's paths, container names and ports and the public domains. They hold no host, no
secret and no finding, and must stay that way:
- the server address and the 1Password reference live only in `local.env` (gitignored);
- server findings, measurements, survey outputs and logs live only in the private runbook or in `logs/` (gitignored);
- production figures that a script needs, such as `P1_USERS_MIN`, are passed at run time from the private runbook.

## Risks of running it

Each write step is approved on its own. Every write step fingerprints the old stack before and after and stops if
anything changed, and only one write run can happen at a time. What remains:
- **`pg_dump` (P1):** adds read load on the live database for the length of the dump. DDL, `TRUNCATE` or migrations on
  the old database during a dump would queue behind its locks and stall production, so agree a no-DDL window with Race.
- **Image builds:** use CPU and memory on the shared host, which has no swap. The watchdog stops a build below 1000 MB
  of available memory or 3 GB of free disk, and marks the build steps so that the kernel kills them first.
- **nginx reload:** graceful, but it touches the live nginx. `30-nginx.sh` compares the status codes of every other host
  nginx serves (production and Race's) before and after the reload and stops if any changed.
