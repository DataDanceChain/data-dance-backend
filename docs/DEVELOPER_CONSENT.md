# Developer consent controls

This is the backend contract for the unified developer console and operations panel. It builds
on `UserRoleGrant`/`OpsAuditLog` and the client-bound app-ticket flow. It is local reviewed source,
not a production release receipt. Production was separately set to confirmation-first on October
20; this feature introduces no environment variable or automatic production grant.

## Qualification and application choice

`trusted_developer` grants exactly the named capability `sso.skip_confirmation`. It also permits
client registration while public registration is closed, from a verified current Wallet session.
It grants no `ops.*` permission, campaign editing, partner data scopes or administrator access.
`ddc_admin` alone does not grant this capability: admins manage qualification using the existing
reasoned role-grant/revoke endpoints. Ordinary and trusted clients retain their existing kind and
scopes. In particular an ordinary developer retains only identity/status/email/wallet scopes.

An owned `SsoDeveloperClient` stores `skipConfirmationEnabled` (default false) and
`skipConfirmationOwnerUserId` (nullable). The latter binds the saved opt-in to the owner who made
it. Both new and legacy clients start off. **The legacy deployment value `app` alone no longer
opts any client in after this feature ships**, including first-party and environment clients.

Automatic consent requires all of:

1. An active client with a persisted owned overlay, whose current active owner holds the trusted role.
2. That owner's explicit saved opt-in, bound to the same current owner, and a valid handoff URI.
3. Both `SSO_TGE_ENABLED=true` and the existing `SSO_TGE_AUTO_APPROVE` app flag. `off` is the
   emergency deny; legacy `app,web` remains accepted syntax but effective web auto stays false.
4. The existing authenticated, client-bound `sso_ticket` credential. A standalone user JWT never
   skips confirmation. Persisted `prompt=login` or `select_account` always prevents auto approval.

Account switching, browser binding, scope validation, state, PKCE and code single-use remain in
force. A scoped manual Allow cannot satisfy `select_account`; the selected ordinary JWT can.
Changing this setting does not clear an existing partner session or log out the primary App.

## Owner API

All endpoints require the existing DataDance Wallet Bearer JWT and return `Cache-Control: no-store`.
`GET /api/developer/sso/me` adds `capabilities` (currently `[]` or `["sso.skip_confirmation"]`).
Its `roles`, `admin`, `can_register` and `verified_session` retain their existing meanings.

Each client in the owned list, console-admin list and operations SSO list has the same derived
`consent` object, without secrets:

```json
{
  "eligible": true,
  "enabled": false,
  "effective": false,
  "reason": "not_enabled",
  "platform_enabled": true,
  "initiate_login_uri": "https://client.example/login/ddc"
}
```

- `eligible`: the current owner is active and trusted, independent of global mode or app opt-in.
- `enabled`: the saved setting belongs to the current owner. An unexpected owner mismatch reads off.
- `effective`: every qualification/client/platform/choice/URI gate currently permits automatic
  confirmation for a valid DDC handoff; the particular authorization still enforces its credential
  and explicit prompt. It does not mean a standalone login will skip confirmation.
- `platform_enabled`: both the SSO handoff and global app auto flag are enabled.
- `initiate_login_uri`: valid registered URI or null; for managed clients it comes from runtime config.

Reason precedence is `owner_disabled`, `qualification_required`, `client_disabled`,
`platform_disabled`, `not_enabled`, `handoff_not_configured`, then `enabled`. A platform deny is
explained even for an eligible app whose saved setting is off. Labels are UI concerns; reason
codes are stable machine values.

`POST /api/developer/sso/clients/consent`:

```json
{
  "client_id": "sso_example",
  "skip_confirmation_enabled": true,
  "initiate_login_uri": "https://client.example/login/ddc",
  "reason": "Enable reviewed DataDance launch"
}
```

The boolean and a trimmed 3–200-character reason are required. `initiate_login_uri` is optional:
omission preserves it, null clears it, otherwise the existing absolute-HTTPS/no credentials,
fragment, whitespace or backslash rule applies (maximum 512 characters). A successful response
is the updated owned-client object, including `consent`.

