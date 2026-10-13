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
| POST | `/api/ops/users/:userId/disable` | `ops.admin`. Body `{ reason }`. Ends MCP / partner tokens and SSO sessions |
| POST | `/api/ops/users/:userId/enable` | `ops.admin`. Body `{ reason }` |
| GET | `/api/ops/audit` | `ops.admin`. Query `action` (exact or `role.`-style prefix), `actorUserId`, `targetType`, `targetId`, `from`, `to`, `limit`, `offset` |
| GET | `/api/ops/identity-conflicts` | `ops.support`. Refused sign-ins, with counts by reason |
| POST | `/api/ops/sso/planet-manager` | `ops.admin`. Body `{ email, reason }` |
| GET | `/api/ops/points` | Ledger totals + paginated member balances. Query: `q`, `min`, `max`, `zeros=0`, `sort`, `order`, `page`, `limit` |
| GET | `/api/ops/points/export` | Same filters, CSV download |
| GET | `/api/ops/users/search?q=` | Ops Bearer token |
| GET | `/api/ops/users/:userId` | The full user view: account, identity, roles, points, referrals, data licence, privacy requests, developer clients, merchant; sign-in issues and history with `ops.support` |
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
| `POST /payments/:id/confirm` | `payment.confirm` |
| `POST /payments/:id/reject` | `payment.reject` |
| `POST /merchants/:userId/credit` | `merchant.credit` |
| `POST /orders/:id/attest` | `order.attest` |
| `POST /disbursements/items/:id/process` | `disbursement.process` (written with the claim, before any transfer) |
| `POST /disbursements/redemptions/:id/disburse` | `disbursement.disburse` (written with the new payout, before any transfer) |
| `POST /demands/:id/fulfill` | `demand.fulfill` (purchase, request status and row in one transaction) |
| `POST /campaigns/:id/raffle/draw` | `raffle.draw` |

Every other successful ops write gets one generic `ops.write` row with the method, route, params
and status, never the request body.

## Frontend

Route: `/ops/login`, `/ops/dashboard` (see `data-dance-app`).
