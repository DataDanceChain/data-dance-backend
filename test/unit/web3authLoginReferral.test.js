/**
 * POST /api/auth/web3auth-login — a referral code sent by an EXISTING account.
 *
 * The frontend keeps a `?referralCode=` from an invite link pending for the whole browser session
 * and sends it on every login. A code that cannot be applied to an existing account (already has
 * an inviter, unknown code, own code, unusable campaign) must therefore never fail the login: the
 * session is issued and `invitationStatus` says why the code was not applied — without naming the
 * account's existing inviter. New registrations keep refusing an unusable code, as before.
 *
 * Local JWKS + `jose` as in web3authLogin.test.js; no database (test/helpers/mockPrisma).
 */
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const request = require('supertest');
const jose = require('jose');

const CLIENT_ID = 'test-web3auth-client-id';
const SOCIAL_ISS = 'https://api-auth.web3auth.io';
const VERIFIER = 'web3auth-google-sapphire-devnet';

Object.assign(process.env, {
  NODE_ENV: 'test',
  LOG_LEVEL: 'error',
  JWT_SECRET: 'test-jwt-secret-web3auth-login-referral',
  JWT_EXPIRES_IN: '1h',
  WEB3AUTH_VERIFY_MODE: 'enforce',
  WEB3AUTH_CLIENT_ID: CLIENT_ID,
  WEB3AUTH_LEGACY_VERIFIERS: '',
  WEB3AUTH_ALLOW_LEGACY_FALLBACK: 'false',
  WEB3AUTH_ALLOWED_VERIFIERS: VERIFIER,
});

const { installMockPrisma } = require('../helpers/mockPrisma');

const prisma = installMockPrisma();

// installMockPrisma replaces @prisma/client with an inert stub; findUserByReferralCode needs
// `Prisma.join` from it to build its query.
require.cache[require.resolve('@prisma/client')].exports.Prisma = { join: (values) => ({ values }) };

// findUserByReferralCode reads with $queryRaw (case-insensitive on referralCode /
// legacyReferralCode); answer it from the in-memory user rows.
prisma.$queryRaw = async (_strings, ...params) => {
  const wanted = new Set(
    params.flatMap((p) => (p && Array.isArray(p.values) ? p.values : [])).map((v) => String(v).toLowerCase())
  );
  const hit = prisma.user.rows.find(
    (r) =>
      wanted.has(String(r.referralCode || '').toLowerCase()) ||
      wanted.has(String(r.legacyReferralCode || '').toLowerCase())
  );
  return hit ? [{ id: hit.id, email: hit.email, name: hit.name, referralCode: hit.referralCode }] : [];
};

const identityService = require('../../src/services/web3authIdentity');
const referralService = require('../../src/services/referralService');
const { web3authLogin } = require('../../src/controllers/web3AuthController');

// Reward settlement is referralService's business (and PR #6's); here it only has to be called.
const settled = [];
let settleFails = false;
referralService.processReferral = async (inviteeId, inviterId, code) => {
  if (settleFails) throw new Error('reward write failed');
  settled.push({ inviteeId, inviterId, code });
};

const app = express();
app.use(express.json());
app.post('/api/auth/web3auth-login', web3authLogin);

let server;
let key;

