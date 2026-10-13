/**
 * What a staff member's personal session leaves outside the ops audit log, and the developer
 * console's closed registration, on REAL Postgres (`npm run test:db`; needs TEST_DATABASE_URL
 * pointing at a throwaway database that `prisma migrate deploy` has built — its name must contain
 * "test").
 *
 *   - A points adjust and a privacy-request resolve by an operator: the end user's own answers and
 *     the demo login's answers carry the operator's record label (`ops:` and a keyed hash), never
 *     the operator's e-mail or name; the audit row keeps who acted (actorUserId, actorLabel).
 *   - After a round of ops writes by an operator and a ddc_admin (points, privacy, merchant credit,
 *     payment confirm and reject, KYC review, campaign create / update / go live / end, data request
 *     quote, role grant, disable), no text or JSON column of any table other than "User" and
 *     "OpsAuditLog" holds either staff member's e-mail or name.
 *   - While self-serve registration is closed, a developer's client and its console.client_register
 *     row commit together: when Postgres refuses the row, there is no client.
 *
 * Fixture rows use a per-run id prefix and are deleted afterwards.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required for test:db (a throwaway, migrated database)');
if (!/\/[^/?]*test[^/?]*(\?|$)/.test(url)) throw new Error('TEST_DATABASE_URL must name a database containing "test" — refusing to write fixtures anywhere else');
process.env.DATABASE_URL = url;
process.env.LOG_LEVEL = 'error';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'ops-staff-records-db-test-key';
process.env.PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'https://api.test.local';
delete process.env.SSO_DEVELOPER_REGISTRATION;

const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');

const prisma = require('../../src/utils/prisma');
// Modules that build their own client at load get the shared one, so after() closes it.
const clientFile = require.resolve('@prisma/client');
require.cache[clientFile].exports = {
  ...require.cache[clientFile].exports,
  PrismaClient: function PrismaClient() {
    return prisma;
  },
};

const { initDeveloperRegistration } = require('../../src/constants/developerRegistration');

initDeveloperRegistration({ env: {}, log: { info() {}, warn() {} } });

const app = express();
app.use(express.json());
app.use('/api/ops', require('../../src/routes/opsAdminRoutes'));
app.use('/api/users', require('../../src/routes/userRoutes'));
app.use('/api/assets', require('../../src/routes/assetRoutes'));
app.use('/api/developer/sso', require('../../src/routes/developerSsoRoutes'));

const RUN = `sr${crypto.randomBytes(3).toString('hex')}`;
const id = (name) => `${RUN}-${name}`;
const secret = process.env.JWT_SECRET;
const nowSec = () => Math.floor(Date.now() / 1000);

const opsToken = (row) => `Bearer ${jwt.sign({ type: 'ops_admin', kind: 'user', sub: row.id }, secret, { expiresIn: '10m' })}`;
const walletToken = (row) => `Bearer ${jwt.sign({ id: row.id, ver: 2, iat: nowSec() }, secret, { expiresIn: '10m' })}`;
const demoToken = () => `Bearer ${jwt.sign({ type: 'ops_admin', sub: 'demo-viewer', role: 'demo' }, secret, { expiresIn: '10m' })}`;

/** The generic row lands after the answer. */
const settle = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms));

async function user(name, extra = {}) {
  return prisma.user.create({
    data: { id: id(name), email: `${id(name)}@example.test`, name: id(name), referralCode: id(name).toUpperCase(), ...extra },
  });
}

/**
 * A staff account whose e-mail and name share nothing with its id, so a hit in the sweep can only
 * be the e-mail or the name itself.
 */
async function staff(name, role) {
  const tag = crypto.randomBytes(4).toString('hex');
  const row = await user(name, { email: `person.${tag}@staff-mail.test`, name: `Staff Person ${tag}` });
  await prisma.userRoleGrant.create({ data: { userId: row.id, role, grantedBy: 'script', reason: 'db test staff' } });
  return row;
}

/** The record label, computed here on its own: `ops:` and 10 hex of a keyed hash of the id (see opsAudit). */
const recordLabel = (row) => {
  const key = crypto.createHmac('sha256', process.env.JWT_SECRET).update('ops-record-label').digest();
  return `ops:${crypto.createHmac('sha256', key).update(row.id).digest('hex').slice(0, 10)}`;
};

let operator;
let admin;
let member;

before(async () => {
  operator = await staff('operator', 'operator');
  admin = await staff('admin', 'ddc_admin');
  member = await user('member', { totalPoints: 20 });
});

