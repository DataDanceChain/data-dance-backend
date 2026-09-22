# DataDance SSO for the TGE partner — integration guide (backend v0.1)

Normative contract: `ddc-sso-kit/openapi/ddc-sso-tge-v0.1.yaml`. This document explains how the
DataDance API implements it and what the partner backend must do. Where this build deviates from
the contract, the deviation is listed in §12.

## 1. What this is

- **OAuth 2.0 authorization code + PKCE (S256 only)** for **one** pre-registered, confidential
  partner client. No dynamic registration, no developer platform.
- **Not OpenID Connect.** There is no `id_token`; the `openid` scope is refused with
  `invalid_scope`. Configure a plain OAuth 2.0 client and read identity server-side from
  `GET /partner/tge/me`.
- **No refresh token.** Access tokens are opaque `ddc_tge_…`, live **300 s**, and are
  audience-bound to `{issuer}/partner/tge`. To read status again later, run a new authorization
  round-trip.
- Human authentication stays on DataDance pages (Wallet consent page, Web3Auth e-mail OTP). The
  partner never sees the DataDance user JWT.
- Every error that a user could see is rendered as a DataDance page; the browser is never
  redirected to an unregistered URI.

## 2. Environments and credentials

| | Test | Production |
| --- | --- | --- |
| Issuer (`iss`) | `https://staging-api.datadance.ai` (to be provisioned) | `https://api.datadance.ai` |
| Consent page | `https://<test wallet>/oauth/consent` | `https://app.datadance.ai/oauth/consent` |
| `client_id` | e.g. `tge-test` | e.g. `tge-prod` |
| Redirect URIs | registered per environment | registered per environment |

Credentials and redirect URIs are **never shared** between environments (F01). The client lives
only in the server environment (`SSO_TGE_*`), not in the database, so a test credential presented
to production is simply `invalid_client`.

The server stores only `sha256(client_secret)`. DataDance generates the secret with
`node scripts/genPartnerSecret.js` and hands it over once, out of band. Rotation: DataDance
configures the new hash plus the old one with a deadline; both secrets work until the deadline,
then only the new one.

## 3. Discovery

`GET {issuer}/.well-known/oauth-authorization-server` (RFC 8414). Relevant fields:

```json
{
  "issuer": "https://api.datadance.ai",
  "authorization_endpoint": "https://api.datadance.ai/oauth/authorize",
  "token_endpoint": "https://api.datadance.ai/oauth/token",
  "revocation_endpoint": "https://api.datadance.ai/oauth/revoke",
  "response_types_supported": ["code"],
  "code_challenge_methods_supported": ["S256"],
  "token_endpoint_auth_methods_supported": ["none", "client_secret_basic", "client_secret_post"],
  "authorization_response_iss_parameter_supported": true,
  "scopes_supported": ["openid", "email", "profile", "life_capsule", "tge:identity", "tge:status",
                       "tge:email", "tge:wallet", "tge:points", "tge:referral"],
  "ddc_sso_environment": "test"
}
```

`none` and the non-`tge:` scopes exist for DataDance's own AI-assistant (MCP) clients; the TGE
client **must** authenticate (`client_secret_basic` or `client_secret_post`) and may only use the
`tge:` scopes. `GET {issuer}/.well-known/oauth-protected-resource/partner/tge`
(RFC 9728) describes the partner API resource.

## 4. Authorization request (browser, top-level navigation)

```
GET {issuer}/oauth/authorize
  ?response_type=code
  &client_id=tge-test
  &redirect_uri=https%3A%2F%2Ftge.example.com%2Foauth%2Fcallback
  &scope=tge%3Aidentity%20tge%3Astatus
  &state=<>= 128 bits of entropy, bound to the browser session>
  &code_challenge=<BASE64URL(SHA256(code_verifier))>
  &code_challenge_method=S256
  [&login_hint=user%40example.com]
```

Same tab only: the consent page frame-busts, so never use an iframe or popup.

Validation order and what the browser sees:

