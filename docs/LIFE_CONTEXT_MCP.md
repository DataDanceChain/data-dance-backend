# Data Dance Connect AI (MCP)

The wallet owns a **Life Capsule**: a portrait that gets sharper as the user shares Amazon, Airbnb, Booking, and Luma traces. They view and manage it in the app. Claude / ChatGPT only see what the share level allows.

This is the Life Capsule idea living inside Data Dance: shopping rhythm, travel places, event themes — not raw receipts, and not ChatGPT history.

## Endpoints

| Path | Auth | Role |
| --- | --- | --- |
| `GET /api/life-context` | user JWT | Status, share level, MCP URL, OAuth AS |
| `PATCH /api/life-context/settings` | user JWT | `privacyLevel`, `customBoundaries` |
| `GET/POST/DELETE /api/life-context/tokens` | user JWT | Manual personal access tokens |
| `POST /mcp` | `Authorization: Bearer ddc_mcp_…` | MCP tools |
| `GET /.well-known/oauth-protected-resource` | public | RFC 9728 |
| `GET /.well-known/oauth-authorization-server` | public | RFC 8414 |
| `POST /oauth/register` | public | RFC 7591 DCR |
| `GET /oauth/authorize` | browser | Authorization code + PKCE, then Wallet consent |
| `POST /oauth/token` | public | Code / refresh exchange |
| `GET /oauth/userinfo` | MCP bearer | Email for workspace-domain checks |
| `POST /api/oauth/consent` | user JWT | Allow / deny after Web3Auth login |

### Tools

- `get_public_profile`
- `get_boundaries`
- `get_life_capsule`
- `search_life_signals`

Each tool advertises `readOnlyHint`, `destructiveHint: false`, and `openWorldHint: false`.

Share levels: **public** (identity + sources) · **transparent** (themes / cities / cadence) · **intimate** (plus example titles). Prices, order IDs, and addresses are stripped in all levels.

## How ChatGPT / Claude connect

Directory and custom connectors start OAuth 2.1 + PKCE against DataDance. Web3Auth stays the human login. The assistant never pastes a secret.

1. Assistant reads protected-resource metadata, then authorization-server metadata.
2. It registers via CIMD (`client_id` is an HTTPS metadata URL) or DCR (`POST /oauth/register`).
3. It opens `/oauth/authorize` with `response_type=code`, `code_challenge_method=S256`, and `resource={PUBLIC_BASE_URL}/mcp`.
4. DataDance redirects to `{APP_PUBLIC_URL}/oauth/consent`. The user signs in with Web3Auth and allows the share.
5. Wallet posts `/api/oauth/consent`. DataDance redirects back with `code` and `iss`.
6. Assistant exchanges the code at `/oauth/token` and calls `POST /mcp` with the issued `ddc_mcp_…` bearer.

Manual tokens in Portrait remain for Developer-mode testing. They are not how the directories connect.

## Environment

- `PUBLIC_BASE_URL` — API origin, also the OAuth issuer (example `https://api.datadance.ai`).
- `APP_PUBLIC_URL` — Wallet origin for the consent page (example `https://app.datadance.ai`). Falls back to `FRONTEND_URL`.

Production `/mcp` must be public HTTPS. Apply migration `20260903090000_add_mcp_oauth`.

## What this is not

- Not a ChatGPT / Claude history crawler.
- Not a dump of the DDC order table. Distill first, then share.
- Web3Auth is not the authorization server for assistants. It only identifies the human on the consent page.
- Life Capsule (`meta-memory`) remains a sister desk for capture → markdown. The MCP contract here is the shared outlet.