| Outcome | Status / code | Mutation |
| --- | --- | --- |
| Unknown or another owner's client | 404 `not_found` | None |
| Invalid boolean/reason/URI | 400 `invalid_request` | None |
| Enable or register non-null handoff URI without qualification | 403 `qualification_required` | None, including URI |
| Enable/URI registration without verified login | 403 `verified_session_required` | None |
| Enable/URI registration with login older than disable/re-enable | 401 `session_revoked` | None |
| Managed client supplied `initiate_login_uri` (including null) | 409 `managed_client` | None |
| Valid off from an ordinary authenticated owner | 200 | Saved off; may clear URI |
| Valid on while platform is suspended | 200 | Saved on; effective false / platform_disabled |

The settings service requires verified claims for privileged true/non-null-URI writes and checks
the current owner's session-reset timestamp again under its transaction lock. A route pre-check
alone cannot authorize a request that waited across disable/re-enable. False remains a normal
authenticated owner control, not a new verified-login requirement for the whole console.

Environment-managed clients require an existing owned persisted row (the existing manager
assignment creates it). This row is a **consent-only overlay**: configured secret, redirects,
enabled flag and initiate URI continue to win. Only the dedicated consent endpoint may edit its
preference; update/secret endpoints and URI edits retain 409 managed protections. An unowned
environment client has no opt-in and cannot be claimed through this API.

## Handoff and campaign boundary

An enabled ordinary client with an active trusted owner may register a valid initiate URI and
use the existing app-ticket/exchange flow without changing kind or scopes. Handoff works in
manual-confirmation mode too: saved skip=false or global auto=off does not prevent that launch.
The global `SSO_TGE_ENABLED=false` still disables handoff.

Only campaign/card validation uses the narrow `listHandoffClientIds` resolver: it retains existing
partner eligibility and additionally accepts qualified enabled ordinary clients with valid URI,
independent of skip preference/global auto mode. `listFirstPartyClientIds` stays partner-only.
Admins still control campaign writes/publication; qualification gives developers no ops access.

## Atomicity and reset lifecycle

Preference/URI changes and `console.consent_settings` audit commit together. Audit includes the
reason, actor/client identifiers, old/new booleans and whether the URI changed; no URI, request
body, token, code or secret is copied to detail. Audit failure rolls everything back.

The shared transaction advisory lock `ddc:sso-consent-policy` is taken before affected row/admin
locks. `lock_timeout=3s` bounds the wait; a timeout fails closed without modifying the request or
setting. Only short database work occurs under it, never a provider/network call. Final auto
code mint reloads current owner, qualification, saved choice, client state and platform policy
under this lock, in the same transaction as the conditional single-use authorization update.

Supported role grant/revoke, owner disable/enable, client disable and manager reassignment use
the same lock. Revoke, disable, ownership change and a new trusted grant reset saved preferences;
regrant/re-enable never silently revive them. Automatic reset belongs to the reasoned role/account
or manager audit transaction; client disable writes a consent audit if it clears an enabled choice.
An already-pending authorization cannot use an earlier policy read after the change commits.

Direct SQL changes are outside the supported audited control plane. Owner binding still makes an
unexpected SQL ownership change fail closed; operators must use the supported reasoned services
to transfer ownership, revoke qualification or disable accounts. There is no database trigger,
second role store, outbox or blanket access-token revocation for this preference.

## Migration, release and evidence

Prerequisites are the role/audit migration from admin PR55 and persisted-prompt policy from SSO
PR76. Apply `20261020060000_developer_consent_controls` and generate the matching Prisma client
before this backend image. It adds default-false preference/binding columns and extends the role
CHECK only with `trusted_developer`. Existing rows stay false/null. Three-second migration lock
timeout fails fast; rollback is the prior image leaving additive fields unused. No grants are seeded.

The old `ssoDeveloperLive.ensureTable` compatibility bootstrap is not this migration and must not
be used as a substitute. New admin projections require the migrated columns, including on a legacy
managed-client deployment. Release the matching console/admin interfaces through the normal
reviewed release; this source change performs no production configuration, image deployment or
real qualification grant. Keep the production emergency switch off until separately authorized.

Verification: `test/unit/developerConsent.test.js`, affected developer/role/SSO suites and campaign
validation; `test/db/developerConsent.dbtest.js` on a newly created loopback disposable Postgres
proves migration defaults/CHECK, real handoff with unchanged scopes, manual overrides, managed
overlay, actual audit-insert rollback, revoke-before-final-mint ordering, session-reset race and SQL
55P03 lock timeout. `planetEntryPolicy.dbtest.js` retains persisted prompt/PKCE/browser checks.
These synthetic proofs do not represent real partner UI, account onboarding or production acceptance.