1. `client_id` unknown or disabled, or `redirect_uri` not an **exact string match** to a
   registered URI → **HTTP 400 HTML page**, no redirect (T08). Exact means scheme, host, port,
   path and query byte-for-byte; a trailing slash or an extra query parameter is a mismatch.
2. Otherwise, a missing/invalid `response_type`, `state`, `code_challenge`,
   `code_challenge_method != S256`, unknown `scope`, `prompt` other than `none|login`, or a
   `resource` that is not the partner API → **302 to `redirect_uri`** with `error`,
   `error_description`, `state` (when supplied) and `iss` (T09).
3. Otherwise the request is stored (TTL **10 min**) and the browser is sent to the DataDance
   consent page.

`scope` defaults to `tge:identity`. Two kinds of scope:

- **Endpoint scopes** — `tge:identity` for `/partner/tge/me`, `tge:status` for
  `/partner/tge/status`. A token without the one an endpoint needs gets `403 insufficient_scope`.
- **Field scopes** — `tge:email`, `tge:wallet`, `tge:points`, `tge:referral`. Each unlocks exactly
  one field. A token without one is **not** an error: the call succeeds and the field is simply
  **absent from the body**. Ask only for what the campaign uses; the user sees the list.

An unknown scope is `invalid_scope` (redirected per §4.2). `state` is mandatory (max 512
characters). `login_hint` only pre-fills the DataDance login form.

**`prompt=none`** — this build answers `302 … error=login_required` immediately (see §12).

### Callback

Success: `https://tge.example.com/oauth/callback?code=ddc_code_…&state=…&iss=https%3A%2F%2Fapi.datadance.ai`
Denied / failed: `…?error=access_denied&state=…&iss=…`

The partner backend must, in this order: verify `state` matches the browser session; verify
`iss` equals the issuer it started with (RFC 9207 mix-up defence); then exchange the code
**within 60 s**.

Errors on the callback: `access_denied` (user declined, organization account, or account
disabled), `login_required` (a verified DataDance login is required; start again
interactively), `invalid_request`, `invalid_scope`, `unsupported_response_type`,
`invalid_target`.

## 5. What the user sees

The DataDance Wallet shows a consent page naming the partner and the requested scopes, one line
per scope (`GET /api/oauth/requests/:id` returns both the raw `scope` string and a rendered
`scopeItems: ["identity","email","wallet","points","referral"]`). If the
user has no DataDance session they log in first (Web3Auth e-mail OTP). Organization (B-end)
accounts cannot authorize a partner and receive `access_denied`. Nothing is shared until the
user allows.

### The authorization is bound to the browser that started it

`GET /oauth/authorize` sets a `__Host-ddc_authz` cookie (HttpOnly, Secure, SameSite=Lax, Path=/,
no Domain) carrying a high-entropy initiator nonce, and stores its SHA-256 on the authorization
request. **Approving requires that cookie back.** Without it — or with a different one — DataDance
refuses to issue a code and the Wallet renders "this sign-in was started on another device or
browser; start again from {client}". The browser is **not** redirected to `redirect_uri`, because
an error there would travel to whoever set the request up.

Why: without the binding, an attacker could start an authorization on their own machine, send the
resulting consent link to a victim, and have the victim's approval mint a code that arrives at the
**attacker's** registered callback, bound to the attacker's `state` and `code_verifier`. PKCE does
not help — the attacker holds the verifier. Contract-visible consequence: `POST /api/oauth/consent`
can now answer **`409` with `code: "AUTHZ_INITIATOR_MISMATCH"`** (a Wallet-internal endpoint; the
partner never calls it, and a partner-visible flow only ever sees "the user did not come back").

Two practical notes: a denial is still accepted from any browser (it only ever destroys the
request), and the nonce is per browser rather than per authorization, so two sign-ins open in two
tabs both complete.

The App hand-off is unaffected, because everything that matters happens in the **system browser**:
the ticket is redeemed there, the partner's `initiate_login_uri` is opened there, and the partner
starts `/oauth/authorize` from there — so the cookie is set in the same browser that will post the
consent. The WebView never holds it.

