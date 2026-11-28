# Isolated first application handoff proxy

`node deploy/api-cutover/first-handoff-proxy.js` runs a single HTTP proxy plus a separate mode-0600 Unix control socket. The default is legacy-only for every request. The service does not install routing, grant network capabilities or enable a family on startup.

## Supervisor contract

| Variable | Meaning |
|---|---|
| `DDC_HANDOFF_LISTEN_HOST`, `DDC_HANDOFF_LISTEN_PORT` | Exact private IP and unprivileged TCP port. Use a separately verified dedicated internal listener, not a public interface. |
| `DDC_HANDOFF_CONTROL_SOCKET` | Absolute Unix control socket directly under the private state directory. |
| `DDC_HANDOFF_STATE_DIR` | Dedicated local persistent filesystem directory, owned by the service account, mode 0700. One process per directory. Do not reuse it for a different environment. |
| `DDC_HANDOFF_LEGACY_ORIGIN` | Exact private legacy HTTP origin, with no path or credentials. |
| `DDC_HANDOFF_LEGACY_LOCAL_ADDRESS` | Optional exact private source address for the proxy's dedicated legacy path. Bind it on the release topology and verify it is exclusive to this ingress. |
| `DDC_HANDOFF_SHARED_SOCKET` | Preferred absolute Unix socket for shared application state, in a mode-0700 mount with only the intended owners. Mutually exclusive with `DDC_HANDOFF_SHARED_ORIGIN`. |
| `DDC_HANDOFF_SHARED_ORIGIN` | Test or separately independently secured private HTTP target, with no path or credentials. Do not leave a shared-state TCP listener reachable directly by legacy peers. |
| `DDC_HANDOFF_TRUSTED_PROXY_IPS` | Optional comma-delimited exact private IPs whose authentic forwarded client address is trusted. Other peers use the actual socket address. The common Docker gateway alone does not prove caller authority. |
| `DDC_HANDOFF_CLOSURE_MODULE` | Optional absolute, trusted release verifier module exposing synchronous `verifyClosure(family)`. If absent, no family can start observation. |
| `DDC_HANDOFF_CLOSURE_POLICY` | Absolute root-managed JSON descriptor for the local closure adapter documented below. No app write access. |
| `DDC_HANDOFF_FORWARD_TIMING` | Only the exact string `true` separately routes POST `/api/app/journey-timing` without a query to the candidate. Off by default. Never otherwise expands migration scope. |
| `DDC_HANDOFF_STOP_DRAIN_SECONDS` | Wait for existing HTTP calls, upgrades, and detached tracked legacy work on shutdown. Default 120, bounded to 1–3600. A timeout refuses clean shutdown and preserves the lock, it does not kill clients. |

The verified source identity in this topology must give the exact same key as direct legacy for approved real callers, including IPv4/IPv6 representations. Feed only the same nearest trusted ingress address semantics to legacy Express. Do not configure a broadly shared Docker proxy address as the only evidence of trusted forwarding. Unknown paths, unclassified methods, ordinary streaming responses, and upgraded connections stay legacy. Only the complete email-code send/verify, email-bind send/verify, and OAuth token/revoke families can move. Preserve the original request URI and body. There is one upstream transport attempt and no cross-owner retries or fallback.

Use only the Unix socket for controls:

- `GET /status` reports owner, outstanding or unresolved legacy requests and which family clocks are active.
- `POST /observe/email-code`, `.../email-bind`, `.../oauth` begin a fresh clock only on proof for that family. Do not count previous intervals.
- `POST /invalidate` invalidates clocks without clearing the actual outstanding records.
- `POST /prepare-reverse` invalidates clocks first. Only a still-legacy deployment can restore the old ingress path by itself. If a family is shared, return 409 and use an independently approved rollback app on the same shared store instead.

The verifier is release-admission evidence, not a human enable switch. It must reflect the same current generation and establish source closure, zero direct legacy connections and zero unresolved legacy writes. A missing, throwing, or ambiguous verifier invalidates an observed legacy family rather than choosing the new owner. A previously committed shared family will not be sent to incompatible legacy if evidence disappears. The listener and routes must be migrated using the existing authorised service/route process. No production-ready verifier for the actual old disconnected asynchronous writes is shipped here. Do not replace its absence with constant trues.

## Native Linux closure adapter

