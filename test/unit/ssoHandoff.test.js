/**
 * Phase 3 App→browser hand-off (contract ddc-sso-tge-v0.1 `/api/sso/*`, acceptance T03/T04/T11/T12).
 *
 * Covers the two endpoints end-to-end over HTTP (supertest + the in-memory Prisma stand-in),
 * the consent endpoints when the credential is an SSO session, and the property the whole
 * design rests on: that session opens NOTHING else.
 */
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const { installMockPrisma } = require('../helpers/mockPrisma');

const prisma = installMockPrisma();
// `protect` builds its own PrismaClient when authMiddleware loads; point it at the same store
// so the JWT path is exercised for real instead of being stubbed out.
require.cache[require.resolve('@prisma/client')].exports = {
  PrismaClient: function PrismaClient() {
    return prisma;
  },
};

const SECRET = 'tge-secret-dev';
const SECRET_HASH = crypto.createHash('sha256').update(SECRET).digest('hex');
const REDIRECT = 'https://tge.example.com/oauth/callback';
const INITIATE = 'https://tge.example.com/login/ddc';
const ISSUER = 'https://api.test.local';
const APP_URL = 'https://app.test.local';
const JWT_SECRET = 'ddc-user-session-secret';
const SSO_SESSION_SECRET = 'ddc-sso-session-secret-different';

Object.assign(process.env, {
  LOG_LEVEL: 'error',
  // Only so this suite may require web3authIdentity (it asserts its own boot config on load)
  // to check the external-wallet constant ssoRoutes mirrors.
  WEB3AUTH_VERIFY_MODE: 'off',
  SSO_ENVIRONMENT: 'test',
  SSO_TGE_ENABLED: 'true',
  SSO_TGE_CLIENT_ID: 'tge-test',
  SSO_TGE_CLIENT_NAME: 'DDC TGE',
  SSO_TGE_CLIENT_SECRET_SHA256: SECRET_HASH,
  SSO_TGE_REDIRECT_URIS: REDIRECT,
  SSO_TGE_INITIATE_LOGIN_URI: INITIATE,
  PUBLIC_BASE_URL: ISSUER,
  APP_PUBLIC_URL: APP_URL,
  JWT_SECRET,
  SSO_SESSION_SECRET,
});
delete process.env.SSO_REQUIRE_VERIFIED_SESSION;
delete process.env.SSO_TICKET_TTL_SEC;
delete process.env.SSO_SESSION_TTL_SEC;

const ssoRoutes = require('../../src/routes/ssoRoutes');
const oauthRoutes = require('../../src/routes/oauthRoutes');
const partnerTgeRoutes = require('../../src/routes/partnerTgeRoutes');
const { protect } = require('../../src/middlewares/authMiddleware');
const { clearRateLimitStore } = require('../../src/middlewares/rateLimitMiddleware');
const { assertPartnerConfig, sha256Hex } = require('../../src/constants/partnerClient');
const { redactObject } = require('../../src/utils/logger');

const { signSsoSession } = ssoRoutes;

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/api/sso', ssoRoutes);
app.use('/partner/tge', partnerTgeRoutes);
// A stand-in for any ordinary first-party endpoint behind the user session.
app.get('/api/profile', protect, (req, res) => res.json({ status: 'success', data: { id: req.user.id } }));
app.use('/', oauthRoutes);

const cUser = {
  id: 'user-1',
  email: 'sloan@example.com',
  isOrganization: false,
  userType: 'regular',
  web3authVerifier: 'web3auth',
  disabledAt: null,
  createdAt: new Date('2025-05-03T09:12:44Z'),
};
const orgUser = {
  id: 'org-1',
  email: 'org@example.com',
  isOrganization: true,
  userType: 'organization',
  disabledAt: null,
};
// External-wallet login: the address lives in the e-mail column (web3authIdentity.accountEmailFor).
const walletUser = {
  id: 'user-wallet',
  email: '0xAbC0000000000000000000000000000000000001',
  isOrganization: false,
  userType: 'regular',
  web3authVerifier: 'external-wallet',
  disabledAt: null,
};

function userJwt(user = cUser, extra = {}) {
  return jwt.sign({ id: user.id, ...extra }, JWT_SECRET, { expiresIn: '1h' });
}