### App hand-off (DataDance Wallet App → system browser)

When the user starts from inside the DataDance Wallet App, the App does not send its own
session to the browser. It mints a single-use ticket (`POST /api/sso/app-ticket`, DataDance
first-party API), opens `https://app.datadance.ai/sso/continue#ticket=…` in the **system
browser**, and that page exchanges the ticket for a 5-minute session that DataDance accepts
only on its own consent endpoints.

**Nothing of this is visible to the partner.** The ticket and the session never leave
DataDance; the partner is entered exactly once, by a top-level navigation to its registered

```
{initiate_login_uri}?iss=https%3A%2F%2Fapi.datadance.ai
```

(OIDC Core §4 third-party-initiated login; `login_hint` is added only when DataDance knows an
unmasked e-mail, which in this build it does not). The partner MUST verify that `iss` equals
the DataDance issuer it trusts and then start `GET /oauth/authorize` itself, in the same tab,
with its own `state` and PKCE pair — exactly as in §4. From there the flow is identical to a
browser-initiated login, including the consent page and the callback.

What the partner must configure: `SSO_TGE_INITIATE_LOGIN_URI` on the DataDance side (the hand-off
is refused with `CLIENT_DISABLED` while it is empty), and an endpoint at that URI that ignores
any other parameter it receives.

## 6. Token request (partner backend → DataDance, server-to-server)

```
POST {issuer}/oauth/token
Authorization: Basic base64(urlencode(client_id) + ":" + urlencode(client_secret))
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code
&code=ddc_code_…
&redirect_uri=https%3A%2F%2Ftge.example.com%2Foauth%2Fcallback
&code_verifier=<43–128 unreserved chars>
```

- **Client authentication is mandatory.** `client_secret_basic` (encoding per RFC 6749 §2.3.1:
  each half is form-url-encoded before base64; the server percent-decodes after base64, so
  `tge-secret-dev` may arrive as `tge%2Dsecret%2Ddev`) or `client_secret_post` (`client_id` +
  `client_secret` in the body). Sending both methods is `invalid_request`. A body `client_id`
  next to Basic must agree with it.
- `redirect_uri` is mandatory and must equal the one used at `/oauth/authorize`.
- The code is **single-use, consumed atomically**. A second or concurrent exchange, an expired
  code (> 60 s), a wrong `code_verifier`, a different `redirect_uri`, or a different client all
  fail with `invalid_grant` (T10). Presenting an already-consumed code again also **revokes the
  token issued from it**.

Response (`Cache-Control: no-store`):

```json
{ "access_token": "ddc_tge_…", "token_type": "Bearer", "expires_in": 300,
  "scope": "tge:identity tge:status", "resource": "https://api.datadance.ai/partner/tge" }
```

Errors: `401 invalid_client` (+ `WWW-Authenticate: Basic realm="ddc-sso"`) for bad/missing
credentials or a disabled client; `400 invalid_grant`, `invalid_request`, `invalid_target`,
`unsupported_grant_type`; `429 slow_down`.

## 7. Partner API (partner backend → DataDance)

Send the token **only** in the header: `Authorization: Bearer ddc_tge_…`. A token in the query
string is refused (`400 invalid_request`). The subject is always taken from the token; a `sub`
or `user_id` parameter is refused (T12).

### `GET /partner/tge/me` — scope `tge:identity`

```json
{ "sub": "6f1c1a0e-…", "client_id": "tge-test",
  "issued_at": "2026-09-21T02:15:30.000Z", "expires_at": "2026-09-21T02:20:30.000Z",
  "email_masked": "s***@example.com",
  "email": "sloan@example.com",
  "wallet_address": "0x8ba1f109551bD432803012645Ac136ddd64DBA72" }
```

`email` needs `tge:email`, `wallet_address` needs `tge:wallet`. Without the scope the key is not
in the body at all.

**The partner API is strictly read-only.** Every handler runs inside a scope in which any
non-`SELECT` database operation throws, so a read can never change DataDance state — not even
indirectly, several helper calls down. One consequence is visible in the table below:
`referral.code` used to be *allocated and persisted* on demand by `GET /status`, and no longer is.

