# API-only Compose preparation and recovery

The running legacy process and its RAM are the initial owner. The normal first
operation is **prepare**, not Compose having permission to replace that API.
Shared recovery is a different operation. Neither replaces the aged-out-legacy
or live-ingress evidence with a flag.

## Interface

Prerequisites are the existing Compose project and the three reviewed, already
local immutable Docker image IDs. Under the actual project directory put
`handoff-api/policy.json` in an operator-owned private directory. Policy is
`{"version":1,"project":…,"publishedPort":…,"legacyImage":…,"primaryImage":…,"rollbackImage":…}`.
Do not put credentials in these files. Continue using the project's current
API environment inputs.

Run `python3 -B reconcile-api.py --directory PROJECT_DIR --project PROJECT prepare`.
This starts the primary image as a Compose one-off in the same project network,
using the verified build's native Unix socket listener. Docker does not publish
any port for it. The CLI checks the actual image and socket health, checks the
DB/signing identity without disclosing it, and rereads the old container ID, PID
and start time. No old PID, routing, authorization window, DB schema or peer
service changes. It cannot make the standby a traffic owner. A failed newly
created staging instance is removed by its own identity. Retiring a prepared
standby that's still referenced by ingress is not part of this command.

After actual migration, a **stopped/unavailable** shared API can be recovered
using `recover --image primary` or `recover --image rollback`. These check the
managed template, exact owner and complete retirement evidence, candidate
read-only shared-schema/startup compatibility and the signing/store identity
before invoking the API-only Compose command. The new PID initially opens no
socket. It receives an admission bound to the live boot, namespace, private
nonce, operator policy, owner digest and the actual compatible image that
Compose started. Rollback doesn't revive the incompatible legacy image.

An **active** API refuses recovery before sending any signal, because its
container owns the published/direct ingress. The isolated private standby is
not proof of full traffic transfer. A separate live release is allowed only
after an independent persistent ingress is actually deployed for the two vhosts,
host publication, direct bridge users and IPv6 loopback, preserving the client
identity and admitting new requests to the compatible standby while prior
requests finish on their original owner. This implementation does not pretend a
readiness receipt or old Nginx worker drain proves that topology.

## Evidence and deployment boundary

The retirement input is external evidence, not generated from absence of logs.
`owners.json` needs all three authentication families shared with no pending or
unknown state. The operator-protected `retired-legacy.json` includes version,
exact legacy generation and image, the owner SHA-256, shared target fingerprint,
whole-ingress closure, direct connection/unresolved work counts, the measured
quiet window, and every reviewed limiter namespace from the exact old image.
`additionalState` also covers crawler idempotency (default 24 hours for both
crawler routes), X-bind flow and the separate developer SSO proof limiter, with
actual expiration or observed empty state. The pack-purchase queue needs terminal
evidence, not an elapsed timer. The production observation-only journal does
not establish any of this retirement evidence. These inputs are not sample
values to fill out and never substitute for the real evidence producer.

`render-managed-api.py EXACT_SOURCE NEW_OUTPUT` renders the reviewed runtime
Compose and release script only if both exact input SHA-256s match. The generated
Compose change affects only the API. Direct `compose up --force-recreate api`
without a managed image uses a reserved unavailable image and cannot replace the
running service. The tool verifies that the reserved image does not resolve
locally and the default Compose configuration selects only that reserved name.
Do not tag an image as the reserve or set the managed image in project dotenv.
Docker administrators retain the ability to override the protected inputs.
The DB and web services can still run independently of the API release.
Restart is disabled for the managed container. Its entrypoint checks the live
admission and the shared-compatible image before opening a listener. Keep both
the installed template and its existing release-package source identical at
deployment, or the old installer can restore bare startup. The existing
installer guards before writing the template or starting other services. The
existing non-published maintenance invocations explicitly keep their old
entrypoint. Do not run the full stack installer as the API-only recovery entry.

`DDC_TEST_MANAGED_DOCKER=1 python3 -B test-reconcile-api.py` tests no-signal
refusal of a live shared API, whole-retirement evidence and an actual Docker
Compose default-path rejection preserving the incumbent container identity.
The full real-application, database and SMTP checks are separate scoped QA.
