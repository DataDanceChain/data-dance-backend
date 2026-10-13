/**
 * Sign-in refusals (admin issue #2, contract §3.7): each of the four places in
 * web3authIdentity.resolveUser that refuses with IDENTITY_CONFLICT also records a row, without
 * awaiting it and without changing the refusal; GET /api/ops/identity-conflicts lists them with
 * counts by reason. resolveUser runs on the same in-memory store the REAL application reads.
 */
const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { installOpsApp, listenLoopback, seedUser, grant, bearer, tokens, settle } = require('../helpers/opsApp');

const { prisma, app } = installOpsApp();
const { clearRateLimitStore } = require('../../src/middlewares/rateLimitMiddleware');
const { resolveUser, _internals } = require('../../src/services/web3authIdentity');
const { recordLog, recordIdentityConflict } = require('../../src/services/identityConflicts');

let server;
before(async () => { server = await listenLoopback(app); });
after(() => new Promise((resolve) => server.close(resolve)));

const G = 'web3auth-google-sapphire-mainnet';
const IDENTITY = {
  kind: 'social',
  verifier: G,
  verifierId: 'alice@example.test',
  email: 'alice@example.test',
  name: 'Alice',
  profileImage: null,
  wallets: [],
};

/** A complete WEB3AUTH_NETWORK_REBIND=on configuration (log mode, no legacy fallback). */
const REBIND_ENV = {
  WEB3AUTH_VERIFY_MODE: 'log',
  WEB3AUTH_CLIENT_ID: 'unit-client-id',
  WEB3AUTH_ALLOWED_VERIFIERS: G,
  WEB3AUTH_ALLOW_LEGACY_FALLBACK: 'false',
  WEB3AUTH_NETWORK_REBIND: 'on',
  WEB3AUTH_REBIND_VERIFIERS: G,
  WEB3AUTH_EMAIL_TRUSTED_VERIFIERS: G,
};
const ENV_NAMES = [...Object.keys(REBIND_ENV), 'WEB3AUTH_LEGACY_VERIFIERS'];

let savedEnv;
function withEnv(patch) {
  for (const name of ENV_NAMES) delete process.env[name];
  Object.assign(process.env, { WEB3AUTH_VERIFY_MODE: 'off' }, patch);
  _internals.resetConfig();
}

let adminAuth;
beforeEach(async () => {
  prisma.reset();
  clearRateLimitStore();
  savedEnv = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
  withEnv({});
  const admin = await seedUser(prisma, { email: 'sloan@example.test' });
  await grant(prisma, admin.id, 'ddc_admin');
  adminAuth = bearer(tokens.ops(admin));
});

after(() => {
  for (const [name, value] of Object.entries(savedEnv || {})) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  _internals.resetConfig();
});

async function conflict(promise) {
  let caught = null;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, 'expected IDENTITY_CONFLICT');
  assert.equal(caught.code, 'IDENTITY_CONFLICT', caught.message);
  await settle(); // the record is not awaited by resolveUser
  return caught;
}

/** The four refusal sites, each set up on a fresh store. Returns what resolveUser throws. */
const SITES = {
  // rebindConflict: two accounts whose e-mails differ only in case, re-bind on.
  network_rebind: async (db = prisma) => {
    withEnv(REBIND_ENV);
    await seedUser(prisma, { id: 'alice-title-case', email: 'Alice@example.test' });
    await seedUser(prisma, { id: 'alice-upper-case', email: 'ALICE@example.test' });
    return conflict(resolveUser(IDENTITY, { db }));
  },
  // The backfill refusal: the e-mail belongs to a password account.
  backfill: async (db = prisma) => {
    await seedUser(prisma, { id: 'pw-account', email: 'alice@example.test', authType: 'traditional' });
    return conflict(resolveUser(IDENTITY, { db }));
  },
  // backfill_race: the conditional link changed no row.
  backfill_race: async (db = prisma) => {
    withEnv({ WEB3AUTH_LEGACY_VERIFIERS: G, WEB3AUTH_ALLOWED_VERIFIERS: G });
    await seedUser(prisma, { id: 'legacy-account', email: 'alice@example.test' });
    const original = prisma.user.updateMany;
    prisma.user.updateMany = async () => ({ count: 0 });
    try {
      return await conflict(resolveUser({ ...IDENTITY, emailVerified: true }, { db }));
    } finally {
      prisma.user.updateMany = original;
    }
  },
  // unique_violation: the create hits a unique index.
  create: async (db = prisma) => {
    const original = prisma.user.create;
    prisma.user.create = async () => {
      throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002', meta: { target: ['email'] } });
    };
    try {
      return await conflict(resolveUser({ ...IDENTITY, verifierId: 'bob@example.test', email: 'bob@example.test' }, { db }));
    } finally {
      prisma.user.create = original;
    }
  },
};