### `GET /partner/tge/status` — scope `tge:status`

```json
{ "sub": "6f1c1a0e-…", "account_status": "active",
  "registered_at": "2025-05-03T09:12:44.000Z", "wallet_bound": true, "data_licence_granted": null,
  "points": { "balance": 1234.5, "as_of": "2026-09-21T02:15:31.000Z", "cache_max_age": 0 },
  "referral": { "code": "AB23CD", "inviter_sub": "9d2e…", "direct_invitees": 12 },
  "as_of": "2026-09-21T02:15:31.000Z", "cache_max_age": 0 }
```

`points` needs `tge:points`, `referral` needs `tge:referral`.

**Caching.** Without `points` the response is `Cache-Control: private, max-age=60` and
`cache_max_age: 60`. **With** `points` the whole body carries a live balance, so it drops to
`Cache-Control: no-store` and `cache_max_age: 0` — never store a balance (T14).

### Field table

Unknown is always `null`, never fabricated. **Two gates** stand in front of every optional field:
the **scope** the user granted, and DataDance's per-environment freeze list
(`SSO_TGE_STATUS_FIELDS`). A gate that is shut means:

- for the original candidates (`registered_at`, `wallet_bound`, `data_licence_granted`,
  `email_masked`) — the key is present with value `null`;
- for the fields added for the campaign (`email`, `wallet_address`, `points`, `referral`) — the
  key is **absent**, so the partner can tell "this deployment does not serve it" from "DataDance
  has no value for this user" (which is `null` *inside* a field that is served).

| Field | Scope | Endpoint | Source | `null` means | Cache |
| --- | --- | --- | --- | --- | --- |
| `sub` | `tge:identity` | both | `User.id` (uuid) — permanent key, the same person across Wallet, Business and this partner | never null | — |
| `client_id`, `issued_at`, `expires_at` | `tge:identity` | `/me` | the token itself | never null | — |
| `email_masked` | `tge:identity` | `/me` | `User.email` as `j***@domain.com`; display hint, never an identifier | no real e-mail, **or the token lacks `tge:identity`**, or not frozen | no-store |
| `email` | `tge:email` | `/me` | `User.email` when it really is an address — the address a campaign can write to | the account has no e-mail (see below) | no-store |
| `wallet_address` | `tge:wallet` | `/me` | `User.walletAddress`, EIP-55 checksummed when it parses. **Not** proof of control, **not** permission to sign or transfer (F05) | no wallet bound | no-store |
| `account_status` | `tge:status` | `/status` | `User.disabledAt` → `active` / `disabled`; `unknown` until the column is deployed | never null | 60 s |
| `registered_at` | `tge:status` | `/status` | `User.createdAt` | not frozen | 60 s |
| `wallet_bound` | `tge:status` | `/status` | `User.walletAddress != null` | unknown / not frozen | 60 s |
| `data_licence_granted` | `tge:status` | `/status` | `DataLicenceConsent` active for the current policy version. Unrelated to partner eligibility | unknown / not frozen | 60 s |
| `points.balance` | `tge:points` | `/status` | `User.totalPoints` — the denormalised balance, maintained from the `Point` ledger inside the same transactions. The ledger is the source of truth; summing it per request is too expensive for a 120/min endpoint | never null while served; a new account is `0` | **0 — never cache** |
| `points.as_of` | `tge:points` | `/status` | server clock at read time | never null | — |
| `referral.code` | `tge:referral` | `/status` | the user's own short code (`User.referralCode`) **when the account already holds one in display form**, the same one the Wallet shows. A partner read never allocates one | the account has no display code yet (an older account whose code is still in the legacy form); it appears as soon as the Wallet allocates it | 60 s |
| `referral.inviter_sub` | `tge:referral` | `/status` | `Referral.inviterId` for this user as invitee — the `sub` of whoever invited them, for an upline rebate | nobody invited this user | 60 s |
| `referral.direct_invitees` | `tge:referral` | `/status` | **count** of level-1 invitees, campaign invites included (may exceed the figure the Wallet referral page shows, which lists standard referrals only) | never null; `0` when they invited nobody | 60 s |
| `as_of`, `cache_max_age` | — | `/status` | server clock | never null | — |

