/**
 * Decision 36 (Sloan, 2026-09-28): invite codes are SHOWN as "DDC-XXXXXX" but STORED bare. The
 * backend is the one place that adds the prefix (every response carrying a user's code) and
 * strips it (every code that comes in). No database: test/helpers/mockPrisma, plus a tiny
 * `$queryRaw` for findUserByReferralCode's case-insensitive lookup.
 */
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const bcrypt = require('bcryptjs');

Object.assign(process.env, {
  NODE_ENV: 'test',
  LOG_LEVEL: 'error',
  JWT_SECRET: 'test-jwt-secret-referral-display',
  JWT_EXPIRES_IN: '1h',
  WEB3AUTH_VERIFY_MODE: 'off',
  WEB3AUTH_CLIENT_ID: 'test-web3auth-client-id',
  WEB3AUTH_LEGACY_VERIFIERS: '',
  WEB3AUTH_ALLOW_LEGACY_FALLBACK: 'false',
});

const { installMockPrisma } = require('../helpers/mockPrisma');

const prisma = installMockPrisma();

// findUserByReferralCode uses `Prisma.join` + a tagged `$queryRaw`; emulate just that query:
// LOWER("referralCode") IN (...) OR LOWER("legacyReferralCode") IN (...).
const prismaClientPath = require.resolve('@prisma/client');
require.cache[prismaClientPath].exports.Prisma = { join: (values) => ({ joined: values }) };
const rawQueries = [];
prisma.$queryRaw = async (strings, ...params) => {
  const wanted = params.find((p) => p && Array.isArray(p.joined)).joined;
  rawQueries.push(wanted);
  const hit = prisma.user.rows.find(
    (u) => wanted.includes(String(u.referralCode || '').toLowerCase())
      || wanted.includes(String(u.legacyReferralCode || '').toLowerCase())
  );
  return hit ? [{ id: hit.id, email: hit.email, name: hit.name, referralCode: hit.referralCode }] : [];
};
// Raw statements (e.g. a late-bind advisory lock) are recorded, never run.
const rawStatements = [];
prisma.$executeRaw = async (strings, ...params) => {
  rawStatements.push({ sql: strings.join('?'), params });
  return 0;
};
// Models the reward / campaign paths touch; nobody here has uploads or campaigns.
prisma.crawlerData = { count: async () => 0, findMany: async () => [], groupBy: async () => [] };
prisma.point = { count: async () => 0, aggregate: async () => ({ _sum: { amount: 0 } }) };
prisma.campaign = { findMany: async () => [] };

const {
  formatReferralCodeForDisplay,
  normalizeReferralCodeInput,
  bareDisplayReferralCode,
  referralCodeLookupValues,
  findUserByReferralCode,
  withDisplayReferralCode,
  validateReferralCode,
} = require('../../src/utils/referralUtils');
const referralService = require('../../src/services/referralService');
const userController = require('../../src/controllers/userController');
const referralController = require('../../src/controllers/referralController');
const authController = require('../../src/controllers/authController');
const { web3authLogin } = require('../../src/controllers/web3AuthController');
const opsAdmin = require('../../src/controllers/opsAdminController');
const { referralSummary } = require('../../src/routes/partnerTgeRoutes');

const INVITER = {
  id: 'inviter-1',
  email: 'inviter@example.com',
  name: 'Inviter',
  referralCode: 'AB23CD',
  legacyReferralCode: 'DD12345678',
  userType: 'regular',
  authType: 'web3auth',
  isOrganization: false,
  totalPoints: 0,
  createdAt: new Date('2025-01-01T00:00:00Z'),
};
const LEGACY_USER = {
  id: 'legacy-1',
  email: 'legacy@example.com',
  name: 'Legacy',
  referralCode: 'DD87654321',
  userType: 'regular',
  authType: 'web3auth',
  isOrganization: false,
  totalPoints: 0,
  createdAt: new Date('2025-01-01T00:00:00Z'),
};

/** Every string written to User.referralCode or Referral.code must be prefix-free. */
function assertNoPrefixStored() {
  for (const u of prisma.user.rows) {
    assert.ok(!/^DDC[-\s]/i.test(String(u.referralCode || '')), `User.referralCode stored with prefix: ${u.referralCode}`);
  }
  for (const { params } of rawStatements) {
    for (const p of params) assert.ok(!/^DDC[-\s]/i.test(String(p)), `raw statement wrote a prefixed value: ${p}`);
  }
  for (const r of prisma.referral.rows) {
    assert.ok(!/^DDC[-\s]/i.test(String(r.code || '')), `Referral.code stored with prefix: ${r.code}`);
  }
}

