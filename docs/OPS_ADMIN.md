# Ops Admin API

Internal operations panel backed by dedicated credentials (not end-user accounts).

## Environment

```bash
OPS_ADMIN_USERNAME=ops
OPS_ADMIN_PASSWORD=<strong-password>
# optional
OPS_ADMIN_TOKEN_EXPIRES=8h
JWT_SECRET=<existing-jwt-secret>
```

## Endpoints

| Method | Path | Auth |
|--------|------|------|
| POST | `/api/ops/auth/login` | Body: `{ username, password }` |
| GET | `/api/ops/users/search?q=` | Ops Bearer token |
| GET | `/api/ops/users/:userId` | Ops Bearer token |
| POST | `/api/ops/users/:userId/points` | Ops Bearer token, body: `{ amount, note }` |
| GET | `/api/ops/overview` | Includes `pendingAttestations` (hash stored, no tx) |
| GET | `/api/ops/payments` | Each `order` includes `attestationStatus`, hash, tx |
| GET | `/api/ops/merchants/:userId` | `orders[]` with attestation status / hash / tx |
| GET | `/api/ops/orders?attestation=pending` | Purchase orders + public attestation fields |
| POST | `/api/ops/orders/:id/attest` | Retry on-chain. Optional body `{ txHash }` |

`amount`: positive adds points, negative deducts. Creates `Point` with `source=OPS_ADJUSTMENT`.

## Frontend

Route: `/ops/login`, `/ops/dashboard` (see `data-dance-app`).
