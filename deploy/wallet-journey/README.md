# Wallet journey operations monitor

This reads only the existing `wallet_journey_timing` records in the independent
`ddc-journey-collector-v85` container's Docker logs. It uses the host's existing
Python 3.9+ and local Docker CLI with no packages, new container, network service,
application reload, DB access, or change to collector retention. The one-off
`scripts/summarizeWalletJourneys.js` remains available for older diagnostic inputs.

## How to interpret it

- The latest report is a rolling 30-minute snapshot, **not** a batch to be
  added to preceding snapshots. A flow belongs to the window by the Docker
  receipt time of its initiating event. At startup the monitor replays the
  available 30 minutes once, then tails that container's live stream. The
  20-new-settled-flow trigger is evaluated every 15 seconds and otherwise a
  report is written at five minutes, even with zero samples. On collector
  replacement the new snapshot marks the changed source. No data is silently
  merged across two container identities.
- Group key is journey + initiating platform + channel + release + visibility.
  Unlabelled legacy data stays `unknown`; unregistered release values become
  `unrecognized`. The only reportable release values are full Git SHAs the
  operator copied from trusted release evidence into `DDC_JOURNEY_RELEASES`.
  An incoming prefix resolves only to one uniquely matching trusted full SHA,
  and the report never echoes the prefix itself. A reported client
  value is a telemetry label, not proof of identity or authenticated version.
  A flow marked hidden or backgrounded goes in the hidden cohort.
- Wallet ready is login success. A successful exit via the consent/external
  redirect is `redirectSuccess`, not Wallet ready. Explicit errors,
  cancellations, timeouts, and explicit stops are separate outcomes. A flow without an
  observed terminal is pending until 20 minutes after its start is received,
  then incomplete. A cold start without a login action appears in
  `coldOnly`; it is not evidence of a failed login attempt. Ambiguous
  terminals, mismatched dimensions or chronologically invalid endpoints
  do not count as successes.
- Planet's last observed success is handoff exchange, **not** interactive
  assets. No total from Wallet cold start to interactive Planet assets is
  inferred. Only stages within the same anonymous flow pair. Exact replay
  is counted once, conflicting event values are not averaged. Percentiles
  use nearest rank on observed client-ms pairs, never on missing stages.
  Empty sample sets report null. The segment counts include only observable
  pairs and can differ from the outcome counts.
- This is observed telemetry, not a census. Read the source bounds, input
  counters and report freshness before comparing groups. Docker rotation
  may shorten replay, and the first log after the requested boundary could
  mean either no traffic or missing history. The monitor marks retention
  coverage unverified rather than reporting that unobserved traffic was
  zero. Restart restores retained flows without keeping individual keys on
  disk. Deleted/rotated intervals and receipt time of replays lost to
  retention cannot be reconstructed from the aggregate.

## Local verification

```sh
python3 deploy/wallet-journey/test_summarize.py
python3 deploy/wallet-journey/test_docker.py
```

The second check is optional, creates only a uniquely named network-isolated
local container using the already cached `node:22-alpine` image (no pull),
and removes that exact container. It exercises real Docker stdout history,
live follow, deduplication, both report triggers, monitor restart, and source
replacement. It does not send app or production traffic.

## Approved-host enablement

This is a standalone systemd unit for the **existing authorized Wallet collector
host**, not a step in the main API cutover. The host release operator should
verify the merged checkout SHA and files, confirm there is one running
`ddc-journey-collector-v85` with the expected image and normal Docker log
access, verify `/usr/bin/python3` is at least 3.9 and `docker` resolves
on the system service PATH. Do not create a second reader if there is already
an enabled unit of this name. If the next collector uses a different name,
set the exact source with the service's documented `--container` argument
in the operator's reviewed unit revision. Never fall back to the main API.

Using the existing authorized host-change channel, the operator stages the
two merged files, plus the optional nonsecret environment file containing
`DDC_JOURNEY_RELEASES="FULL_SHA_OF_DEPLOYED_WEB FULL_SHA_OF_OTHER_APPROVED_CLIENT"`
with real 40-hex values (omit unavailable releases). Example host steps, from
the approved checkout:

```sh
install -D -m 0644 deploy/wallet-journey/summarize.py /opt/ddc/wallet-journey/summarize.py
install -D -m 0644 deploy/wallet-journey/ddc-wallet-journey-monitor.service /etc/systemd/system/ddc-wallet-journey-monitor.service
systemd-analyze verify /etc/systemd/system/ddc-wallet-journey-monitor.service
systemctl daemon-reload
systemctl enable --now ddc-wallet-journey-monitor.service
systemctl is-active ddc-wallet-journey-monitor.service
journalctl -u ddc-wallet-journey-monitor.service -n 10 --no-pager
```

Confirm `/var/lib/ddc-wallet-journey-monitor/latest.json` is mode 0600 and
refers to the verified collector, and that its `asOf` advances within the
five-minute interval (plus poll allowance). Verify an actual known client
observation or report zero observed and the coverage limitations. No bearer,
ticket, address, flow UUID or unaudited release string should appear in the
file or in monitor journal lines. The unit writes one JSON cohort per journal
line, then one report receipt; inspect timestamps and joins by `asOf`.
The root-only atomic latest file is authoritative. Journal history follows
the host's existing retention. Alert to the existing host-monitoring channel
on inactive service, stale `asOf` (>6 minutes), or nonzero capacity drops,
not on a quiet sample window. The host monitor binding is an enablement check,
not asserted to exist merely because this unit is installed.

Rollback is `systemctl disable --now ddc-wallet-journey-monitor.service`
followed by removing only the installed candidate unit and its monitor files
(or restoring their prior verified versions), then `systemctl daemon-reload`.
No collector, API process, route, or log driver should restart. Preserve
aggregate receipts if needed for the change record.