function app() {
  const a = express();
  a.use(express.json());
  a.use((req, res, next) => {
    const id = req.get('x-user-id');
    if (id) req.user = prisma.user.rows.find((u) => u.id === id);
    next();
  });
  a.get('/api/users/referral-code', userController.getReferralCode);
  a.put('/api/users/me', userController.updateMe);
  a.get('/api/referrals/status', async (req, res) => {
    res.json({ status: 'success', data: await referralService.getReferralStatus(req.user.id) });
  });
  a.post('/api/referrals/use-code', referralController.useReferralCode);
  a.get('/api/referrals/campaign/mothers-day-2026/stats', referralController.getMothersDay2026Stats);
  a.post('/api/auth/register', authController.register);
  a.post('/api/auth/login', authController.login);
  a.post('/api/auth/web3auth-login', web3authLogin);
  a.get('/api/ops/users/search', opsAdmin.searchUsers);
  a.get('/api/ops/points/export', opsAdmin.exportPoints);
  return a;
}

// mockPrisma has no Referral relations and no OR; add just what these endpoints read.
prisma.referral.findUnique = wrapInclude(prisma.referral.findUnique);
const plainUserFindMany = prisma.user.findMany;
prisma.user.findMany = async (args = {}) => {
  const where = args.where || {};
  if (!where.OR) return plainUserFindMany(args);
  const { OR, ...rest } = where;
  const base = await plainUserFindMany({ ...args, where: rest });
  return base.filter((u) => OR.some((clause) => Object.entries(clause).every(([field, cond]) => (
    cond && typeof cond === 'object' && 'contains' in cond
      ? String(u[field] || '').toLowerCase().includes(String(cond.contains).toLowerCase())
      : u[field] === cond
  ))));
};

// Reward settlement is out of scope here; keep it inert.
referralService.processReferral = async () => ({ deferred: true });

beforeEach(() => {
  prisma.reset();
  rawQueries.length = 0;
  rawStatements.length = 0;
  prisma.user.rows.push({ ...INVITER }, { ...LEGACY_USER });
});

describe('format / normalise helpers', () => {
  it('formats a 6-character display code with the DDC- prefix', () => {
    assert.equal(formatReferralCodeForDisplay('AB23CD'), 'DDC-AB23CD');
  });

  it('leaves legacy and unknown values unchanged, and null as null', () => {
    assert.equal(formatReferralCodeForDisplay('DD12345678'), 'DD12345678');
    assert.equal(formatReferralCodeForDisplay('DDC1234567'), 'DDC1234567', 'a legacy DD code that happens to start with DDC');
    assert.equal(formatReferralCodeForDisplay('legacy-referral-code-0001'), 'legacy-referral-code-0001');
    assert.equal(formatReferralCodeForDisplay(''), '');
    assert.equal(formatReferralCodeForDisplay(null), null);
    assert.equal(formatReferralCodeForDisplay(undefined), null);
  });

  it('is idempotent: an already-formatted value is not prefixed twice', () => {
    assert.equal(formatReferralCodeForDisplay('DDC-AB23CD'), 'DDC-AB23CD');
  });

  it('normalises every spelling of a display code to the bare stored form', () => {
    for (const input of ['AB23CD', 'ab23cd', 'DDC-AB23CD', 'ddc-ab23cd', 'ddc ab23cd', 'DDC-AB2-3CD', ' DDC AB 23 CD ', 'DDCAB23CD', 'AB-23-CD']) {
      assert.equal(normalizeReferralCodeInput(input), 'AB23CD', input);
      assert.equal(bareDisplayReferralCode(input), 'AB23CD', input);
    }
  });

  it('never strips DDC from a legacy code and leaves non-display input only trimmed', () => {
    assert.equal(normalizeReferralCodeInput('DDC1234567'), 'DDC1234567');
    assert.equal(normalizeReferralCodeInput(' DD12345678 '), 'DD12345678');
    assert.equal(normalizeReferralCodeInput('DD-12345678'), 'DD-12345678');
    assert.equal(normalizeReferralCodeInput('DDC-AB0123'), 'DDC-AB0123', '0 is not in the alphabet: not a display code');
    assert.equal(bareDisplayReferralCode('DDC1234567'), null);
    assert.equal(normalizeReferralCodeInput(''), null);
    assert.equal(normalizeReferralCodeInput('   '), null);
    assert.equal(normalizeReferralCodeInput(null), null);
  });

  it('lookup values for a prefixed code include the bare stored code', () => {
    for (const input of ['DDC-AB23CD', 'ddc ab23cd', 'DDC-AB2-3CD']) {
      const values = referralCodeLookupValues(input);
      assert.ok(values.includes('AB23CD'), `${input} → ${values}`);
    }
    assert.ok(referralCodeLookupValues('DD-12345678').includes('DD12345678'), 'legacy lookup unchanged');
  });

  it('withDisplayReferralCode formats only the referralCode field and copes with null', () => {
    const row = { id: 'x', referralCode: 'AB23CD', legacyReferralCode: 'DD12345678' };
    assert.deepEqual(withDisplayReferralCode(row), { id: 'x', referralCode: 'DDC-AB23CD', legacyReferralCode: 'DD12345678' });
    assert.equal(row.referralCode, 'AB23CD', 'the source row is not mutated');
    assert.equal(withDisplayReferralCode(null), null);
    assert.deepEqual(withDisplayReferralCode({ id: 'y' }), { id: 'y' });
  });
});