function appTicket(token, body = { client_id: 'tge-test' }) {
  const call = request(app).post('/api/sso/app-ticket');
  if (token) call.set('Authorization', `Bearer ${token}`);
  return call.send(body);
}

function exchange(ticket) {
  return request(app).post('/api/sso/ticket/exchange').send({ ticket });
}

function pkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
}

/** Browser step: start an authorize transaction and return the consent request id. */
async function authorizeRequestId() {
  const res = await request(app).get('/oauth/authorize').query({
    response_type: 'code',
    client_id: 'tge-test',
    redirect_uri: REDIRECT,
    state: 'state-with-enough-entropy-1234',
    code_challenge: pkce().challenge,
    code_challenge_method: 'S256',
  });
  assert.equal(res.status, 302, res.text);
  return new URL(res.headers.location).searchParams.get('request');
}

/** App → system browser: mint a ticket and redeem it. Returns the exchange response. */
async function handoff(user = cUser) {
  const minted = await appTicket(userJwt(user));
  assert.equal(minted.status, 200, minted.text);
  const redeemed = await exchange(minted.body.data.ticket);
  assert.equal(redeemed.status, 200, redeemed.text);
  return redeemed;
}

const savedEnv = {};
const TOGGLES = ['SSO_TGE_ENABLED', 'SSO_REQUIRE_VERIFIED_SESSION', 'SSO_TICKET_TTL_SEC', 'SSO_SESSION_TTL_SEC'];

beforeEach(async () => {
  prisma.reset();
  clearRateLimitStore();
  TOGGLES.forEach((key) => {
    savedEnv[key] = process.env[key];
  });
  await prisma.user.create({ data: cUser });
  await prisma.user.create({ data: orgUser });
  await prisma.user.create({ data: walletUser });
});

afterEach(() => {
  TOGGLES.forEach((key) => {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  });
});

describe('POST /api/sso/app-ticket', () => {
  it('needs a DataDance user JWT: no credential and a forged one are both 401, no ticket minted', async () => {
    const none = await appTicket(null);
    const forged = await appTicket(jwt.sign({ id: cUser.id }, 'not-the-jwt-secret'));
    assert.equal(none.status, 401);
    assert.equal(forged.status, 401);
    assert.equal(none.body.data, undefined);
    assert.equal(prisma.store.ssoTicket.length, 0);
  });

  it('refuses an unknown client_id (400 SSO_CLIENT_UNKNOWN) and a missing one', async () => {
    const unknown = await appTicket(userJwt(), { client_id: 'not-registered' });
    const missing = await appTicket(userJwt(), {});
    assert.equal(unknown.status, 400);
    assert.equal(unknown.body.code, 'SSO_CLIENT_UNKNOWN');
    assert.equal(missing.status, 400);
    assert.equal(missing.body.code, 'SSO_CLIENT_UNKNOWN');
    assert.equal(prisma.store.ssoTicket.length, 0);
  });

  it('refuses a disabled client with 403 CLIENT_DISABLED (kill switch, T13)', async () => {
    process.env.SSO_TGE_ENABLED = 'false';
    const res = await appTicket(userJwt());
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'CLIENT_DISABLED');
    assert.equal(prisma.store.ssoTicket.length, 0);
  });

  it('refuses an organization account with 403 ORG_NOT_ALLOWED', async () => {
    const res = await appTicket(userJwt(orgUser));
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'ORG_NOT_ALLOWED');
    assert.equal(prisma.store.ssoTicket.length, 0);
  });

  it('requires a verified login when SSO_REQUIRE_VERIFIED_SESSION=true (403 VERIFIED_SESSION_REQUIRED)', async () => {
    process.env.SSO_REQUIRE_VERIFIED_SESSION = 'true';
    const legacy = await appTicket(userJwt());
    assert.equal(legacy.status, 403);
    assert.equal(legacy.body.code, 'VERIFIED_SESSION_REQUIRED');
    assert.equal(prisma.store.ssoTicket.length, 0);

    const verified = await appTicket(userJwt(cUser, { ver: 2 }));
    assert.equal(verified.status, 200, verified.text);
  });

  it('mints a fragment-only ticket: 32 bytes of entropy, 60 s, and only its sha256 is stored', async () => {
    const res = await appTicket(userJwt());
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.status, 'success');
    assert.equal(res.headers['cache-control'], 'no-store');

    const { ticket, expires_in: expiresIn, continue_url: continueUrl } = res.body.data;
    assert.match(ticket, /^tk_[A-Za-z0-9_-]{43}$/);
    assert.equal(expiresIn, 60);

    const url = new URL(continueUrl);
    assert.equal(`${url.origin}${url.pathname}`, `${APP_URL}/sso/continue`);
    assert.equal(url.searchParams.get('ticket'), null, 'the ticket must never be a query parameter');
    assert.equal(new URLSearchParams(url.hash.slice(1)).get('ticket'), ticket);

    assert.equal(prisma.store.ssoTicket.length, 1);
    const row = prisma.store.ssoTicket[0];
    assert.equal(row.ticketHash, sha256Hex(ticket));
    assert.equal(JSON.stringify(row).includes(ticket), false, 'the plaintext ticket must not be stored');
    assert.equal(row.userId, cUser.id);
    assert.equal(row.clientId, 'tge-test');
    assert.equal(row.consumedAt ?? null, null, 'a fresh ticket is unconsumed');
    assert.ok(row.expiresAt.getTime() - Date.now() <= 60 * 1000);
  });

  it('rate limits at 5 per user per minute with 429 RATE_LIMITED', async () => {
    for (let i = 0; i < 5; i += 1) {
      assert.equal((await appTicket(userJwt())).status, 200, `call ${i + 1}`);
    }
    const blocked = await appTicket(userJwt());
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.code, 'RATE_LIMITED');
    assert.ok(blocked.headers['retry-after']);
  });
});