const EXPECTED = {
  network_rebind: { reason: 'ambiguous_email', route: 'network_rebind', candidateBy: 'email', candidateUserId: 'alice-title-case' },
  backfill: { reason: 'candidate_not_web3auth', route: 'backfill', candidateBy: 'email', candidateUserId: 'pw-account' },
  backfill_race: { reason: 'backfill_race', route: 'backfill', candidateBy: 'email', candidateUserId: 'legacy-account' },
  create: { reason: 'unique_violation', route: 'create', candidateBy: null, candidateUserId: null },
};

describe('each refusal site records one row', () => {
  for (const [site, expected] of Object.entries(EXPECTED)) {
    it(`${site}: ${expected.reason}`, async () => {
      const error = await SITES[site]();
      assert.equal(error.details.reason, expected.reason);
      const rows = prisma.store.identityConflict;
      assert.equal(rows.length, 1);
      const [row] = rows;
      assert.equal(row.reason, expected.reason);
      assert.equal(row.route, expected.route);
      assert.equal(row.candidateBy, expected.candidateBy);
      assert.equal(row.candidateUserId, expected.candidateUserId);
      assert.equal(row.verifier, G);
      // No e-mail, verifierId or wallet address is stored.
      const stored = JSON.stringify(row).toLowerCase();
      assert.ok(!stored.includes('alice@'), 'no e-mail');
      assert.ok(!stored.includes('bob@'), 'no e-mail');
      assert.deepEqual(
        Object.keys(row).sort(),
        ['candidateBy', 'candidateUserId', 'createdAt', 'id', 'reason', 'route', 'verifier'],
      );
    });
  }
});

describe('a failing sink never changes the refusal', () => {
  for (const site of Object.keys(EXPECTED)) {
    it(`${site}: the same IDENTITY_CONFLICT, and identity_conflict_record_failed with the error name only`, async () => {
      const reference = await SITES[site]();
      prisma.reset();
      withEnv({});
      const logged = [];
      const originalLog = recordLog.error;
      const originalCreate = prisma.identityConflict.create;
      recordLog.error = (event, entry) => logged.push([event, entry]);
      prisma.identityConflict.create = async () => {
        throw Object.assign(new Error('relation "IdentityConflict" does not exist alice@example.test'), { name: 'PrismaClientKnownRequestError' });
      };
      let failing;
      try {
        failing = await SITES[site]();
      } finally {
        recordLog.error = originalLog;
        prisma.identityConflict.create = originalCreate;
      }
      assert.equal(failing.code, reference.code);
      assert.equal(failing.message, reference.message);
      assert.equal(failing.httpStatus, reference.httpStatus);
      assert.deepEqual(failing.details, reference.details);
      assert.deepEqual(logged, [['identity_conflict_record_failed', { errorName: 'PrismaClientKnownRequestError' }]]);
      assert.equal(prisma.store.identityConflict.length, 0);
    });
  }

  it('a sink that throws synchronously, or a db without the model, still resolves', async () => {
    const originalLog = recordLog.error;
    const logged = [];
    recordLog.error = (event, entry) => logged.push(entry.errorName);
    try {
      await recordIdentityConflict({ identityConflict: { create() { throw new TypeError('sync'); } } }, { reason: 'x', route: 'create', verifier: G });
      await recordIdentityConflict({}, { reason: 'x', route: 'create', verifier: G });
      await recordIdentityConflict(prisma, { reason: 'x', route: 'not-a-route', verifier: G });
    } finally {
      recordLog.error = originalLog;
    }
    assert.deepEqual(logged, ['TypeError', 'TypeError', 'TypeError']);
    assert.equal(prisma.store.identityConflict.length, 0);
  });
});