**Why `email` can be `null` while the account clearly logged in.** `User.email` is `NOT NULL`, so
a login that has no e-mail parks something else in it: an **external-wallet** login stores the
lower-cased wallet address, and a **legacy X login** stored the IdP subject `twitter|<id>`.
Neither is an address anyone can write to, so both read as `null` here (and `email_masked` is
`null` too). Use `wallet_address` to reach those users.

### What DataDance will never return

Not "not yet" — these are out of scope by design, and asking for them is a contract change, not a
configuration change:

- **Downline user lists.** `direct_invitees` is a count. The people this user invited are third
  parties who consented to DataDance, not to the partner; their ids, e-mails and names are never
  sent. There is no multi-level network total either.
- **Order data** — what the user bought, where they stayed, from whom.
- **Portrait / profile inference** — interests, segments, scores.
- **Raw records** — anything from Connect, the crawler, uploads or the data licence pipeline.

Eligibility for the partner's own campaign stays the partner's decision, not a DataDance field.

Errors (RFC 6750, `WWW-Authenticate: Bearer realm="ddc-sso", error=…, resource_metadata=…`):

| Status | `error` | When |
| --- | --- | --- |
| 401 | `invalid_token` | missing, expired, revoked, wrong-audience (e.g. an MCP token), or the client is switched off |
| 403 | `insufficient_scope` | token lacks the **endpoint** scope (`tge:identity` / `tge:status`; `scope="…"` in the challenge). A missing **field** scope is never an error — the field is just absent |
| 403 | `account_disabled` | the DataDance account is disabled |
| 429 | `slow_down` | per-token rate limit |

## 8. Revocation

`POST {issuer}/oauth/revoke` with client authentication (as in §6) and `token=ddc_tge_…`
(`token_type_hint=access_token` optional). Always `200` for unknown tokens (RFC 7009 §2.2).
Takes effect on the next `/partner/tge/*` call. `401 invalid_client` without credentials.

## 9. Freshness, kill switch, account stop

- A partner session should not outlive DataDance's decision. Before any sensitive action,
  re-read `/partner/tge/status` if the cached copy is older than `cache_max_age` (60 s) and end
  the local session on `401` or `403` (F06).
- **Kill switch:** DataDance sets `SSO_TGE_ENABLED=false` and recreates the container. From the
  next request `/oauth/authorize` renders a 400 page, `/oauth/token` and `/oauth/revoke` answer
  `401 invalid_client`, and every existing token is `401 invalid_token`. Tokens are ≤ 5 minutes
  old anyway (T13, T17).
- **Account stop:** once `User.disabledAt` is deployed, a disabled user cannot complete consent
  (`access_denied`) and existing tokens get `403 account_disabled`.

## 10. Rate limits

Per IP: `/oauth/authorize` 30/min, `/oauth/token` 20/min, `/oauth/revoke` 20/min. Per token:
`/partner/tge/*` 120/min — unchanged by `points` and `referral`. The limit is sized for a partner
backend reading once per user session; it is not a bulk-export budget. `429` bodies use the OAuth error shape with `error=slow_down`. (These
limits ship with the hardening change set; until it is deployed the endpoints are unlimited.)

## 11. End-to-end example