describe('POST /api/sso/ticket/exchange', () => {
  it('returns the consent-only session, the client to continue to, and the masked e-mail', async () => {
    const res = await handoff();
    assert.equal(res.body.status, 'success');
    assert.equal(res.headers['cache-control'], 'no-store');
    const data = res.body.data;
    assert.match(data.session_token, /^ddc_sso_/);
    assert.equal(data.expires_in, 300);
    assert.deepEqual(data.client, {
      client_id: 'tge-test',
      name: 'DDC TGE',
      initiate_login_uri: INITIATE,
    });
    assert.deepEqual(data.subject, { email_masked: 's***@example.com' });

    const claims = jwt.verify(data.session_token.replace(/^ddc_sso_/, ''), SSO_SESSION_SECRET, {
      algorithms: ['HS256'],
      audience: 'ddc-sso',
    });
    assert.equal(claims.sub, cUser.id);
    assert.equal(claims.cid, 'tge-test');
    assert.equal(claims.jti, prisma.store.ssoTicket[0].id);
    assert.equal(claims.exp - claims.iat, 300);
  });

  it('is signed with the dedicated secret, never with JWT_SECRET', () => {
    const { token } = signSsoSession({ userId: cUser.id, clientId: 'tge-test', jti: 'ticket-1' });
    assert.throws(() => jwt.verify(token.replace(/^ddc_sso_/, ''), JWT_SECRET));
    assert.ok(jwt.verify(token.replace(/^ddc_sso_/, ''), SSO_SESSION_SECRET));
  });

  it('masks nothing when the account has no e-mail: an external-wallet address is never shown', async () => {
    const res = await handoff(walletUser);
    assert.equal(res.body.data.subject.email_masked, null);
    assert.equal(res.text.includes(walletUser.email), false);
    // ssoRoutes copies the verifier name; if web3authIdentity renames it, this fails here.
    assert.equal(
      require('../../src/services/web3authIdentity').EXTERNAL_WALLET_VERIFIER,
      walletUser.web3authVerifier,
    );
  });

  it('is single use: the second exchange is 400 TICKET_USED', async () => {
    const minted = await appTicket(userJwt());
    const ticket = minted.body.data.ticket;
    const first = await exchange(ticket);
    const second = await exchange(ticket);
    assert.equal(first.status, 200);
    assert.equal(second.status, 400);
    assert.equal(second.body.code, 'TICKET_USED');
    assert.equal(second.body.data, undefined);
  });

  it('refuses an expired ticket with 400 TICKET_EXPIRED and issues no session', async () => {
    const minted = await appTicket(userJwt());
    await prisma.ssoTicket.update({
      where: { ticketHash: sha256Hex(minted.body.data.ticket) },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const res = await exchange(minted.body.data.ticket);
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'TICKET_EXPIRED');
    assert.equal(res.body.data, undefined);
  });

  it('refuses an unknown, tampered or empty ticket with 400 TICKET_INVALID', async () => {
    const minted = await appTicket(userJwt());
    const real = minted.body.data.ticket;
    const tampered = real.slice(0, -1) + (real.endsWith('a') ? 'b' : 'a');

    const random = await exchange(`tk_${'x'.repeat(43)}`);
    const flipped = await exchange(tampered);
    const empty = await exchange('');
    for (const res of [random, flipped, empty]) {
      assert.equal(res.status, 400, res.text);
      assert.equal(res.body.code, 'TICKET_INVALID');
    }
    // A failed exchange must not consume the real ticket.
    assert.equal((await exchange(real)).status, 200);
  });

  it('two simultaneous exchanges of the same ticket produce exactly one session', async () => {
    const minted = await appTicket(userJwt());
    const ticket = minted.body.data.ticket;
    const [a, b] = await Promise.all([exchange(ticket), exchange(ticket)]);
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [200, 400]);
    const loser = a.status === 400 ? a : b;
    assert.equal(loser.body.code, 'TICKET_USED');
  });

  it('refuses to redeem a ticket for a client that was disabled meanwhile (403 CLIENT_DISABLED)', async () => {
    const minted = await appTicket(userJwt());
    process.env.SSO_TGE_ENABLED = 'false';
    const res = await exchange(minted.body.data.ticket);
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'CLIENT_DISABLED');
    assert.equal(res.body.data, undefined);
  });
});