describe('GET /api/ops/identity-conflicts', () => {
  const list = (query = '', authorization = adminAuth) =>
    request(server).get(`/api/ops/identity-conflicts${query}`).set('Authorization', authorization);

  async function seedConflicts() {
    const member = await seedUser(prisma, { id: 'member-1', email: 'member@example.test' });
    await prisma.web3AuthNetworkRebind.create({
      data: { userId: member.id, runId: 'run-1', fromNetwork: 'devnet', toNetwork: 'mainnet', walletPolicy: 'replace', evidence: 'devnet_pair', status: 'pending' },
    });
    const rows = [
      ['2026-10-01T00:00:00Z', 'wallet_in_use', 'network_rebind', member.id],
      ['2026-10-02T00:00:00Z', 'wallet_in_use', 'network_rebind', member.id],
      ['2026-10-03T00:00:00Z', 'candidate_not_web3auth', 'backfill', 'other-user'],
      ['2026-10-04T00:00:00Z', 'unique_violation', 'create', null],
    ];
    for (const [at, reason, route, candidateUserId] of rows) {
      await prisma.identityConflict.create({
        data: { createdAt: new Date(at), reason, route, candidateBy: candidateUserId ? 'email' : null, candidateUserId, verifier: G },
      });
    }
    return member;
  }

  it('lists newest first with the candidate e-mail joined, the re-bind status and counts by reason', async () => {
    const member = await seedConflicts();
    const res = await list();
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const data = res.body.data;
    assert.equal(data.total, 4);
    assert.equal(data.limit, 50);
    assert.equal(data.offset, 0);
    assert.deepEqual(data.byReason, [
      { reason: 'wallet_in_use', count: 2 },
      { reason: 'candidate_not_web3auth', count: 1 },
      { reason: 'unique_violation', count: 1 },
    ]);
    assert.deepEqual(data.items.map((i) => i.reason), ['unique_violation', 'candidate_not_web3auth', 'wallet_in_use', 'wallet_in_use']);
    const mine = data.items[2];
    assert.equal(mine.candidateUserId, member.id);
    assert.equal(mine.candidateEmail, 'member@example.test');
    assert.deepEqual(mine.rebind, { status: 'pending', walletPolicy: 'replace' });
    assert.equal(data.items[1].candidateEmail, null, 'an account that no longer exists has no e-mail');
    assert.equal(data.items[0].candidateUserId, null);
    assert.equal(data.items[0].rebind, null);
    assert.deepEqual(
      Object.keys(mine).sort(),
      ['candidateBy', 'candidateEmail', 'candidateUserId', 'createdAt', 'id', 'reason', 'rebind', 'route', 'verifier'],
    );
  });

  it('filters by reason, account and date; pages with limit and offset', async () => {
    const member = await seedConflicts();
    const byReason = (await list('?reason=wallet_in_use')).body.data;
    assert.equal(byReason.total, 2);
    assert.equal(byReason.byReason.length, 3, 'the counts ignore the reason filter');
    const byUser = (await list(`?userId=${member.id}`)).body.data;
    assert.equal(byUser.total, 2);
    assert.deepEqual(byUser.byReason, [{ reason: 'wallet_in_use', count: 2 }]);
    const byDate = (await list(`?from=${encodeURIComponent('2026-10-02T00:00:00Z')}&to=${encodeURIComponent('2026-10-03T00:00:00Z')}`)).body.data;
    assert.deepEqual(byDate.items.map((i) => i.reason), ['candidate_not_web3auth', 'wallet_in_use']);
    const page = (await list('?limit=1&offset=1')).body.data;
    assert.equal(page.total, 4);
    assert.deepEqual(page.items.map((i) => i.reason), ['candidate_not_web3auth']);
    assert.equal((await list('?limit=999')).body.data.limit, 200);
    assert.equal((await list('?from=not-a-date')).status, 400);
  });

  it('needs ops.support: an operator reads it; shared and demo get 403', async () => {
    await seedConflicts();
    const operator = await seedUser(prisma);
    await grant(prisma, operator.id, 'operator');
    assert.equal((await list('', bearer(tokens.ops(operator)))).status, 200);
    process.env.OPS_SHARED_LOGIN = 'on';
    try {
      const shared = await list('', bearer(tokens.shared()));
      assert.equal(shared.status, 403);
      assert.equal(shared.body.code, 'FORBIDDEN_ROLE');
    } finally {
      delete process.env.OPS_SHARED_LOGIN;
    }
    const demo = await list('', bearer(tokens.demo()));
    assert.equal(demo.status, 403);
    assert.equal(demo.body.code, 'FORBIDDEN_ROLE');
  });
});
