# API blue/green worker drain

`drain.py` observes one Nginx master and its request workers. It does not read or modify application state, send signals, change routing, or stop a backend. The release owner still owns the lock, exact configuration hashes, target readiness, traffic probes, bounded maintenance decision, and rollback. Use one active upstream per affected route, not round-robin between these two API processes.

1. Independently verify the candidate cannot run background workers while the old API is still their owner, and verify its loopback readiness and release identity without sending a login flow. Keep both upstreams running until retirement is independently approved. Pin and validate the exact affected vhosts and original rollback references, including aliases pointing at the same upstream.
2. Under the release lock, capture the original worker set in a private file:
   `python3 -B drain.py --pid-file /run/nginx.pid snapshot > "$state/before.json"`
3. With the existing release gate, test the exact configuration and gracefully reload Nginx. Wait for the expected target identity on fresh connections through **every affected ingress**, never just a generic 200. If target verification fails, inverse the exact owned change while the old backend is still available. Do not retry a mutation across origins or add fall-through/round-robin as a substitute for rollback.
4. Keep the previous backend running while the old workers drain. `python3 -B drain.py --pid-file /run/nginx.pid wait "$state/before.json" --timeout-seconds "$approved_seconds"` succeeds only after the old worker identities are absent, the original master remains, and replacement workers exist. A timeout or unexpected generation is a refusal to retire anything. The release gate still must check target identity and upstream health. Worker exit is not proof that every application operation succeeded or that other clients/proxies cannot reach the old upstream.
5. Reverse the route using the same snapshot, reload, fresh-connection and drain sequence, with a **new** snapshot captured immediately before the reverse reload. A previous generation may still be draining while reverse begins. Keep both upstreams alive on any failed observation; do not kill a worker to make the guard pass. Test non-HTTP streaming/long-lived connections separately before relying on a bound for them.

## First process migration

The routing change prevents newly accepted connections from using the old route after the graceful handoff, while old Nginx workers may continue servicing existing clients. It does **not** copy volatile Node state. In the deployed legacy mode, email login and binding code stores and send budgets are process-local (`src/services/emailOtpLogin.js` and `src/services/emailBind.js`). A pre-switch code can fail at verification after a cutover or reverse cutover and require a new code. Request-rate windows are also independent (`src/middlewares/rateLimitMiddleware.js`), so cutover can reset enforcement history and concurrent public replicas would grant independent budgets. OAuth replay rejection still consults persisted code state, but the reverse link from an authorization code to its issued tokens for replay-triggered revocation is in memory (`src/services/oauthService.js`) and does not cross processes. Shared-database records are not evidence that those in-memory behaviors persisted.

Do not describe the first move as continuity for every existing authentication or OAuth transaction. Require shared durable state with cross-process behavioral proof, or a separately authorized bounded first-transition plan naming its actual code/retry, limit, revocation, and background-worker consequences. A successful production route check does not waive this admission gate.

### Shared-mode rollout after the first migration

Apply both additive database migrations before starting a shared-mode instance. Set `DDC_SHARED_AUTH_STATE=true` on both sides and verify that both use the same database and the same managed signing key. Startup refuses an invalid mode, a missing signing key or missing shared tables. Roll forward or back only to an image that reads and writes the same state. Changing the flag back to legacy mode discards visibility into active challenges, limits and issuance records.

Local isolated cutover coverage holds an actual token exchange at a PostgreSQL row lock, changes which worker receives new HTTP requests, consumes two previously issued challenges on the target, then releases the source exchange. With shared state on both sides, the login and binding both return 200, the exchange completes, and its issuance record survives the source exit. With legacy mode on the source, the same graceful routing sequence completes the exchange but both earlier challenges return 401 and the shared issuance record is absent. These are local application-route results. The Nginx signal test separately verifies the proxy worker lifecycle.

### What would make the first migration admissible?

