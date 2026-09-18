# Ops Admin API

Internal operations panel backed by dedicated credentials (not end-user accounts).

## Environment

```bash
OPS_ADMIN_USERNAME=ops
OPS_ADMIN_PASSWORD=<strong-password>
# optional
OPS_ADMIN_TOKEN_EXPIRES=7d
JWT_SECRET=<existing-jwt-secret>
```

## Endpoints

| Method | Path | Auth |
|--------|------|------|
| POST | `/api/ops/auth/login` | Body: `{ username, password }` |
| GET | `/api/ops/points` | Ledger totals + paginated member balances. Query: `q`, `min`, `max`, `zeros=0`, `sort`, `order`, `page`, `limit` |
| GET | `/api/ops/points/export` | Same filters, CSV download |
| GET | `/api/ops/users/search?q=` | Ops Bearer token |
| GET | `/api/ops/users/:userId` | Ops Bearer token |
| POST | `/api/ops/users/:userId/points` | Ops Bearer token, body: `{ amount, note }` |
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

## Frontend

Route: `/ops/login`, `/ops/dashboard` (see `data-dance-app`).