```bash
ISS=https://staging-api.datadance.ai
VERIFIER=$(openssl rand -base64 48 | tr -d '=+/' | cut -c1-64)
CHALLENGE=$(printf %s "$VERIFIER" | openssl dgst -sha256 -binary | openssl base64 -A | tr '+/' '-_' | tr -d '=')
STATE=$(openssl rand -base64 24 | tr -d '=+/')

# 1. browser → (store STATE and VERIFIER in the browser session first)
open "$ISS/oauth/authorize?response_type=code&client_id=tge-test&redirect_uri=https%3A%2F%2Ftge.example.com%2Foauth%2Fcallback&scope=tge%3Aidentity%20tge%3Astatus&state=$STATE&code_challenge=$CHALLENGE&code_challenge_method=S256"

# 2. callback arrives: ?code=…&state=…&iss=… → check state and iss, then within 60 s:
curl -sS -u "tge-test:$CLIENT_SECRET" "$ISS/oauth/token" \
  -d grant_type=authorization_code -d "code=$CODE" -d "code_verifier=$VERIFIER" \
  --data-urlencode redirect_uri=https://tge.example.com/oauth/callback

# 3. read identity and status (server-side)
curl -sS -H "Authorization: Bearer $ACCESS_TOKEN" "$ISS/partner/tge/me"
curl -sS -H "Authorization: Bearer $ACCESS_TOKEN" "$ISS/partner/tge/status"
```

(`curl -u` form-encodes nothing; that is fine for a secret made of unreserved characters, which
is what `genPartnerSecret.js` produces. Libraries such as openid-client encode first, which the
server also accepts.)

## 11b. Request correlation (`X-Request-Id`)

