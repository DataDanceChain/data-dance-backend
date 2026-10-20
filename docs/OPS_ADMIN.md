# Ops Admin API

Internal operations panel. Operators sign in with their own DataDance account and act with a role
the server checks on every request. Every change made through the ops site, the developer
console's staff endpoints or `scripts/opsRoles.js` is written to an append-only audit log.

## Sign-in

- **Personal (the normal way).** The ops site sends the operator to the developer console
  (`/developers/#ops-signin`), which holds the DataDance sign-in. After a confirm click the console
  calls `POST /api/ops/auth/code` with the wallet JWT and a PKCE challenge; the server answers a
  60-second, single-use code and the fixed redirect `OPS_ADMIN_URL/auth/callback`. The ops site
  exchanges it with `POST /api/ops/auth/exchange { code, code_verifier }` for an ops session
  (`OPS_USER_TOKEN_TTL_SEC`, default 12 h, no refresh). The account must be enabled and hold
  `ddc_admin` or `operator` when the code is minted, when it is exchanged, and on every request.
  The exchange has its own rate limit (10 failures per 15 minutes per address), separate from the
  password login's, so a stale or repeated code never locks the login out.
- **Which wallet sign-in may mint a code.** A verified session (`ver: 2`, from a Web3Auth ID token)
  signed in within the last 10 minutes, issued after the account's last disable / re-enable.
  Refusals: 403 `VERIFIED_SESSION_REQUIRED`, 403 `RECENT_SIGN_IN_REQUIRED`, 401
  `SESSION_REVOKED`, 403 `ACCOUNT_DISABLED`, 403 `NOT_STAFF`. The console answers the first three
  by signing the visitor out and asking for a new sign-in, then minting again.
- **Demo.** `POST /api/ops/auth/login` with the demo credentials: read-only, unchanged.
- **Shared login (for the move to personal sign-in).** `POST /api/ops/auth/login` with
  `OPS_ADMIN_USERNAME` / `OPS_ADMIN_PASSWORD`. It stays on unless `OPS_SHARED_LOGIN=off` (trimmed,
  any case; unset, `on` or any other value keeps it on), so deploying personal sign-in does not
  change how the ops site signs in today (see "Rollout"). Both values must be set: an empty
  username or password signs nobody in. Each sign-in is audited as actor `shared`. A shared
  session lasts as long as a personal one (`OPS_USER_TOKEN_TTL_SEC`). It holds `ops.read` and
  `ops.write` only (table below), so the user view withholds the same fields as for the demo login.
  Tokens the shared login issued before personal sign-in (role `admin`) keep working until they
  expire. With `OPS_SHARED_LOGIN=off` the shared credentials get the same 401 as a wrong password,
  and every shared token, old or new, is refused (401 `OPS_SESSION_INVALID`).

## Roles and permissions

Roles live in `UserRoleGrant` (`src/constants/opsRoles.js`). Grant the first `ddc_admin` accounts
with the script, then manage roles on the ops site:

```bash
node scripts/opsRoles.js list   [--role <role>]
node scripts/opsRoles.js grant  --email <e> --role <role> --reason "<why>" [--apply]   # dry run without --apply
node scripts/opsRoles.js revoke --email <e> --role <role> --reason "<why>" [--apply]
```