describe('consent with an SSO session', () => {
  it('reads the request summary and approves it, minting the authorization code', async () => {
    const session = (await handoff()).body.data.session_token;
    const requestId = await authorizeRequestId();

    const summary = await request(app)
      .get(`/api/oauth/requests/${requestId}`)
      .set('Authorization', `Bearer ${session}`);
    assert.equal(summary.status, 200, summary.text);
    assert.equal(summary.body.data.kind, 'partner');
    assert.equal(summary.body.data.clientId, 'tge-test');

    const consent = await request(app)
      .post('/api/oauth/consent')
      .set('Authorization', `Bearer ${session}`)
      .send({ requestId, allow: true });
    assert.equal(consent.status, 200, consent.text);
    const redirectTo = new URL(consent.body.data.redirectTo);
    assert.equal(`${redirectTo.origin}${redirectTo.pathname}`, REDIRECT);
    assert.match(redirectTo.searchParams.get('code'), /^ddc_code_/);
    assert.equal(redirectTo.searchParams.get('state'), 'state-with-enough-entropy-1234');
    // The subject is the ticket owner, never whoever opened the browser (T11.4).
    const row = prisma.store.oAuthAuthorization.find((r) => r.id === requestId);
    assert.equal(row.userId, cUser.id);
  });

  it('refuses a session bound to another client, on both consent endpoints, with no code', async () => {
    const requestId = await authorizeRequestId();
    const { token } = signSsoSession({ userId: cUser.id, clientId: 'mcp-demo', jti: 'ticket-x' });

    const summary = await request(app)
      .get(`/api/oauth/requests/${requestId}`)
      .set('Authorization', `Bearer ${token}`);
    assert.equal(summary.status, 401);
    assert.equal(summary.body.code, 'UNAUTHORIZED');

    const consent = await request(app)
      .post('/api/oauth/consent')
      .set('Authorization', `Bearer ${token}`)
      .send({ requestId, allow: true });
    assert.equal(consent.status, 403, consent.text);
    assert.equal(consent.body.data, undefined);
    const row = prisma.store.oAuthAuthorization.find((r) => r.id === requestId);
    assert.equal(row.codeHash, undefined);
    assert.equal(row.consumedAt, undefined);
  });

  it('answers 401 SSO_SESSION_EXPIRED for an expired session, on both consent endpoints', async () => {
    const requestId = await authorizeRequestId();
    const { token } = signSsoSession(
      { userId: cUser.id, clientId: 'tge-test', jti: 'ticket-y' },
      { now: Date.now() - 10 * 60 * 1000 },
    );

    const summary = await request(app)
      .get(`/api/oauth/requests/${requestId}`)
      .set('Authorization', `Bearer ${token}`);
    const consent = await request(app)
      .post('/api/oauth/consent')
      .set('Authorization', `Bearer ${token}`)
      .send({ requestId, allow: true });

    for (const res of [summary, consent]) {
      assert.equal(res.status, 401, res.text);
      assert.equal(res.body.code, 'SSO_SESSION_EXPIRED');
    }
  });

  it('answers 401 SSO_SESSION_EXPIRED when the session is forged or its subject is gone', async () => {
    const requestId = await authorizeRequestId();
    const forged = `ddc_sso_${jwt.sign({ sub: cUser.id, aud: 'ddc-sso', cid: 'tge-test' }, 'wrong-secret')}`;
    const orphan = signSsoSession({ userId: 'deleted-user', clientId: 'tge-test', jti: 'ticket-z' }).token;

    for (const token of [forged, orphan]) {
      const res = await request(app)
        .post('/api/oauth/consent')
        .set('Authorization', `Bearer ${token}`)
        .send({ requestId, allow: true });
      assert.equal(res.status, 401, res.text);
      assert.equal(res.body.code, 'SSO_SESSION_EXPIRED');
    }
  });

  it('reads the request summary anonymously, but refuses a credential it cannot use (T12.5)', async () => {
    const requestId = await authorizeRequestId();
    const anonymous = await request(app).get(`/api/oauth/requests/${requestId}`);
    const withJwt = await request(app)
      .get(`/api/oauth/requests/${requestId}`)
      .set('Authorization', `Bearer ${userJwt()}`);
    const withPartnerToken = await request(app)
      .get(`/api/oauth/requests/${requestId}`)
      .set('Authorization', `Bearer ddc_tge_${crypto.randomBytes(24).toString('base64url')}`);

    assert.equal(anonymous.status, 200, anonymous.text);
    assert.equal(withJwt.status, 200, withJwt.text);
    assert.equal(withPartnerToken.status, 401, withPartnerToken.text);
  });

  it('leaves the user-JWT consent path untouched (MCP and web consent still work)', async () => {
    const requestId = await authorizeRequestId();
    const consent = await request(app)
      .post('/api/oauth/consent')
      .set('Authorization', `Bearer ${userJwt()}`)
      .send({ requestId, allow: true });
    assert.equal(consent.status, 200, consent.text);
    assert.match(new URL(consent.body.data.redirectTo).searchParams.get('code'), /^ddc_code_/);

    const anonymous = await request(app).post('/api/oauth/consent').send({ requestId, allow: true });
    assert.equal(anonymous.status, 401);
  });

  it('still lets a denial travel back as access_denied with no code', async () => {
    const session = (await handoff()).body.data.session_token;
    const requestId = await authorizeRequestId();
    const consent = await request(app)
      .post('/api/oauth/consent')
      .set('Authorization', `Bearer ${session}`)
      .send({ requestId, allow: false });
    assert.equal(consent.status, 200, consent.text);
    const redirectTo = new URL(consent.body.data.redirectTo);
    assert.equal(redirectTo.searchParams.get('error'), 'access_denied');
    assert.equal(redirectTo.searchParams.get('code'), null);
  });
});