after(async () => {
  await prisma.$executeRawUnsafe(`ALTER TABLE "OpsAuditLog" DROP CONSTRAINT IF EXISTS "${RUN}_refuse"`);
  const users = (await prisma.user.findMany({ where: { id: { startsWith: RUN } }, select: { id: true } })).map((u) => u.id);
  await prisma.opsAuditLog.deleteMany({
    where: { OR: [{ actorUserId: { in: users } }, { targetId: { in: users } }, { targetId: { startsWith: RUN } }] },
  });
  await prisma.campaign.deleteMany({ where: { slug: { startsWith: RUN.toLowerCase() } } });
  if (users.length) {
    const clients = (await prisma.ssoDeveloperClient.findMany({ where: { ownerUserId: { in: users } }, select: { clientId: true } })).map((c) => c.clientId);
    await prisma.opsAuditLog.deleteMany({ where: { targetId: { in: clients } } });
    await prisma.ssoDeveloperClient.deleteMany({ where: { ownerUserId: { in: users } } });
    await prisma.dataDemand.deleteMany({ where: { buyerId: { in: users } } });
    await prisma.payment.deleteMany({ where: { OR: [{ payerId: { in: users } }, { payeeId: { in: users } }] } });
    await prisma.organizationTransaction.deleteMany({ where: { userId: { in: users } } });
    await prisma.legalEntity.deleteMany({ where: { userId: { in: users } } });
    await prisma.privacyRequest.deleteMany({ where: { userId: { in: users } } });
    await prisma.point.deleteMany({ where: { userId: { in: users } } });
    await prisma.userRoleGrant.deleteMany({ where: { userId: { in: users } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
  }
  await prisma.$disconnect();
});

/** Whether any of `needles` appears in `value` (an answer body). */
function carries(value, needles) {
  const text = JSON.stringify(value);
  return needles.filter((needle) => text.includes(needle));
}

describe("an operator's points adjust and privacy resolve, seen by the user and the demo login", () => {
  it('a points adjust: the user\'s own point answers and the demo login\'s answers carry the label, never the e-mail', async () => {
    const res = await request(app).post(`/api/ops/users/${member.id}/points`).set('Authorization', opsToken(operator)).send({ amount: 7, note: 'goodwill credit' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(res.body.data.sourceId.endsWith(`__${recordLabel(operator)}`), res.body.data.sourceId);
    // Nor a label built from the id itself.
    const identity = [operator.email, operator.name, `ops:${operator.id.slice(0, 8)}`];

    const answers = {
      userPoints: await request(app).get('/api/users/points').set('Authorization', walletToken(member)),
      assetPoints: await request(app).get('/api/assets/points').set('Authorization', walletToken(member)),
      demoOperations: await request(app).get('/api/ops/operations').set('Authorization', demoToken()),
      demoHistory: await request(app).get(`/api/ops/users/${member.id}/points/history`).set('Authorization', demoToken()),
      demoUserView: await request(app).get(`/api/ops/users/${member.id}`).set('Authorization', demoToken()),
    };
    for (const [name, answer] of Object.entries(answers)) {
      assert.equal(answer.status, 200, `${name}: ${JSON.stringify(answer.body)}`);
      assert.deepEqual(carries(answer.body, identity), [], `${name} names the operator`);
    }
    assert.ok(JSON.stringify(answers.userPoints.body).includes(recordLabel(operator)), 'the user sees the label');

    const rows = await prisma.opsAuditLog.findMany({ where: { action: 'points.adjust', targetId: member.id } });
    assert.deepEqual(rows.map((row) => [row.actorUserId, row.actorLabel]), [[operator.id, operator.email]], 'the audit row keeps who acted');
  });

  it('a privacy resolve: the requester\'s list and the demo login\'s list carry the label, never the e-mail', async () => {
    const pr = await prisma.privacyRequest.create({ data: { userId: member.id, kind: 'export' } });
    const res = await request(app).post(`/api/ops/privacy-requests/${pr.id}`).set('Authorization', opsToken(operator)).send({ status: 'done', note: 'sent' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal((await prisma.privacyRequest.findUnique({ where: { id: pr.id } })).resolvedBy, recordLabel(operator));

    const mine = await request(app).get('/api/users/privacy-requests').set('Authorization', walletToken(member));
    const demo = await request(app).get('/api/ops/privacy-requests').set('Authorization', demoToken());
    for (const [name, answer] of Object.entries({ mine, demo })) {
      assert.equal(answer.status, 200, `${name}: ${JSON.stringify(answer.body)}`);
      assert.deepEqual(carries(answer.body, [operator.email, operator.name]), [], `${name} names the operator`);
    }
    await settle();
    const rows = await prisma.opsAuditLog.findMany({ where: { actorUserId: operator.id, targetType: 'privacy-requests', targetId: pr.id } });
    assert.deepEqual(rows.map((row) => [row.action, row.actorLabel]), [['ops.write', operator.email]]);
  });
});

describe('the sweep: no staff e-mail or name outside "User" and "OpsAuditLog"', () => {
  before(async () => {
    const opsAs = (who) => ({
      post: (path, body = {}, headers = {}) => request(app).post(`/api/ops${path}`).set('Authorization', opsToken(who)).set(headers).send(body),
      patch: (path, body = {}) => request(app).patch(`/api/ops${path}`).set('Authorization', opsToken(who)).send(body),
    });
    const op = opsAs(operator);
    const ad = opsAs(admin);
    const expectOk = (res, what) => assert.ok(res.status >= 200 && res.status < 300, `${what}: ${res.status} ${JSON.stringify(res.body)}`);

    // Merchants: a credit, a top-up confirmed and one rejected, a KYC review.
    const merchant = await user('merchant', { isOrganization: true, userType: 'organization' });
    await prisma.legalEntity.create({
      data: { userId: merchant.id, companyName: `${merchant.id} Ltd`, brNumber: 'BR-1', beneficialOwner: 'Owner', address: '1 Street', country: 'SG', email: `kyc-${merchant.id}@example.test`, kycStatus: 'submitted' },
    });
    expectOk(await op.post(`/merchants/${merchant.id}/credit`, { amount: 12, note: 'goodwill credit' }, { 'Idempotency-Key': `${RUN}-credit-1` }), 'credit');
    for (const [name, decision] of [['confirm', 'confirm'], ['reject', 'reject']]) {
      const ledger = await prisma.organizationTransaction.create({ data: { userId: merchant.id, amount: 9, type: 'DEPOSIT', status: 'PENDING', description: `${RUN} top-up` } });
      const payment = await prisma.payment.create({
        data: {
          id: id(`pay-${name}`), paymentNumber: id(`pay-${name}`).toUpperCase(), payerId: merchant.id, payeeId: merchant.id,
          amount: 9, currency: 'USD', method: 'top_up', status: 'pending', matchStatus: 'unmatched', organizationTransactionId: ledger.id,
        },
      });
      expectOk(await op.post(`/payments/${payment.id}/${decision}`, { notes: 'slip checked' }), decision);
    }
    expectOk(await op.post(`/merchants/${merchant.id}/kyc`, { status: 'rejected', note: 'document unreadable' }), 'kyc');

    // Campaigns: create, update, go live, end; each writes createdBy / updatedBy / publishedBy and an event.
    const slug = id('camp').toLowerCase();
    const draft = {
      slug,
      template: 'HOME_CARD',
      startsAt: new Date(Date.now() - 3600000).toISOString(),
      endsAt: new Date(Date.now() + 86400000).toISOString(),
      titleEn: 'Sweep',
      blurbEn: 'A sweep campaign',
      ctaKind: 'ROUTE',
      ctaValue: '/user/index',
    };
    const created = await op.post('/campaigns', draft);
    expectOk(created, 'campaign create');
    const campaignId = created.body.data.id;
    expectOk(await op.patch(`/campaigns/${campaignId}`, { ...draft, blurbEn: 'A sweep campaign, edited' }), 'campaign update');
    const legal = { purpose: 'Testing who acted', legalText: 'Plain legal text for the sweep campaign.' };
    expectOk(await op.post(`/campaigns/${campaignId}/transition`, { action: 'live', ...legal }), 'campaign live');
    expectOk(await op.post(`/campaigns/${campaignId}/transition`, { action: 'end' }), 'campaign end');

    // A data request quoted by the operator (its event names the actor).
    const buyer = await user('buyer', { isOrganization: true, userType: 'organization' });
    const demand = await prisma.dataDemand.create({ data: { buyerId: buyer.id, recordCount: 2, description: 'Two rows', bidUsd: 40 } });
    expectOk(await op.post(`/demands/${demand.id}/quote`, { quotedPriceUsd: 35, quotedCount: 2 }), 'quote');

    // ddc_admin: a role grant and a disable.
    const grantee = await user('grantee');
    expectOk(await ad.post(`/users/${grantee.id}/roles`, { role: 'developer', reason: 'partner integration' }), 'grant');
    const leaver = await user('leaver');
    expectOk(await ad.post(`/users/${leaver.id}/disable`, { reason: 'left the project' }), 'disable');
    await settle();
  });

  it('the records carry the labels', async () => {
    assert.equal((await prisma.userRoleGrant.findUnique({ where: { userId_role: { userId: id('grantee'), role: 'developer' } } })).grantedBy, recordLabel(admin));
    assert.equal((await prisma.user.findUnique({ where: { id: id('leaver') } })).disabledBy, recordLabel(admin));
    assert.equal((await prisma.legalEntity.findUnique({ where: { userId: id('merchant') } })).kycReviewedBy, recordLabel(operator));
    const campaign = await prisma.campaign.findFirst({ where: { slug: id('camp').toLowerCase() } });
    assert.deepEqual([campaign.createdBy, campaign.updatedBy, campaign.publishedBy], Array(3).fill(recordLabel(operator)));
    const ledger = await prisma.organizationTransaction.findMany({ where: { userId: id('merchant') } });
    const meta = ledger.map((row) => row.metadata || {});
    assert.ok(meta.some((m) => m.operator === recordLabel(operator)), 'credit operator');
    assert.ok(meta.some((m) => m.confirmedBy === recordLabel(operator)), 'confirmedBy');
    assert.ok(meta.some((m) => m.rejectedBy === recordLabel(operator)), 'rejectedBy');
  });

  it('no text or JSON column outside "User" and "OpsAuditLog" holds a staff e-mail or name', async () => {
    const columns = await prisma.$queryRawUnsafe(
      `SELECT c.table_name, c.column_name
       FROM information_schema.columns c
       JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
       WHERE c.table_schema = current_schema() AND t.table_type = 'BASE TABLE'
         AND c.data_type IN ('text', 'character varying', 'json', 'jsonb', 'ARRAY')
         AND c.table_name NOT IN ('User', 'OpsAuditLog', '_prisma_migrations')
       ORDER BY c.table_name, c.column_name`,
    );
    assert.ok(columns.length > 50, `the sweep covers the schema (${columns.length} columns)`);
    const needles = [operator.email, operator.name, admin.email, admin.name];
    const hits = [];
    for (const { table_name: table, column_name: column } of columns) {
      for (const needle of needles) {
        const [row] = await prisma.$queryRawUnsafe(
          `SELECT count(*)::int AS n FROM "${table}" WHERE "${column}"::text ILIKE $1`,
          `%${needle}%`,
        );
        if (row.n) hits.push(`${table}.${column}`);
      }
    }
    assert.deepEqual(hits, []);
    // ...and the audit log still says who acted.
    const audit = await prisma.opsAuditLog.findMany({ where: { actorUserId: { in: [operator.id, admin.id] } }, select: { actorUserId: true, actorLabel: true } });
    assert.ok(audit.length >= 8, `audit rows: ${audit.length}`);
    for (const row of audit) assert.equal(row.actorLabel, row.actorUserId === operator.id ? operator.email : admin.email);
  });
});

describe('closed registration on the console: the client and its console.client_register row commit together', () => {
  const body = { client_name: 'Atomic client', redirect_uris: ['https://client.example.test/cb'], contact_email: 'dev@client.example.test' };
  const register = (who) => request(app).post('/api/developer/sso/clients').set('Authorization', walletToken(who)).send(body);

  it('a refused row leaves no client; an accepted one leaves one client and one row', async () => {
    const developer = await staff('developer', 'developer');
    const { clearRateLimitStore } = require('../../src/middlewares/rateLimitMiddleware');
    clearRateLimitStore();
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "OpsAuditLog" ADD CONSTRAINT "${RUN}_refuse" CHECK ("actorUserId" IS DISTINCT FROM '${developer.id}') NOT VALID`,
    );
    let refused;
    try {
      refused = await register(developer);
    } finally {
      await prisma.$executeRawUnsafe(`ALTER TABLE "OpsAuditLog" DROP CONSTRAINT IF EXISTS "${RUN}_refuse"`);
    }
    assert.equal(refused.status, 500, JSON.stringify(refused.body));
    assert.equal(refused.body.client_secret, undefined);
    assert.equal(await prisma.ssoDeveloperClient.count({ where: { ownerUserId: developer.id } }), 0, 'no row, no client');
    assert.equal(await prisma.opsAuditLog.count({ where: { action: 'console.client_register', actorUserId: developer.id } }), 0);

    const ok = await register(developer);
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    const clients = await prisma.ssoDeveloperClient.findMany({ where: { ownerUserId: developer.id } });
    assert.deepEqual(clients.map((c) => c.clientId), [ok.body.client_id]);
    const rows = await prisma.opsAuditLog.findMany({ where: { action: 'console.client_register', actorUserId: developer.id } });
    assert.deepEqual(rows.map((row) => [row.targetType, row.targetId, row.actorRole, row.surface]), [['sso_client', ok.body.client_id, 'developer', 'console']]);
  });

  it('two registrations at once: each client has exactly its own row', async () => {
    const developer = await staff('developer-pair', 'developer');
    const { clearRateLimitStore } = require('../../src/middlewares/rateLimitMiddleware');
    clearRateLimitStore();
    const results = await Promise.all([register(developer), register(developer)]);
    assert.deepEqual(results.map((r) => r.status), [201, 201], JSON.stringify(results.map((r) => r.body)));
    const clients = (await prisma.ssoDeveloperClient.findMany({ where: { ownerUserId: developer.id } })).map((c) => c.clientId).sort();
    const rows = (await prisma.opsAuditLog.findMany({ where: { action: 'console.client_register', actorUserId: developer.id } })).map((r) => r.targetId).sort();
    assert.deepEqual(rows, clients);
  });
});
