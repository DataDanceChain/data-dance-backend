/**
 * Decision 11 B (Sloan, 2026-09-26): a registered user who binds an inviter later must not close a
 * referral ring (A invites B, then A binds B's code → A→B→A). DB-less (test/helpers/mockPrisma).
 *
 * Covered: the upline walk (2-ring, 3-ring, long chain, a ring already in the data terminates and
 * does not block an unrelated bind, depth cap fails closed), and BOTH late-bind entry points —
 * POST /api/referrals/use-code (409 REFERRAL_CYCLE) and a code sent with a later web3auth login
 * (login still succeeds; invitationStatus reports REFERRAL_CYCLE) — write no row, take the
 * late-bind lock, and still accept unrelated binds.
 * Signup with a code keeps its unchanged path (no lock, no walk). The lock itself is exercised on
 * real Postgres by test/db/referralCycle.dbtest.js.
 */
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const express = require('express');
const request = require('supertest');

Object.assign(process.env, {
  NODE_ENV: 'test',
  LOG_LEVEL: 'error',
  JWT_SECRET: 'test-jwt-secret-referral-cycle',
  JWT_EXPIRES_IN: '1h',
  WEB3AUTH_VERIFY_MODE: 'off',
  WEB3AUTH_CLIENT_ID: 'test-web3auth-client-id',
  WEB3AUTH_LEGACY_VERIFIERS: '',
  WEB3AUTH_ALLOW_LEGACY_FALLBACK: 'false',
  WEB3AUTH_ALLOWED_VERIFIERS: 'web3auth-google-sapphire-devnet',
});

const { installMockPrisma } = require('../helpers/mockPrisma');

const prisma = installMockPrisma();

// The late-bind lock is raw SQL; the mock records it instead of running it.
const lockCalls = () => prisma.rawStatements.map((r) => r.sql);

const src = (rel) => path.join(__dirname, '../../src', rel);
const stub = (rel, exportsValue) => {
  const filename = require.resolve(src(rel));
  require.cache[filename] = { id: filename, filename, loaded: true, exports: exportsValue, children: [] };
};

// Code lookup is a raw case-insensitive query on the real client; resolve it from the mock rows.
const ownerOf = (code) => prisma.user.rows.find((u) => u.referralCode === code) || null;
stub('utils/referralUtils.js', {
  findUserByReferralCode: async (code) => {
    const u = ownerOf(code);
    return u ? { id: u.id, email: u.email, name: u.name, referralCode: u.referralCode } : null;
  },
  validateReferralCode: async (code, userId) => {
    const referrer = ownerOf(code);
    if (!referrer) return { valid: false, error: 'Invalid referral code', errorCode: 'INVALID_CODE' };
    const self = prisma.user.rows.find((u) => u.id === userId || u.email === userId);
    if (self && self.id === referrer.id) {
      return { valid: false, error: 'Cannot use your own referral code', errorCode: 'SELF_REFERRAL_NOT_ALLOWED' };
    }
    return { valid: true, referrerId: referrer.id };
  },
  generateUniqueReferralCode: async () => `NEW${prisma.user.rows.length}`,
  ensureDisplayReferralCode: async () => '',
});
// Rewards stay deferred (no upload yet), so no Point / task rows are needed.
stub('utils/firstValidUpload.js', {
  hasCompletedFirstValidUpload: async () => false,
  getUsersWithValidUploads: async () => new Set(),
});

const referralService = require(src('services/referralService.js'));
const referralController = require(src('controllers/referralController.js'));
const { web3authLogin } = require(src('controllers/web3AuthController.js'));

const app = express();
app.use(express.json());
app.post('/api/referrals/use-code', (req, res, next) => {
  req.user = { id: req.headers['x-test-user'] };
  next();
}, referralController.useReferralCode);
app.post('/api/auth/web3auth-login', web3authLogin);

const LOCK_SQL = "SELECT pg_advisory_xact_lock(hashtext('ddc:referral-late-bind'))";

function addUser(id) {
  prisma.user.rows.push({
    id,
    email: `${id}@example.test`,
    name: id,
    referralCode: `CODE-${id}`,
    walletAddress: null,
    authType: 'web3auth',
    userType: 'regular',
    isOrganization: false,
    disabledAt: null,
  });
}
/** `inviter` invited `invitee` (the Referral row an invite creates). */
function invite(inviter, invitee) {
  prisma.referral.rows.push({
    id: `r-${inviter}-${invitee}`,
    inviterId: inviter,
    inviteeId: invitee,
    code: `CODE-${inviter}`,
    campaignSlug: null,
    createdAt: new Date(),
  });
}
const users = (...ids) => ids.forEach(addUser);
const inviterOf = (id) => prisma.referral.rows.find((r) => r.inviteeId === id)?.inviterId ?? null;

const useCode = (userId, code) =>
  request(app).post('/api/referrals/use-code').set('x-test-user', userId).send({ code });
const loginWithCode = (userId, code) =>
  request(app)
    .post('/api/auth/web3auth-login')
    .send({ userInfo: { email: `${userId}@example.test` }, referralCode: code });

beforeEach(() => {
  prisma.reset();
});