describe('the SSO session is consent-only (T12)', () => {
  it('is rejected by /partner/tge/me, /api/sso/app-ticket and any protect-guarded route', async () => {
    const session = (await handoff()).body.data.session_token;

    const me = await request(app).get('/partner/tge/me').set('Authorization', `Bearer ${session}`);
    const ticket = await appTicket(session);
    const profile = await request(app).get('/api/profile').set('Authorization', `Bearer ${session}`);

    assert.equal(me.status, 401, me.text);
    assert.equal(ticket.status, 401, ticket.text);
    assert.equal(ticket.body.data, undefined);
    assert.equal(profile.status, 401, profile.text);
    // The same user JWT does work on that route: it is the credential that is scoped, not the user.
    assert.equal((await request(app).get('/api/profile').set('Authorization', `Bearer ${userJwt()}`)).status, 200);
  });

  it('cannot be replayed as a user JWT even with the prefix stripped', async () => {
    const session = (await handoff()).body.data.session_token;
    const bare = session.replace(/^ddc_sso_/, '');
    assert.equal((await request(app).get('/api/profile').set('Authorization', `Bearer ${bare}`)).status, 401);
    assert.equal((await appTicket(bare)).status, 401);
  });
});

describe('boot configuration', () => {
  const base = {
    SSO_ENVIRONMENT: 'test',
    SSO_TGE_ENABLED: 'true',
    SSO_TGE_CLIENT_ID: 'tge-test',
    SSO_TGE_CLIENT_SECRET_SHA256: SECRET_HASH,
    SSO_TGE_REDIRECT_URIS: REDIRECT,
    JWT_SECRET,
  };

  it('refuses to boot when the SSO session secret is missing or equals JWT_SECRET', () => {
    assert.throws(() => assertPartnerConfig({ ...base }), /SSO_SESSION_SECRET is required/);
    assert.throws(
      () => assertPartnerConfig({ ...base, SSO_SESSION_SECRET: JWT_SECRET }),
      /SSO_SESSION_SECRET must differ from JWT_SECRET/,
    );
    const summary = assertPartnerConfig({ ...base, SSO_SESSION_SECRET });
    assert.equal(summary.enabled, true);
    assert.equal(JSON.stringify(summary).includes(SSO_SESSION_SECRET), false);
  });

  it('does not require the SSO secret while the partner client is off', () => {
    assert.equal(assertPartnerConfig({ SSO_TGE_ENABLED: 'false' }).enabled, false);
  });
});