Point `DDC_HANDOFF_CLOSURE_MODULE` at the absolute `closure-verifier.js` path. Its descriptor takes `generation`, `legacyImage` (immutable digest), `legacyStartBootMs`, `bootId`, `netns` (such as `net:[12345]`), `legacyAddress`, `legacyPort`, `gatewayAddress`, exact `routes`, and distinct absolute `topologyReceipt` and `completionReceipt` files. The existing root-managed supervisor can publish both artifacts by atomic replacement. No additional authorities or private keys are required. Install the files beneath a dedicated root-owned directory tree, readable but not writable by the proxy, with no symlinks or group/other write bits. No artifact producer is installed by this tool.

Each version 1 receipt binds `kind` (`topology` or `completion`), `generation`, `legacyImage`, `bootId`, `netns`, and `issuedBootMs`, `expiresBootMs`, `cutBootMs` on the kernel boot clock. Both receipts must match at the cut and have a live lease of at most 5 seconds. The topology receipt adds the exact `routes`, `legacyAddress`, `legacyPort` and `gatewayAddress`. Its producer must verify the actually installed IPv4/IPv6 routes, all published host and bridge paths, and exclusive use of the dedicated observer-to-legacy loopback tuple, not just read a configuration template. TTL alone cannot prove this. The adapter independently reads `/proc/uptime`, `/proc/sys/kernel/random/boot_id`, `/proc/self/ns/net` and both `/proc/net/tcp{,6}` tables in the old listener's network namespace. It counts retained direct sockets, including idle keepalive and half-closed sockets. It exempts only the exact observer-to-legacy loopback pair, including mapped IPv4. A topology that preserves the original source for both paths, or a generic Docker proxy source, cannot use this exemption.

The completion receipt adds `coveredSinceBootMs`, `coveredThroughBootMs`, and per-family `families[family]` counts of `admitted`, `terminal`, and `unresolved` for the old state that can be written after a disconnect. It must cover the old generation start through the closure cut and establish a terminal or unresolved classification for every admission. This does not assert PostgreSQL completion. A stalled publisher expires and the proxy polls armed clocks even without traffic. A shared family is checked again at each admission and returns 503 if proof is lost. It never falls back to an incompatible owner; ordinary traffic still uses legacy.

For the known old image, Morgan status on close, Winston's finish-only request log, and source-specific PostgreSQL rows do not jointly supply that coverage. OTP and email-bind sends can write old pending state after awaiting SMTP. Email-bind verification and OAuth have their own async state boundaries. Email-code verification only updates old pending and its limiter synchronously once it reaches the controller path and before any database wait. A Morgan-only entry does not establish this path for arbitrary requests because the old server also has a URL-encoded parser after Morgan. Keep the unresolved families on legacy unless real per-admission evidence exists. Do not publish zero counts from silence, or use this adapter to enable an unobserved old generation.

The legacy server applies its own 300-second request/response socket idle timeout. The proxy does not add its separate protected-route idle timer to ordinary legacy traffic, and flushes upstream headers for streams. Unknown requests and upgrades still use legacy. The effective production Nginx buffering, timeout, and forwarded-header behavior must be checked before a broad route change. In particular, the proxy generates the nearest trusted forwarded address rather than preserving arbitrary forwarding headers, so a dedicated source and real supported ingress identity equivalence are required.

## Terminal evidence and durable ownership

Each protected legacy request records pending state before its one upstream attempt. After a downstream disconnect with a complete upload, the proxy continues consuming the upstream response to look for its full valid termination. An incomplete upload, upstream failure or timeout is recorded as unresolved and disarms that family. A forwarded complete HTTP response establishes the application terminal only where the exact old route contract has established that its writes are awaited; it is not proof for old requests that bypassed this proxy before the cut. A live TCP socket is a blocker, but a disappeared unobserved socket alone is not proof its handler stopped.

The owner change and pending journal use fsynced replacement on a private local filesystem before new-owner traffic. Unknown writes latch until a separate audited reconciliation; there is no reset control. An unclean exit leaves the single-process lock. Recover it only after verifying the original process is gone and reconcile the saved pending records. A new process never implicitly reverts a shared owner and never resumes an observation timer. Don't remove the state directory or substitute an unaudited configuration on rollback.

## Local checks

`node --test deploy/api-cutover/test-first-handoff-proxy.js` exercises the implementation with local listeners, including a shared Unix socket, ordinary stream and legacy upgrade, client disconnect, unresolved upstream disconnect, and irreversible shared-owner guard. `python3 -B deploy/api-cutover/test-first-handoff-real.py ARCHIVED_IMAGE_QA` adapts a **temporary copy** of the existing exact-image QA scaffold to use this proxy with synthetic PostgreSQL/SMTP. The sample advances the test clock only for the lifetime window and does not claim real-time production observation. The separate namespace proof exercises the legacy direct-flow barrier, not a deployed admission service.