describe('findReferralCycle (upline walk)', () => {
  it('2-ring: A invited B, so B cannot become A\'s inviter', async () => {
    users('a', 'b');
    invite('a', 'b');
    assert.deepEqual(await referralService.findReferralCycle('a', 'b'), { cycle: true, reason: 'cycle', hops: 1 });
  });

  it('3-ring: A→B→C, so C cannot become A\'s inviter', async () => {
    users('a', 'b', 'c');
    invite('a', 'b');
    invite('b', 'c');
    assert.deepEqual(await referralService.findReferralCycle('a', 'c'), { cycle: true, reason: 'cycle', hops: 2 });
  });

  it('long chain: the top of a 60-deep chain cannot bind its bottom; an outsider can', async () => {
    const ids = Array.from({ length: 61 }, (_, i) => `u${i}`);
    users(...ids, 'outsider');
    for (let i = 0; i < 60; i += 1) invite(ids[i], ids[i + 1]);
    assert.deepEqual(await referralService.findReferralCycle('u0', 'u60'), { cycle: true, reason: 'cycle', hops: 60 });
    assert.deepEqual(await referralService.findReferralCycle('outsider', 'u60'), { cycle: false, reason: 'root', hops: 60 });
  });

  it('a ring already in the data terminates the walk and does not block an unrelated bind', async () => {
    users('p', 'q', 'r', 'z');
    invite('p', 'q');
    invite('q', 'r');
    invite('r', 'p'); // p→q→r→p already in the data
    const walk = await referralService.findReferralCycle('z', 'q');
    assert.equal(walk.cycle, false);
    assert.equal(walk.reason, 'existing_ring');
  });

  it('an unrelated bind is allowed', async () => {
    users('a', 'b', 'x', 'y');
    invite('a', 'b');
    invite('x', 'y');
    assert.deepEqual(await referralService.findReferralCycle('b', 'y'), { cycle: false, reason: 'root', hops: 1 });
    assert.deepEqual(await referralService.findReferralCycle('a', 'x'), { cycle: false, reason: 'root', hops: 0 });
  });

  it('fails closed when the upline is deeper than the walk limit', async () => {
    const ids = Array.from({ length: 1002 }, (_, i) => `d${i}`);
    users(...ids, 'late');
    for (let i = 0; i < ids.length - 1; i += 1) invite(ids[i], ids[i + 1]);
    const walk = await referralService.findReferralCycle('late', ids[ids.length - 1]);
    assert.equal(walk.cycle, true);
    assert.equal(walk.reason, 'depth_cap');
  });
});

describe('POST /api/referrals/use-code', () => {
  it('rejects the 2-ring with 409 REFERRAL_CYCLE and writes no row', async () => {
    users('a', 'b');
    invite('a', 'b');
    const res = await useCode('a', 'CODE-b');
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'REFERRAL_CYCLE');
    assert.match(res.body.message, /your own invite network/);
    assert.equal(inviterOf('a'), null);
    assert.equal(prisma.referral.rows.length, 1);
    assert.deepEqual(lockCalls(), [LOCK_SQL]);
  });

  it('rejects the 3-ring', async () => {
    users('a', 'b', 'c');
    invite('a', 'b');
    invite('b', 'c');
    const res = await useCode('a', 'CODE-c');
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'REFERRAL_CYCLE');
    assert.equal(inviterOf('a'), null);
  });

  it('allows an unrelated bind, under the late-bind lock', async () => {
    users('a', 'b', 'x');
    invite('a', 'b');
    const res = await useCode('x', 'CODE-b');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.inviterId, 'b');
    assert.equal(inviterOf('x'), 'b');
    assert.deepEqual(lockCalls(), [LOCK_SQL]);
  });

  it('allows a bind below a ring already in the data (the walk terminates)', async () => {
    users('p', 'q', 'z');
    invite('p', 'q');
    invite('q', 'p');
    const res = await useCode('z', 'CODE-q');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(inviterOf('z'), 'q');
  });

  it('keeps self-referral handling as it was', async () => {
    users('a');
    const res = await useCode('a', 'CODE-a');
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'SELF_REFERRAL_NOT_ALLOWED');
    assert.deepEqual(lockCalls(), []);
  });
});

describe('POST /api/auth/web3auth-login with a code (existing user binds later)', () => {
  it('refuses the 2-ring bind but still logs the user in', async () => {
    users('a', 'b');
    invite('a', 'b');
    const res = await loginWithCode('a', 'CODE-b');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(res.body.data.token, 'login must still issue a token');
    assert.equal(res.body.data.invitationStatus.success, false);
    assert.equal(res.body.data.invitationStatus.code, 'REFERRAL_CYCLE');
    assert.equal(inviterOf('a'), null);
    assert.deepEqual(lockCalls(), [LOCK_SQL]);
  });

  it('refuses the 3-ring bind but still logs the user in', async () => {
    users('a', 'b', 'c');
    invite('a', 'b');
    invite('b', 'c');
    const res = await loginWithCode('a', 'CODE-c');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.invitationStatus.code, 'REFERRAL_CYCLE');
    assert.equal(inviterOf('a'), null);
  });

  it('allows an unrelated bind', async () => {
    users('a', 'b', 'x');
    invite('a', 'b');
    const res = await loginWithCode('x', 'CODE-b');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.invitationStatus.code, 'REFERRAL_SUCCESSFUL');
    assert.equal(inviterOf('x'), 'b');
    assert.deepEqual(lockCalls(), [LOCK_SQL]);
  });

  it('a new user registering with a code keeps the unchanged path (no lock, no walk)', async () => {
    users('a');
    const res = await request(app)
      .post('/api/auth/web3auth-login')
      .send({
        userInfo: { email: 'newbie@example.test', name: 'Newbie' },
        walletAddress: '0x00000000000000000000000000000000000000aa',
        referralCode: 'CODE-a',
      });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const newbie = prisma.user.rows.find((u) => u.email === 'newbie@example.test');
    assert.equal(inviterOf(newbie.id), 'a');
    assert.deepEqual(lockCalls(), []);
  });
});
