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

`amount`: positive adds points, negative deducts. Creates `Point` with `source=OPS_ADJUSTMENT`.

## Frontend

Route: `/ops/login`, `/ops/dashboard` (see `data-dance-app`).