before(async () => {
  const { publicKey, privateKey } = await jose.generateKeyPair('ES256');
  const jwk = await jose.exportJWK(publicKey);
  key = { kid: 'social-kid-1', privateKey, jwk: { ...jwk, kid: 'social-kid-1', alg: 'ES256', use: 'sig' } };
  server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ keys: [key.jwk] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.env.WEB3AUTH_JWKS_URL = `http://127.0.0.1:${server.address().port}/jwks`;
  identityService._internals.resetConfig();
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

function mint(email) {
  return new jose.SignJWT({
    email,
    email_verified: true,
    name: email.split('@')[0],
    aggregateVerifier: VERIFIER,
    verifierId: email,
    wallets: [],
  })
    .setProtectedHeader({ alg: 'ES256', kid: key.kid })
    .setIssuer(SOCIAL_ISS)
    .setAudience(CLIENT_ID)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(key.privateKey);
}

const baseUser = {
  avatar: null,
  xid: null,
  xUsername: null,
  walletAddress: null,
  authType: 'web3auth',
  userType: 'regular',
  isOrganization: false,
  web3authLinkedAt: new Date(),
  disabledAt: null,
  legacyReferralCode: null,
};

const USER = { ...baseUser, id: 'user-1', email: 'ada@example.com', name: 'Ada', referralCode: 'ADA111' };
const INVITER = { ...baseUser, id: 'inviter-1', email: 'ivy@example.com', name: 'Inviter Ivy', referralCode: 'IVY222' };
const OTHER = { ...baseUser, id: 'other-1', email: 'otto@example.com', name: 'Otto', referralCode: 'OTTO33' };

function seed() {
  for (const u of [USER, INVITER, OTHER]) {
    prisma.user.rows.push({ ...u, web3authVerifier: VERIFIER, web3authVerifierId: u.email });
  }
}

const login = async (email, extra = {}) =>
  request(app)
    .post('/api/auth/web3auth-login')
    .send({ idToken: await mint(email), ...extra });

const referralOf = (inviteeId) => prisma.referral.rows.filter((r) => r.inviteeId === inviteeId);

/** The login went through: a session and the account, whatever happened to the code. */
function assertLoggedIn(res, userId) {
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.status, 'success');
  assert.ok(res.body.data.token, 'a session was issued');
  assert.equal(res.body.data.user.id, userId);
}

beforeEach(() => {
  prisma.reset();
  settled.length = 0;
  settleFails = false;
  seed();
});

describe('existing account with a referral code that cannot be applied', () => {
  it('ALREADY_REFERRED: logs in, reports the code as not applied, keeps the old inviter', async () => {
    prisma.referral.rows.push({
      id: 'ref-1',
      inviterId: INVITER.id,
      inviteeId: USER.id,
      code: INVITER.referralCode,
      createdAt: new Date('2026-09-01T00:00:00Z'),
    });

    const res = await login(USER.email, { referralCode: OTHER.referralCode });

    assertLoggedIn(res, USER.id);
    assert.equal(res.body.data.invitationStatus.success, false);
    assert.equal(res.body.data.invitationStatus.code, 'ALREADY_REFERRED');
    assert.equal(typeof res.body.data.invitationStatus.message, 'string');
    assert.deepEqual(
      referralOf(USER.id).map((r) => r.inviterId),
      [INVITER.id],
      'the existing relation is untouched and no second one is made'
    );
    assert.equal(settled.length, 0);
  });

  it('ALREADY_REFERRED never discloses who the existing inviter is', async () => {
    prisma.referral.rows.push({
      id: 'ref-1',
      inviterId: INVITER.id,
      inviteeId: USER.id,
      code: INVITER.referralCode,
      createdAt: new Date(),
    });

    const res = await login(USER.email, { referralCode: OTHER.referralCode });

    const body = JSON.stringify(res.body);
    assert.ok(!body.includes(INVITER.id), 'inviter id leaked');
    assert.ok(!body.includes(INVITER.name), 'inviter name leaked');
    assert.ok(!body.includes(INVITER.referralCode), 'inviter code leaked');
    assert.equal(res.body.data.invitationStatus.data, undefined);
  });

  it('INVALID_CODE: logs in and reports the unknown code', async () => {
    const res = await login(USER.email, { referralCode: 'NOPE99' });

    assertLoggedIn(res, USER.id);
    assert.equal(res.body.data.invitationStatus.success, false);
    assert.equal(res.body.data.invitationStatus.code, 'INVALID_CODE');
    assert.equal(referralOf(USER.id).length, 0);
  });

  it('SELF_REFERRAL_NOT_ALLOWED: logs in and reports that the own code was not applied', async () => {
    const res = await login(USER.email, { referralCode: USER.referralCode.toLowerCase() });

    assertLoggedIn(res, USER.id);
    assert.equal(res.body.data.invitationStatus.success, false);
    assert.equal(res.body.data.invitationStatus.code, 'SELF_REFERRAL_NOT_ALLOWED');
    assert.equal(referralOf(USER.id).length, 0);
  });

  it('unknown campaign: logs in and reports INVALID_CAMPAIGN instead of a 400', async () => {
    const res = await login(USER.email, { referralCode: OTHER.referralCode, referralCampaign: 'no-such-campaign' });

    assertLoggedIn(res, USER.id);
    assert.equal(res.body.data.invitationStatus.success, false);
    assert.equal(res.body.data.invitationStatus.code, 'INVALID_CAMPAIGN');
    assert.equal(referralOf(USER.id).length, 0);
  });

  it('a database error while applying the code does not fail the login either', async () => {
    const original = prisma.referral.findUnique;
    prisma.referral.findUnique = async () => {
      throw new Error('connection reset');
    };
    try {
      const res = await login(USER.email, { referralCode: OTHER.referralCode });
      assertLoggedIn(res, USER.id);
      assert.equal(res.body.data.invitationStatus.success, false);
      assert.equal(res.body.data.invitationStatus.code, 'REFERRAL_VALIDATION_ERROR');
    } finally {
      prisma.referral.findUnique = original;
    }
  });
});

describe('existing account with a code that applies (unchanged)', () => {
  it('binds the inviter, settles the reward and reports success', async () => {
    const res = await login(USER.email, { referralCode: OTHER.referralCode });

    assertLoggedIn(res, USER.id);
    assert.deepEqual(res.body.data.invitationStatus, {
      success: true,
      code: 'REFERRAL_SUCCESSFUL',
      message: 'Successfully used referral code',
    });
    assert.deepEqual(
      referralOf(USER.id).map((r) => r.inviterId),
      [OTHER.id]
    );
    assert.deepEqual(settled, [{ inviteeId: USER.id, inviterId: OTHER.id, code: OTHER.referralCode }]);
  });

  it('a reward failure after the bind still logs in and does not claim the code was not applied', async () => {
    settleFails = true;
    const res = await login(USER.email, { referralCode: OTHER.referralCode });

    assertLoggedIn(res, USER.id);
    assert.equal(res.body.data.invitationStatus.success, true);
    assert.equal(referralOf(USER.id).length, 1);
  });

  it('no code: no invitationStatus at all', async () => {
    const res = await login(USER.email);
    assertLoggedIn(res, USER.id);
    assert.equal(res.body.data.invitationStatus, undefined);
  });
});

describe('new registration (unchanged: an unusable code or campaign still refuses it)', () => {
  it('INVALID_CODE: 404 and no account is created', async () => {
    const res = await login('newbie@example.com', { referralCode: 'NOPE99' });

    assert.equal(res.status, 404);
    assert.equal(res.body.code, 'INVALID_CODE');
    assert.equal(res.body.data, undefined);
    assert.equal(prisma.user.rows.some((r) => r.email === 'newbie@example.com'), false);
  });

  it('unknown campaign: 400 INVALID_CAMPAIGN and no account is created', async () => {
    const res = await login('newbie@example.com', {
      referralCode: OTHER.referralCode,
      referralCampaign: 'no-such-campaign',
    });

    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'INVALID_CAMPAIGN');
    assert.equal(prisma.user.rows.some((r) => r.email === 'newbie@example.com'), false);
  });
});