- **Leaving all requests on the old process and waiting does not converge.** Live traffic can issue a fresh email login/bind challenge (10-minute lifetime), add to one-hour send limits, or exchange a fresh OAuth code (creating a five-minute issued-token reverse link). A rolling limiter can gain a fresh record throughout the wait. An old challenge and a new challenge have the same verification route and payload shape. Sending new challenges on green and verification on blue cannot distinguish the generation that owns a code. Keeping state-dependent routes on blue can defer migration, not finish it. The email challenge lifetime is not a safe drain duration for all state.
- **Continuous first transition needs actual old→new ownership proof.** The release owner must bind the observed running image on each side to an independently verified source/capability and a common durable-state backend plus schema. Both builds must use that store for the covered functions. Demonstrate in isolated QA with the actual old binary and candidate: issue a synthetic email challenge on old and successfully consume it on new once only, preserve resend and verify budgets across instances, and replay an already-consumed OAuth code on new while confirming cross-instance issued-token revocation. Verify reverse direction if it is the proposed rollback. A schema migration alone, two fresh instances of the candidate talking to each other, and the Nginx worker receipt are not substitutes. Without the old capability or a compatible state bridge, there is no observed continuity evidence for this first move.
- **Bounded maintenance is a separate decision, not a transparent handoff.** If the old image is incapable of using durable shared state, the release owner can prepare and seek authorization for an explicit, scoped admission hold. Prove the routing closure before relying on any hold: stop admitting all operations that can create the state being allowed to expire, observe completion of in-flight issuers, and start each lifetime from the last successful issuance, not from Nginx reload. Preserve the enforcement window or explicitly account for it without granting an extra rate budget. Show what users see and can retry. Keep the original instance for routing rollback, but do not assume it sees any state created by new after reopening. Either keep state-changing routes held through rollback validation and decide the reopen point explicitly, or make the first rollback target another independently verified version using the same durable state. No routing-only rollout or rollback can supply these application guarantees.

If the current running binary has no authenticated, testable state-compatibility contract, record that as a release blocker. The worker tool intentionally has no state override or operator-approval flag. A future release controller should require authenticated, build-bound application proof independently of its Nginx lifecycle proof.

## Local proof

`python3 -B deploy/api-cutover/test_drain.py /absolute/path/to/nginx` starts a fresh Nginx confined to an isolated directory and proxies two synthetic HTTP services bound to loopback. In both directions it sends fresh HTTP/1.1 connections after the replacement route appears, proves they reach only the replacement while an original request is still held, verifies premature drain is rejected, releases the original 200 response, and observes the original worker exit. It also rolls back early while both generations have held requests and verifies both drain safely. The previous backend stays alive and is inspected. This is an actual Nginx signal and proxy test, not a proof of the production runtime, TLS, HTTP/2, the Linux process-identity branch when run on macOS, or process-local application state continuity. See [Nginx graceful reload semantics](https://nginx.org/en/docs/control.html#reconfiguration).

### First handoff by route family

`first-handoff.js` tracks admissions for a route family that shares legacy state.
An authorized release controller must supply the persisted owner, an atomic
owner update, and a monotonic clock. It may start observation only after all
previous ingress workers have drained and every path to that family passes
through this owner. Keep admitting fresh work on legacy during observation.
A confirmed upstream completion starts the quiet window again. An ambiguous
disconnect invalidates observation. It cannot be rearmed by a timer alone.
Switch the next admission to shared only after the full lifetime passes
without an admission in progress. The first integration fixture exercises
three independent families: both login email routes (one hour), both binding
email routes (one hour), and OAuth token/revoke (five minutes). A continuously
active family keeps serving on its old owner.

A production-IP-compatible rollback of Nginx by itself does not restore app
state. After a family has moved to shared storage and admitted work there,
keep both the candidate and its rollback target on that same storage.
Retirement of the whole old API additionally requires an ownership inventory
for all other routes. In particular, do not expire the crawler idempotency
cache on the email or OAuth timer.
