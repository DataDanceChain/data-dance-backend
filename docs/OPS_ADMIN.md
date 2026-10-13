# Ops Admin API

Internal operations panel. Operators sign in with their own DataDance account and act with a role
the server checks on every request. Every change is written to an append-only audit log.

## Sign-in

- **Personal (the normal way).** The ops site sends the operator to the developer console
  (`/developers/#ops-signin`), which holds the DataDance sign-in. After a confirm click the console
  calls `POST /api/ops/auth/code` with the wallet JWT and a PKCE challenge; the server answers a
  60-second, single-use code and the fixed redirect `OPS_ADMIN_URL/auth/callback`. The ops site
  exchanges it with `POST /api/ops/auth/exchange { code, code_verifier }` for an ops session
  (`OPS_USER_TOKEN_TTL_SEC`, default 12 h, no refresh). The account must be enabled and hold
  `ddc_admin` or `operator` when the code is minted, when it is exchanged, and on every request.
- **Which wallet sign-in may mint a code.** A verified session (`ver: 2`, from a Web3Auth ID token)
  signed in within the last 10 minutes, issued after the account's last disable / re-enable.
  Refusals: 403 `VERIFIED_SESSION_REQUIRED`, 403 `RECENT_SIGN_IN_REQUIRED`, 401
  `SESSION_REVOKED`, 403 `ACCOUNT_DISABLED`, 403 `NOT_STAFF`. The console answers the first three
  by signing the visitor out and asking for a new sign-in, then minting again.
- **Demo.** `POST /api/ops/auth/login` with the demo credentials: read-only, unchanged.
- **Shared emergency login.** `POST /api/ops/auth/login` with `OPS_ADMIN_USERNAME` /
  `OPS_ADMIN_PASSWORD`, accepted only while `OPS_SHARED_LOGIN=on` (default off). Audited as actor
  `shared`; it can read and do day-to-day writes, but not manage roles, accounts or payouts.

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
| `ops.support` (sign-in issues, the user view's history) | yes | yes | – | – |
| `ops.payouts` (disbursement process / disburse) | yes | – | – | – |
| `ops.admin` (roles, disable / enable, audit, Data Planet manager) | yes | – | – | – |

`developer` gives no ops access: it lets a partner register SSO clients in the developer console
while self-serve registration is closed. A missing permission answers 403 `FORBIDDEN_ROLE`.

### Sessions

- **Disable and re-enable end staff sessions.** Both set `User.sessionsResetAt`. An ops session,
  or a wallet JWT on `POST /auth/code` and on the console's staff endpoints, issued before it is
  refused (ops: 401 `OPS_SESSION_INVALID`; wallet JWT: 401 `SESSION_REVOKED` /
  `session_revoked`), and a sign-in code minted before it is not exchanged. The person signs in
  again. In the wallet itself an unexpired wallet JWT works again after a re-enable, as before.
- **The developer console's staff endpoints** (`GET /api/developer/sso/admin/clients`,
  `GET /api/developer/sso/admin/staff-unlock`, and `POST /api/developer/sso/clients` while
  self-serve registration is closed) apply the same rule as `POST /auth/code` without the
  10-minute limit: 403 `verified_session_required` for `ver` < 2, 401 `session_revoked` for a
  token from before the last disable / re-enable. `GET /api/developer/sso/me` reports
  `verified_session` so the console can ask for a new sign-in before calling them.

## Environment

```bash
OPS_SHARED_LOGIN=off                    # on enables the shared emergency login
OPS_ADMIN_USERNAME=ops                  # the shared login (only while OPS_SHARED_LOGIN=on)
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
| POST | `/api/ops/auth/login` | Body: `{ username, password }` (demo, or the shared login while it is on) |
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
| GET | `/api/ops/users/:userId` | The full user view: account, roles, points, referrals, data licence, privacy requests, developer clients, merchant. With `ops.support` also: identity (Web3Auth verifier ids, the network rebind's addresses and evidence), sign-in issues, history, and who acted (`account.disabledBy` / `disabledReason`, `roles[].grantedBy`, `privacyRequests[].resolvedBy`); without it these are `null` |
| POST | `/api/ops/users/:userId/points` | `ops.write`, body: `{ amount, note }` (the note is the audit reason) |
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

`OpsAuditLog` is append-only and has no foreign keys, so rows outlive the accounts they name. Sign-in,
role, account, points and Data Planet changes write their own row in the same transaction as the
change (a failed audit write changes nothing). So do the routes that move money or balances, one row
per change and none for a call that changes nothing:

| Route | Action |
|---|---|
| `POST /payments/:id/confirm` | `payment.confirm`; the call that confirms an order's payment also attests the order and writes its `order.attest` row (same actor). A repeat confirm changes nothing and attests nothing |
| `POST /payments/:id/reject` | `payment.reject`. A confirmed payment is refused: 409 `PAYMENT_ALREADY_CONFIRMED` (a reversal will be its own action) |
| `POST /merchants/:userId/credit` | `merchant.credit` |
| `POST /orders/:id/attest` | `order.attest` (written with the stored hash, before the chain call; the tx hash it returns is stored on the order) |
| `POST /disbursements/items/:id/process` | `disbursement.process` (written with the claim, before any transfer; one caller at a time claims a payout, also a submitted one being re-checked) |
| `POST /disbursements/redemptions/:id/disburse` | `disbursement.disburse` (written with the new payout, before any transfer) |
| `POST /demands/:id/fulfill` | `demand.fulfill` (purchase, request status and row in one transaction) |
| `POST /campaigns/:id/raffle/draw` | `raffle.draw` (draws run one at a time per campaign) |

Every other successful ops write gets one generic `ops.write` row with the method, route, params
and status, never the request body. Its target is the record the route names, or for a create
(`POST /links`, `POST /campaigns`, `POST /campaigns/cover`) the record it made.

The developer console writes `console.staff_unlock` for each staff unlock it hands out and
`console.client_register` for each client a developer or ddc_admin registers while self-serve
registration is closed (in the same transaction as the client: no row, no client).

## Migration

`20261017100000_ops_roles_audit` adds three nullable columns to `"User"` and four tables with foreign
keys to it. Both need short locks on `"User"`; behind a long-running reader they would queue, and
every sign-in would queue behind them. The migration therefore sets `lock_timeout = '3s'`: on a
busy table it fails within seconds and changes nothing (it runs as one transaction).

- Run `prisma migrate deploy` as usual. If it fails with `55P03 canceling statement due to lock
  timeout`, mark it rolled back and deploy again (a few seconds later, or in a quiet window):

  ```bash
  npx prisma migrate resolve --rolled-back 20261017100000_ops_roles_audit
  npx prisma migrate deploy
  ```

- Any other failure: stop and read the error; do not retry blindly.

## Frontend

Route: `/ops/login`, `/ops/dashboard` (see `data-dance-app`).