describe('lookups accept the code with and without the prefix', () => {
  for (const input of ['AB23CD', 'ab23cd', 'DDC-AB23CD', 'ddc ab23cd', 'DDC-AB-23CD', 'DD12345678']) {
    it(`findUserByReferralCode("${input}") finds the inviter`, async () => {
      const user = await findUserByReferralCode(input, { id: true });
      assert.equal(user && user.id, INVITER.id);
    });
  }

  it('a legacy stored code still resolves unchanged', async () => {
    const user = await findUserByReferralCode('dd87654321', { id: true });
    assert.equal(user && user.id, LEGACY_USER.id);
  });

  it('validateReferralCode accepts the prefixed form', async () => {
    const result = await validateReferralCode('DDC-AB23CD', 'new@example.com');
    assert.equal(result.valid, true);
    assert.equal(result.referrerId, INVITER.id);
  });
});

describe('every response carrying a user\'s code shows the prefix', () => {
  it('GET /api/users/referral-code', async () => {
    const res = await request(app()).get('/api/users/referral-code').set('x-user-id', INVITER.id);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.data.code, 'DDC-AB23CD');
    assert.equal(prisma.user.rows.find((u) => u.id === INVITER.id).referralCode, 'AB23CD', 'stored code unchanged');
  });

  it('PUT /api/users/me', async () => {
    const res = await request(app()).put('/api/users/me').set('x-user-id', INVITER.id).send({ name: 'New' });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.data.referralCode, 'DDC-AB23CD');
    assert.equal(prisma.user.rows.find((u) => u.id === INVITER.id).referralCode, 'AB23CD');
  });

  it('GET /api/referrals/status — own code and the inviter\'s code', async () => {
    prisma.user.rows.push({ id: 'invitee-1', email: 'i@example.com', name: 'Invitee', referralCode: 'XY34ZW' });
    await prisma.referral.create({ data: { inviterId: INVITER.id, inviteeId: 'invitee-1', code: 'AB23CD', campaignSlug: null } });
    const res = await request(app()).get('/api/referrals/status').set('x-user-id', 'invitee-1');
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.data.ownReferralCode, 'DDC-XY34ZW');
    assert.equal(res.body.data.inviterInfo.code, 'DDC-AB23CD');
  });

  it('GET /api/referrals/campaign/mothers-day-2026/stats', async () => {
    const res = await request(app()).get('/api/referrals/campaign/mothers-day-2026/stats').set('x-user-id', INVITER.id);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.data.ownReferralCode, 'DDC-AB23CD');
  });

  it('summer-travel stats service', async () => {
    const stats = await referralService.getSummerTravel2026Stats(INVITER.id);
    assert.equal(stats.ownReferralCode, 'DDC-AB23CD');
  });

  it('a legacy code is returned unchanged', async () => {
    const res = await request(app()).get('/api/referrals/campaign/mothers-day-2026/stats').set('x-user-id', LEGACY_USER.id);
    assert.equal(res.body.data.ownReferralCode, 'DD87654321');
  });

  it('POST /api/auth/login', async () => {
    prisma.user.rows.push({
      id: 'org-1', email: 'org@example.com', password: await bcrypt.hash('pw-123456', 4), referralCode: 'QR45ST',
      userType: 'organization', authType: 'traditional', isOrganization: true,
    });
    const res = await request(app()).post('/api/auth/login').send({ email: 'org@example.com', password: 'pw-123456' });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.data.user.referralCode, 'DDC-QR45ST');
    assert.equal(res.body.data.user.password, undefined);
  });

  it('POST /api/auth/register with a prefixed code: stored bare, own code shown prefixed', async () => {
    const res = await request(app()).post('/api/auth/register').send({
      email: 'new-org@example.com', password: 'pw-123456', name: 'New', referralCode: 'ddc-ab23cd',
    });
    assert.equal(res.status, 201, res.text);
    assert.match(res.body.data.user.referralCode, /^DDC-[A-Z2-9]{6}$/);
    const row = prisma.referral.rows.find((r) => r.inviteeId === res.body.data.user.id);
    assert.equal(row.inviterId, INVITER.id);
    assert.equal(row.code, 'AB23CD', 'the prefix is never stored');
    const stored = prisma.user.rows.find((u) => u.id === res.body.data.user.id);
    assert.equal(`DDC-${stored.referralCode}`, res.body.data.user.referralCode);
    assertNoPrefixStored();
  });

  it('POST /api/auth/web3auth-login (legacy path) registering with a prefixed code', async () => {
    const res = await request(app()).post('/api/auth/web3auth-login').send({
      userInfo: { email: 'w3@example.com', name: 'W3' },
      walletAddress: '0x0000000000000000000000000000000000000abc',
      referralCode: 'DDC AB23CD',
    });
    assert.equal(res.status, 201, res.text);
    assert.match(res.body.data.user.referralCode, /^DDC-[A-Z2-9]{6}$/);
    const row = prisma.referral.rows.find((r) => r.inviteeId === res.body.data.user.id);
    assert.equal(row.code, 'AB23CD');
    assertNoPrefixStored();
  });

  it('POST /api/auth/web3auth-login (legacy path) existing user', async () => {
    const res = await request(app()).post('/api/auth/web3auth-login').send({
      userInfo: { email: INVITER.email },
    });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.data.user.referralCode, 'DDC-AB23CD');
    assert.equal(prisma.user.rows.find((u) => u.id === INVITER.id).referralCode, 'AB23CD');
  });

  it('POST /api/referrals/use-code with a prefixed code binds, stores bare, answers prefixed', async () => {
    prisma.user.rows.push({ id: 'late-1', email: 'late@example.com', name: 'Late', referralCode: 'MN67PQ' });
    const res = await request(app()).post('/api/referrals/use-code').set('x-user-id', 'late-1').send({ code: 'DDC-AB2-3CD' });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.data.inviterId, INVITER.id);
    assert.equal(res.body.data.code, 'DDC-AB23CD');
    assert.equal(prisma.referral.rows.find((r) => r.inviteeId === 'late-1').code, 'AB23CD');
    assertNoPrefixStored();

    // A second attempt reports the recorded code in display form.
    const again = await request(app()).post('/api/referrals/use-code').set('x-user-id', 'late-1').send({ code: 'AB23CD' });
    assert.equal(again.status, 409, again.text);
    assert.equal(again.body.data.code, 'DDC-AB23CD');
  });

  it('partner referral summary code', async () => {
    const summary = await referralSummary(prisma.user.rows.find((u) => u.id === INVITER.id));
    assert.equal(summary.code, 'DDC-AB23CD');
    const legacy = await referralSummary(prisma.user.rows.find((u) => u.id === LEGACY_USER.id));
    assert.equal(legacy.code, null, 'a legacy code still reads as null for the partner');
  });

  it('ops search finds a user by the prefixed code and shows it prefixed', async () => {
    const res = await request(app()).get('/api/ops/users/search').query({ q: 'DDC-AB23CD' });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.data.users.length, 1, JSON.stringify(res.body));
    assert.equal(res.body.data.users[0].referralCode, 'DDC-AB23CD');
  });

  it('ops points export CSV', async () => {
    prisma.user.rows.forEach((u) => { u.totalPoints = 5; });
    const res = await request(app()).get('/api/ops/points/export').query({ zeros: '1' });
    assert.equal(res.status, 200, res.text);
    assert.match(res.text, /,DDC-AB23CD,/);
    assert.match(res.text, /,DD87654321,/);
  });
});

/** mockPrisma's `include` needs the relation declared; add inviter/invitee for Referral reads. */
function wrapInclude(findUnique) {
  if (findUnique.__wrapped) return findUnique;
  const wrapped = async (args) => {
    const row = await findUnique({ where: args.where });
    if (!row || !args.include) return row;
    const out = { ...row };
    if (args.include.inviter) out.inviter = prisma.user.rows.find((u) => u.id === row.inviterId) || null;
    if (args.include.invitee) out.invitee = prisma.user.rows.find((u) => u.id === row.inviteeId) || null;
    return out;
  };
  wrapped.__wrapped = true;
  return wrapped;
}