describe('scripts/cleanupSso', () => {
  it('drops consumed and expired tickets plus abandoned authorize requests, and counts them first', async () => {
    const { cleanupSso } = require('../../scripts/cleanupSso');
    const now = new Date('2026-09-22T12:00:00Z');
    const past = new Date(now.getTime() - 5 * 60 * 1000);
    const old = new Date(now.getTime() - 48 * 60 * 60 * 1000);
    const live = new Date(now.getTime() + 60 * 1000);

    await prisma.ssoTicket.create({ data: { id: 't-live', ticketHash: 'a', userId: cUser.id, clientId: 'tge-test', expiresAt: live, consumedAt: null } });
    await prisma.ssoTicket.create({ data: { id: 't-used', ticketHash: 'b', userId: cUser.id, clientId: 'tge-test', expiresAt: live, consumedAt: past } });
    await prisma.ssoTicket.create({ data: { id: 't-expired', ticketHash: 'c', userId: cUser.id, clientId: 'tge-test', expiresAt: past, consumedAt: null } });
    await prisma.oAuthAuthorization.create({ data: { id: 'a-abandoned', clientId: 'tge-test', consumedAt: null, createdAt: old } });
    await prisma.oAuthAuthorization.create({ data: { id: 'a-fresh', clientId: 'tge-test', consumedAt: null, createdAt: now } });
    await prisma.oAuthAuthorization.create({ data: { id: 'a-used', clientId: 'tge-test', consumedAt: past, createdAt: old } });

    const dry = await cleanupSso({ dryRun: true, now });
    assert.deepEqual({ tickets: dry.tickets, authorizations: dry.authorizations }, { tickets: 2, authorizations: 1 });
    assert.equal(prisma.store.ssoTicket.length, 3, 'a dry run deletes nothing');

    const done = await cleanupSso({ now });
    assert.deepEqual({ tickets: done.tickets, authorizations: done.authorizations }, { tickets: 2, authorizations: 1 });
    assert.deepEqual(prisma.store.ssoTicket.map((row) => row.id), ['t-live']);
    assert.deepEqual(prisma.store.oAuthAuthorization.map((row) => row.id), ['a-fresh', 'a-used']);
  });
});

describe('logging', () => {
  it('masks ticket and session_token wherever they appear', () => {
    const ticket = `tk_${crypto.randomBytes(32).toString('base64url')}`;
    const sessionToken = `ddc_sso_${crypto.randomBytes(48).toString('base64url')}`;
    const out = redactObject({
      ticket,
      session_token: sessionToken,
      sessionToken,
      url: `/sso/continue?ticket=${ticket}`,
    });
    const serialized = JSON.stringify(out);
    assert.equal(serialized.includes(ticket), false);
    assert.equal(serialized.includes(sessionToken), false);
  });
});