| permission | ddc_admin | operator | shared | demo |
|---|---|---|---|---|
| `ops.read` (every GET) | yes | yes | yes | yes |
| `ops.write` (campaigns, links, merchants, orders, payments, data requests, privacy requests, points) | yes | yes | yes | – |
| `ops.support` (sign-in issues; the user view's identity, roles and history) | yes | yes | – | – |
| `ops.payouts` (disbursement process / disburse) | yes | – | – | – |
| `ops.admin` (roles, disable / enable, audit, Data Planet manager) | yes | – | – | – |

`developer` gives no ops access: it lets a partner register SSO clients in the developer console
while self-serve registration is closed (`SSO_DEVELOPER_REGISTRATION=off`, or `allowlist` without
the account on the list). A missing permission answers 403 `FORBIDDEN_ROLE`.

`trusted_developer` also permits that registration and grants only the named capability
`sso.skip_confirmation`, without any ops permission. Admins grant/revoke it with the existing
reasoned role API. Application owners separately opt their clients in; revoke/disable/owner
changes reset that choice. See [developer consent controls](DEVELOPER_CONSENT.md) for the owner
endpoint, managed overlay, reset/audit boundary and default-false migration. Preference audit
action is `console.consent_settings`; role/account resets remain in their atomic role/account audit.

### Who acted, outside the audit log

Records that users, merchants or the demo login can read name the actor by a label, never by
e-mail or account id: a personal session writes `ops:` and the first 10 hex characters of
HMAC-SHA256 over the account id, keyed with HMAC-SHA256(`JWT_SECRET`, `ops-record-label`). The
same account always gets the same label; rotating `JWT_SECRET` changes the labels written from then
on (the shared login writes `shared`, the role script `script`). This covers a point's source id,
`PrivacyRequest.resolvedBy`, `kycReviewedBy`, the ledger metadata of a payment decision or merchant
credit (`confirmedBy`, `rejectedBy`, `operator`), a campaign's `createdBy` / `updatedBy` /
`publishedBy` and events, data request events, `UserRoleGrant.grantedBy` and `User.disabledBy`.
Who the person is stays in `OpsAuditLog` only (`actorUserId`, `actorLabel`). `GET /auth/me`
answers the label as `username` and the account's own e-mail as `email`.

### Sessions

- **Disable and re-enable end staff sessions.** Both set `User.sessionsResetAt`. An ops session,
  or a wallet JWT on `POST /auth/code` and on the console's staff endpoints, issued at or before it is
  refused (ops: 401 `OPS_SESSION_INVALID`; wallet JWT: 401 `SESSION_REVOKED` /
  `session_revoked`), and a sign-in code minted before it is not exchanged. The person signs in
  again. In the wallet itself an unexpired wallet JWT works again after a re-enable, as before.
- **Reset-time precision.** Newly issued Wallet and personal operations JWTs contain server-signed
  `iatMs`, consistent with `iat`. Staff checks compare its millisecond issue time with
  `sessionsResetAt`; a newly signed-in session can work later in the same second. Legacy JWTs
  without `iatMs` fail closed throughout the reset second. Malformed, inconsistent or future
  precise issue times cannot restore access. This boundary applies to staff operations, not to
  the ordinary Wallet session policy.
- **The developer console's staff endpoints** (`GET /api/developer/sso/admin/clients`,
  `GET /api/developer/sso/admin/staff-unlock`, and `POST /api/developer/sso/clients` registered
  with a role while self-serve registration is closed) apply the same rule as `POST /auth/code` without the
  10-minute limit: 403 `verified_session_required` for `ver` < 2, 401 `session_revoked` for a
  token from before the last disable / re-enable. `GET /api/developer/sso/me` reports
  `verified_session` so the console can ask for a new sign-in before calling them. A listed account
  registering under `SSO_DEVELOPER_REGISTRATION=allowlist` is held to the second part too: a token
  from before the last disable / re-enable does not count as listed (403 `registration_closed`,
  refusal reason `session_revoked`; see `docs/TGE_SSO.md`).

## Environment

```bash
OPS_SHARED_LOGIN=on                     # default on; only "off" turns the shared login off
OPS_ADMIN_USERNAME=ops                  # the shared login (unless OPS_SHARED_LOGIN=off); both must be set
OPS_ADMIN_PASSWORD=<strong-password>
# optional external demo. Read-only: every GET under /api/ops, no writes.
# Or put the same two fields in /app/config/ops-demo.json
OPS_DEMO_USERNAME=demo
OPS_DEMO_PASSWORD=<demo-password>
# optional
OPS_ADMIN_TOKEN_EXPIRES=7d              # the demo session
OPS_USER_TOKEN_TTL_SEC=43200            # personal and shared sessions, 300..43200
OPS_ADMIN_URL=https://admin.datadance.ai
PLANET_MANAGER_API_HOSTS=api.datadance.ai,api-rehearsal.datadance.ai
JWT_SECRET=<existing-jwt-secret>
```