Every response carries `X-Request-Id`. **It is always DataDance's own identifier**, a fresh UUID
per request; an inbound `X-Request-Id` is no longer echoed back and is never used as the key of
the DataDance record. If the partner sends one, it is kept beside ours in our logs as
`upstreamRequestId`, so a support conversation can be joined up from either side. Quote both when
reporting an incident. (Rationale: an audit record on a money path cannot be keyed on an
identifier its subject picks — two requests could otherwise share one id, or collide with
somebody else's.)

## 12. Deviations and limitations of this build

- **`prompt=none` never succeeds.** The authorization server keeps no browser session of its
  own (the DataDance login lives in the Wallet app), so a silent re-authorization is answered
  with `error=login_required` right away. Fall back to the interactive flow. Silent re-reads are
  a Wallet-side feature to be scheduled separately.
- **`account_status` is `unknown`** until the `User.disabledAt` column (verified-login change
  set) is deployed. It is then `active` / `disabled` and never `unknown`.
- **Candidate fields default to `null`.** `registered_at`, `wallet_bound`,
  `data_licence_granted` and `email_masked` are enabled per environment through server
  configuration once frozen in 阶段 1. Ask which are on in the test environment.
- **The contract file `ddc-sso-tge-v0.1.yaml` is behind this build.** v0.1 says the partner API
  "never returns points balances" and lists only `tge:identity` / `tge:status`. The project owner
  widened it: `tge:email`, `tge:wallet`, `tge:points` and `tge:referral` now exist and `/status`
  can carry a balance and a referral summary. Everything v0.1 forbids that is not in the list
  above — orders, portrait, raw records, downline lists — still holds. The YAML needs a v0.2.
- **`referral` carries no network total.** An earlier draft of this change also returned
  `network_size` (a 4-level downline count); the owner dropped it. Only the user's own code,
  their inviter's `sub` and a level-1 count are served, and the query never materialises the
  invitees.
- **Replay revocation is per process.** The link "code → token issued from it" is kept in memory
  for 5 minutes; after a server restart a replayed code is still refused, but the earlier token
  is not revoked. The token expires within 300 s regardless.
- `state` minimum length (22 characters in the contract) is not enforced server-side; entropy is
  the partner's responsibility. Maximum length 512 is enforced.
- `token_endpoint_auth_methods_supported` also lists `none` because DataDance's own AI-assistant
  clients are public PKCE clients. The TGE client is never accepted without a secret. During the
  campaign window DataDance additionally closes dynamic registration
  (`OAUTH_PUBLIC_REGISTRATION_ENABLED=false`): `POST /oauth/register` and client-metadata
  documents are then `403`, so no new client can appear while the flow is live. The static TGE
  client is unaffected either way.
- **The code is re-checked against the account at the exchange.** An account disabled between the
  consent click and `POST /oauth/token` (up to 60 s) now yields `invalid_grant`, not a token. A
  partner backend needs no change: `invalid_grant` was already a possible answer there.
- **Contract additions in this build** (the YAML needs them in the next revision): `POST
  /api/oauth/consent` can answer `409 AUTHZ_INITIATOR_MISMATCH` (§5, Wallet-internal), and
  `email_masked` is gated on its declared `tge:identity` scope as well as on the freeze list —
  which changes nothing for a real caller, since `/me` already requires that scope.

## 13. Vendor acceptance checklist (maps to T01–T18)

- [ ] T01/T02 — full login round-trip in test env; `/me` returns the same `sub` on repeat logins.
- [ ] T08 — a `redirect_uri` with a trailing slash or extra query renders the 400 page (no redirect).
- [ ] T09 — omit `state` → callback carries `error=invalid_request` and `iss`; `iss` is verified.
- [ ] T10 — exchange the same code twice → second is `invalid_grant`; the first token is 401 afterwards.
- [ ] T12 — `/me?sub=…` is `400`; a token in the query string is `400`.
- [ ] T13/T17 — after DataDance flips the kill switch, tokens are `401` and the partner session ends.
- [ ] T14 — `/status` is not cached beyond `cache_max_age`.
- [ ] T15 — the client secret exists only in the partner backend; never in a browser or a URL.

## 14. DataDance operations

Environment (see `env.example`): `SSO_ENVIRONMENT`, `SSO_TGE_ENABLED`, `SSO_TGE_CLIENT_ID`,
`SSO_TGE_CLIENT_NAME`, `SSO_TGE_CLIENT_SECRET_SHA256`, `SSO_TGE_CLIENT_SECRET_SHA256_PREVIOUS`,
`SSO_TGE_SECRET_ROTATION_UNTIL`, `SSO_TGE_REDIRECT_URIS`, `SSO_TGE_INITIATE_LOGIN_URI`,
`SSO_TGE_STATUS_FIELDS`, `SSO_REQUIRE_VERIFIED_SESSION`, plus `PUBLIC_BASE_URL` (now required
unconditionally — the issuer is never derived from a request header), `APP_PUBLIC_URL`,
`WEB3AUTH_ALLOWED_VERIFIERS` and `OAUTH_PUBLIC_REGISTRATION_ENABLED`.

- `src/server.js` calls `assertPartnerConfig()` at boot and refuses to start with every problem
  listed (missing hash, http redirect URI outside localhost, fragment, unknown status field,
  missing public URLs in production, malformed client id).
- It then calls `assertFinancialGradeConfig()`: with `SSO_TGE_ENABLED=true` the container also
  refuses to start unless `NODE_ENV=production`, `WEB3AUTH_VERIFY_MODE=enforce`,
  `WEB3AUTH_ALLOW_LEGACY_FALLBACK=false`, `WEB3AUTH_CLIENT_ID` and `WEB3AUTH_ALLOWED_VERIFIERS`
  are non-empty, `SSO_SESSION_SECRET` is set and differs from `JWT_SECRET`, and `PUBLIC_BASE_URL`
  / `APP_PUBLIC_URL` are set and https. There is no flag to switch that off — turn
  `SSO_TGE_ENABLED` off instead. The boot log prints a summary with no secret values. See the
  README section "金融级加固：合作方 SSO".
- Generate a secret: `node scripts/genPartnerSecret.js` (prints once; nothing is written).
- Rotate: move the current hash to `…_PREVIOUS`, set the new hash, set `…_ROTATION_UNTIL`,
  recreate the container; after the deadline remove the previous hash.
- Freeze a status field: add it to `SSO_TGE_STATUS_FIELDS` and recreate. `email`,
  `wallet_address`, `points` and `referral` are **off** until listed, so deploying this change
  set alone exposes nothing new. Boot refuses an unknown field name.
- `SSO_REQUIRE_VERIFIED_SESSION=true` requires the consenting user's DataDance JWT to carry
  `ver >= 2` (issued by the verified Web3Auth login); older sessions get `login_required`.
- Partner tokens are `McpToken` rows with `source = 'partner'`; they are hidden from the
  user-facing token list and cannot be used on `/mcp` or `/oauth/userinfo`.