/**
 * Legacy path (no idToken): reachable in production under `log` with
 * WEB3AUTH_ALLOW_LEGACY_FALLBACK=true, so it must behave the same as the verified path.
 */
describe('legacy path (log + WEB3AUTH_ALLOW_LEGACY_FALLBACK=true)', () => {
  const saved = {};
  before(() => {
    for (const k of ['WEB3AUTH_VERIFY_MODE', 'WEB3AUTH_ALLOW_LEGACY_FALLBACK']) saved[k] = process.env[k];
    process.env.WEB3AUTH_VERIFY_MODE = 'log';
    process.env.WEB3AUTH_ALLOW_LEGACY_FALLBACK = 'true';
    identityService._internals.resetConfig();
  });
  after(() => {
    Object.assign(process.env, saved);
    identityService._internals.resetConfig();
  });

  const WALLET = '0x' + 'ab'.repeat(20);
  const legacyLogin = (email, extra = {}) =>
    request(app)
      .post('/api/auth/web3auth-login')
      .send({ userInfo: { email, name: email.split('@')[0] }, ...extra });

  const alreadyReferred = () =>
    prisma.referral.rows.push({
      id: 'ref-1',
      inviterId: INVITER.id,
      inviteeId: USER.id,
      code: INVITER.referralCode,
      createdAt: new Date(),
    });

  function assertNoInviterDisclosed(res) {
    const body = JSON.stringify(res.body);
    assert.ok(!body.includes(INVITER.id), 'inviter id leaked');
    assert.ok(!body.includes(INVITER.name), 'inviter name leaked');
    assert.ok(!body.includes(INVITER.referralCode), 'inviter code leaked');
  }

  it('existing account, ALREADY_REFERRED: 200 with a session and no inviter data', async () => {
    alreadyReferred();
    const res = await legacyLogin(USER.email, { referralCode: OTHER.referralCode });

    assertLoggedIn(res, USER.id);
    assert.equal(res.body.data.invitationStatus.success, false);
    assert.equal(res.body.data.invitationStatus.code, 'ALREADY_REFERRED');
    assertNoInviterDisclosed(res);
    assert.deepEqual(
      referralOf(USER.id).map((r) => r.inviterId),
      [INVITER.id]
    );
    assert.equal(settled.length, 0);
  });

  it('existing account, INVALID_CODE: 200 with a session', async () => {
    const res = await legacyLogin(USER.email, { referralCode: 'NOPE99' });

    assertLoggedIn(res, USER.id);
    assert.equal(res.body.data.invitationStatus.success, false);
    assert.equal(res.body.data.invitationStatus.code, 'INVALID_CODE');
    assert.equal(referralOf(USER.id).length, 0);
  });

  it('existing already-referred account, INVALID_CAMPAIGN: 200 with a session and no inviter data', async () => {
    alreadyReferred();
    const res = await legacyLogin(USER.email, {
      referralCode: OTHER.referralCode,
      referralCampaign: 'no-such-campaign',
    });

    assertLoggedIn(res, USER.id);
    assert.equal(res.body.data.invitationStatus.success, false);
    assert.equal(res.body.data.invitationStatus.code, 'INVALID_CAMPAIGN');
    assertNoInviterDisclosed(res);
  });

  it('new user, bad campaign: the same 400 body as before and no account', async () => {
    const res = await legacyLogin('newbie@example.com', {
      walletAddress: WALLET,
      referralCode: OTHER.referralCode,
      referralCampaign: 'no-such-campaign',
    });

    assert.equal(res.status, 400);
    assert.deepEqual(Object.keys(res.body).sort(), ['code', 'message', 'status']);
    assert.equal(res.body.status, 'fail');
    assert.equal(res.body.code, 'INVALID_CAMPAIGN');
    assert.equal(prisma.user.rows.some((r) => r.email === 'newbie@example.com'), false);
  });

  it('new user, bad campaign and no wallet: the campaign 400 comes before INCOMPLETE_INFO, as before', async () => {
    const res = await legacyLogin('newbie@example.com', {
      referralCode: OTHER.referralCode,
      referralCampaign: 'no-such-campaign',
    });

    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'INVALID_CAMPAIGN');
    assert.equal(prisma.user.rows.some((r) => r.email === 'newbie@example.com'), false);
  });

  it('new user, invalid code: 404 INVALID_CODE and no account (unchanged)', async () => {
    const res = await legacyLogin('newbie@example.com', { walletAddress: WALLET, referralCode: 'NOPE99' });

    assert.equal(res.status, 404);
    assert.equal(res.body.code, 'INVALID_CODE');
    assert.equal(prisma.user.rows.some((r) => r.email === 'newbie@example.com'), false);
  });
});