## Endpoints

| Method | Path | Auth |
|--------|------|------|
| POST | `/api/ops/auth/login` | Body: `{ username, password }` (demo, or the shared login unless `OPS_SHARED_LOGIN=off`) |
| POST | `/api/ops/auth/code` | Wallet JWT (verified session), staff only. Body `{ code_challenge }` |
| POST | `/api/ops/auth/exchange` | Body `{ code, code_verifier }` |
| GET | `/api/ops/auth/me` | The session: kind, account, role, roles, permissions |
| GET | `/api/ops/roles?role=` | `ops.admin`. Active grants |
| POST | `/api/ops/users/:userId/roles` | `ops.admin`. Body `{ role, reason }` |
| POST | `/api/ops/users/:userId/roles/:role/revoke` | `ops.admin`. Body `{ reason }`. Never your own ddc_admin, never the last enabled one |
| POST | `/api/ops/users/:userId/disable` | `ops.admin`. Body `{ reason }`. Ends MCP / partner tokens, SSO sessions and staff sessions |
| POST | `/api/ops/users/:userId/enable` | `ops.admin`. Body `{ reason }`. Staff sessions from before stay ended |
| GET | `/api/ops/audit` | `ops.admin`. Query `action` (exact or `role.`-style prefix), `actorUserId`, `targetType`, `targetId`, `from`, `to`, `limit`, `offset` |
| GET | `/api/ops/identity-conflicts` | `ops.support`. Refused sign-ins, with counts by reason |
| POST | `/api/ops/sso/planet-manager` | `ops.admin`. Body `{ email, reason }`. An e-mail that matches two accounts ignoring case: 409 `email_ambiguous` |
| GET | `/api/ops/points` | Ledger totals + paginated member balances. Query: `q`, `min`, `max`, `zeros=0`, `sort`, `order`, `page`, `limit` |
| GET | `/api/ops/points/export` | Same filters, CSV download |
| GET | `/api/ops/users/search?q=` | Ops Bearer token |
| GET | `/api/ops/users/:userId` | The full user view: account, points, referrals, data licence, privacy requests, developer clients, merchant. With `ops.support` also: identity (Web3Auth verifier ids, the network rebind's addresses and evidence), roles (with `grantedBy`), sign-in issues, history, and who acted (`account.disabledBy` / `disabledReason`, `privacyRequests[].resolvedBy`); without it these are `null` |
| POST | `/api/ops/users/:userId/points` | `ops.write`, body: `{ amount, note }` (the note is the audit reason). A deduction is checked against the balance inside the change, so deductions at once never go below zero |
| GET | `/api/ops/campaigns` | List campaign drafts / scheduled / live / ended |
| POST | `/api/ops/campaigns` | Create draft. Slot-filled fields only, no HTML |
| PATCH | `/api/ops/campaigns/:id` | Edit draft or scheduled |
| POST | `/api/ops/campaigns/:id/transition` | Body `{ action: schedule \| live \| end \| reopen }` |

Public Wallet read (no auth): `GET /api/campaigns/active`.

Campaigns are templates, not a CMS: `HOME_CARD`, `CONNECT_BOOST`, `REFERRAL_BOOST`, `REDEEM_SALE`, `FIRST_ACTION_BONUS`. Purpose + legal plain text are required to schedule or go live. Live campaigns can only be ended. Same-window conflicts are rejected (one redeem sale / referral boost / first-action at a time; Connect boosts cannot share a site). CTA allowlist applies to home cards only.
| GET | `/api/ops/overview` | Includes `pendingAttestations` (hash stored, no tx) |
| GET | `/api/ops/payments` | Each `order` includes `attestationStatus`, hash, tx |
| GET | `/api/ops/merchants/:userId` | `orders[]` with attestation status / hash / tx |
| GET | `/api/ops/orders?attestation=pending` | Purchase orders + public attestation fields |
| POST | `/api/ops/orders/:id/attest` | Retry on-chain. Optional body `{ txHash }` |

`amount`: positive adds points, negative deducts. Creates `Point` with `source=OPS_ADJUSTMENT`.

## Audit log

`OpsAuditLog` is append-only and has no foreign keys, so rows outlive the accounts they name. It
covers the ops site, the developer console's staff endpoints and `scripts/opsRoles.js`. The other
maintenance scripts do not write to it yet: `scripts/setPartnerInitiateLoginUri.js` keeps no record,
and `scripts/setCampaignSsoClient.js` writes a campaign event (actor `ops-script`). Sign-in,
role, account, points and Data Planet changes write their own row in the same transaction as the
change (a failed audit write changes nothing). So do the routes that move money or balances, one row
per change and none for a call that changes nothing:

| Route | Action |
|---|---|
| `POST /payments/:id/confirm` | `payment.confirm` (only a `pending` payment is confirmed; a rejected one is 409 `payment_not_pending`); the call that confirms an order's payment also attests the order and writes its `order.attest` row (same actor). A repeat confirm changes nothing and attests nothing |
| `POST /payments/:id/reject` | `payment.reject`. A confirmed payment is refused: 409 `PAYMENT_ALREADY_CONFIRMED` (a reversal will be its own action). Rejecting a rejected payment changes nothing: same notes, no row. Both decisions lock the payment's invoice (when it has one) and change the payment only while it is `pending`, in the transaction that writes the row |
| `POST /merchants/:userId/credit` | `merchant.credit` (in the transaction of the credit). An optional `Idempotency-Key` header (8 to 128 of `A-Z a-z 0-9 . _ : -`, else 400 `INVALID_IDEMPOTENCY_KEY`), kept in `OrganizationTransaction.idempotencyKey` (unique per merchant): a repeat with the same key answers the first credit (`replayed: true`, no new row), also when two arrive at once; the same key with another amount or note is 409 `IDEMPOTENCY_KEY_REUSED` |
| `POST /orders/:id/attest` | `order.attest` (written with the claim, before the chain call; the attestation and the tx hash the call returns are stored on the order afterwards. An attest that sends nothing is written with the stored attestation). One chain send per order at a time: a second attest, or a payment confirm's attestation, while one is being sent is 409 `ATTESTATION_IN_FLIGHT` and sends nothing |
| `POST /disbursements/items/:id/process` | `disbursement.process` (written with the claim, before any transfer; one caller at a time claims a payout, also a submitted one being re-checked and a confirmed one being reconciled). A hold (a stale `processing` payout, or one over a limit) sends nothing and writes a row each time it is applied, also on a payout already held |
| `POST /disbursements/redemptions/:id/disburse` | `disbursement.disburse` (written with the new payout, before any transfer). A redemption whose payout already exists is processed as the route above does, and its rows are `disbursement.disburse` |
| `POST /demands/:id/fulfill` | `demand.fulfill` (purchase, request status and row in one transaction; the buyer's balance is checked inside it, one purchase per buyer at a time) |
| `POST /campaigns/:id/raffle/draw` | `raffle.draw` (draws run one at a time per campaign) |

Every mounted operations write declares its audit boundary; a write with no boundary, or more
than one, prevents the router from loading. Other database writes commit their business changes,
associated events and one generic `ops.write` row in the same transaction. This covers tracked
links; campaign creation, edits, transitions, application decisions and raffle fulfillment;
data-request quotes, decline and assembly; merchant KYC; and privacy-request resolution. An audit
failure rolls back those changes and events. The generic row contains method, route, params and
status, never the request body. Its target is the named record or the newly created record.

Translation and cover uploads wait for the durable generic audit before returning success. A
translation provider call cannot be rolled back; an audit failure returns an error without the
translated result. A cover audit failure removes the uploaded file on ordinary failure and does
not return its URL. File creation and audit are not crash-atomic: a process crash between them may
leave an orphan file. This does not introduce a file-publication registry or change asset serving.
`auditOpsWrites` remains a compatibility fallback outside these annotated router boundaries;
it is not the durability mechanism for the operations mutations above.

The developer console writes `console.staff_unlock` for each staff unlock it hands out and
`console.client_register` for each client a developer or ddc_admin registers while self-serve
registration is closed, or the allowlist does not admit the account (in the same transaction as the
client: no row, no client; `detail.registration` is `closed` or `allowlist`).

## Migration

One migration comes with the ops roles. It only adds, and it starts with `SET lock_timeout = '3s'`:

- `20261017100000_ops_roles_audit` adds three nullable columns to `"User"` and four tables with
  foreign keys to it.

The claim columns (`20261016200000_attestation_claims`) and the merchant credit key
(`20261016210000_merchant_credit_idempotency`) come from `main`, which this migration sorts after.

It needs short table locks. Behind a long-running reader it would queue, and every sign-in would
queue behind it; with the lock timeout, it fails within seconds on a busy table and changes nothing
(it runs as one transaction).

**Order: migrate first, then start the new image.** The new image reads the new columns on every
signed-in request, so it needs them before it serves. The old image ignores them, so it keeps
serving while the migration runs.

- Run `prisma migrate deploy` (for example in a one-off container of the new image) while the old
  image is still serving. If it fails with `55P03
  canceling statement due to lock timeout`, keep the old image running, mark the failed migration
  rolled back and deploy again (a few seconds later, or in a quiet window), then start the new
  image only once it has applied:

  ```bash
  npx prisma migrate resolve --rolled-back 20261017100000_ops_roles_audit   # or the one that failed
  npx prisma migrate deploy
  ```

- Any other failure: keep the old image running, stop and read the error; do not retry blindly.

## Rollout

1. Run the migrations, then start the new image (see "Migration").
2. Grant the first `ddc_admin` accounts, inside the API container:

   ```bash
   node scripts/opsRoles.js grant --email <admin> --role ddc_admin --reason "<why>" --apply
   ```

   Without `--apply` the script only shows what it would do.
3. The shared login keeps working meanwhile, with the same username and password. Sessions from
   before the deploy keep working until they expire, as long as `JWT_SECRET` stays the same. A new
   shared session lasts as long as a personal one (12 h by default), and each shared sign-in is
   audited.
4. Once every operator who uses the shared login today signs in with a personal account, set
   `OPS_SHARED_LOGIN=off` and restart the API. The shared credentials then get the same 401 as a
   wrong password, and open shared sessions end on their next request. Only the exact value `off`
   (any case) turns it off; any other value leaves it on without a warning. So after the restart,
   confirm that the shared username/password get 401 `Invalid username or password` and that an
   open shared session gets 401 `OPS_SESSION_INVALID`. To undo, remove the setting (or set it to
   `on`) and restart.

## Frontend

The private `data-dance-admin` repository owns the management site: `/login`, `/auth/callback`,
`/members`, `/access`, `/audit` and `/sign-in-issues`, alongside the existing operations pages.
`data-dance-frontend` owns the Wallet developer console and its `/developers/#ops-signin` handoff.
The operations site receives only the one-time code and its own operations session, never the
Wallet JWT. The complete upgrade plan and cross-repository acceptance contract live in
[`data-dance-admin/README.md`](https://github.com/DataDanceChain/data-dance-admin/blob/feat/ops-admin-completion/README.md).

The admin build consumes `VITE_API_BASE` and `VITE_WALLET_URL`; its Dockerfile exports both build
arguments before `yarn build`. The actual release builder must supply the matching origins for
each environment. The backend's incorporated `deploy/new-stack/20-env.sh` preserves and validates
`OPS_SHARED_LOGIN`, `OPS_USER_TOKEN_TTL_SEC`, `OPS_ADMIN_URL` and `PLANET_MANAGER_API_HOSTS`;
that source check does not prove deployed values. Before a consuming merge/release, record the
required development/staging/production environment coverage and actual build wiring. No live
environment check, migration, initial administrator grant or production publication is implied
by local tests.
