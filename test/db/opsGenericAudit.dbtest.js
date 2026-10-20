/** Generic ops mutations and their audit rows commit together on disposable Postgres only.
 * Every mutation branch is exercised through the real router with an accepted and a refused
 * audit row. Translation is stubbed; cover uploads use synthetic bytes and are removed.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const url = process.env.TEST_DATABASE_URL;
if (!url || !/\/[^/?]*test[^/?]*(\?|$)/.test(url)) {
  throw new Error('TEST_DATABASE_URL must name a disposable database containing "test"');
}
Object.assign(process.env, {
  DATABASE_URL: url, LOG_LEVEL: 'error', JWT_SECRET: 'generic-ops-audit-db-test-key',
  PUBLIC_BASE_URL: 'https://api.example.test', OPS_SHARED_LOGIN: 'on',
});
const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const { listenLoopback } = require('../helpers/loopbackServer');
const prisma = require('../../src/utils/prisma');
const clientFile = require.resolve('@prisma/client');
require.cache[clientFile].exports = { ...require.cache[clientFile].exports, PrismaClient: function () { return prisma; } };

let translations = 0;
const translateFile = require.resolve('../../src/services/campaignTranslate');
require.cache[translateFile] = {
  id: translateFile, filename: translateFile, loaded: true, children: [],
  exports: { translateCampaignCopy: async () => { translations += 1; return { title: { en: 'Synthetic translation' } }; } },
};
const opsRouter = require('../../src/routes/opsAdminRoutes');
const { parseDraft } = require('../../src/utils/campaignRules');
const app = express();
app.use(express.json());
app.use('/api/ops', opsRouter);

const RUN = `ga${crypto.randomBytes(4).toString('hex')}`;
const REFUSED = `${RUN}-refused`;
const CONSTRAINT = `${RUN}_refuse_audit`;
const BODY_MARKER = 'BODY-MUST-NOT-ENTER-AUDIT';
let seq = 0;
const nextId = () => `${RUN}-${++seq}`;
let server;
let goodToken;
let badToken;
const coverDir = path.join(__dirname, '../../public/assets/campaigns');

async function user(id = nextId(), extra = {}) {
  return prisma.user.create({ data: { id, email: `${id}@example.test`, referralCode: id.toUpperCase(), ...extra } });
}
before(async () => {
  const good = await user(`${RUN}-admin`);
  const bad = await user(REFUSED);
  for (const row of [good, bad]) {
    await prisma.userRoleGrant.create({ data: { userId: row.id, role: 'ddc_admin', grantedBy: 'script', reason: 'synthetic audit test' } });
  }
  const token = (row) => `Bearer ${jwt.sign({ type: 'ops_admin', kind: 'user', sub: row.id }, process.env.JWT_SECRET, { expiresIn: '10m' })}`;
  goodToken = token(good);
  badToken = token(bad);
  // Both identifiers are generated locally from hex digits, never caller input.
  await prisma.$executeRawUnsafe(`ALTER TABLE "OpsAuditLog" ADD CONSTRAINT "${CONSTRAINT}" CHECK ("actorUserId" <> '${REFUSED}')`);
  server = await listenLoopback(app);
});
after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await prisma.$executeRawUnsafe(`ALTER TABLE "OpsAuditLog" DROP CONSTRAINT IF EXISTS "${CONSTRAINT}"`);
  await prisma.campaign.deleteMany({ where: { slug: { startsWith: RUN } } });
  await prisma.trackedLink.deleteMany({ where: { slug: { startsWith: RUN } } });
  await prisma.dataDemand.deleteMany({ where: { id: { startsWith: RUN } } });
  await prisma.legalEntity.deleteMany({ where: { userId: { startsWith: RUN } } });
  await prisma.user.deleteMany({ where: { id: { startsWith: RUN } } });
  await prisma.opsAuditLog.deleteMany({ where: { actorUserId: { startsWith: RUN } } });
  await prisma.$disconnect();
});

const linkInput = (slug) => ({ slug, name: 'Synthetic link', kind: 'page', title: 'Synthetic', body: BODY_MARKER, targetUrl: 'https://example.test/landing' });
const draftInput = (slug) => ({
  slug, template: 'HOME_CARD', titleEn: 'Synthetic campaign', blurbEn: 'Synthetic description',
  startsAt: new Date(Date.now() + 86400000).toISOString(), endsAt: new Date(Date.now() + 172800000).toISOString(),
  ctaKind: 'ROUTE', ctaValue: '/user/index', purpose: 'Synthetic campaign purpose', legalText: 'Synthetic campaign legal terms for audit verification.',
});
async function campaign(status = 'DRAFT', extra = {}) {
  const parsed = parseDraft(draftInput(nextId()), { ssoClientIds: [] });
  assert.ifError(parsed.error);
  return prisma.campaign.create({ data: { ...parsed.data, status, createdBy: 'script', updatedBy: 'script', ...extra } });
}
const campaignSnapshot = (id) => () => prisma.campaign.findUnique({ where: { id }, include: { events: true, applications: true, raffleWins: true } });

const cases = [
  ['link create', async () => {
    const slug = nextId();
    return { route: '/links', body: linkInput(slug), status: 201, created: true,
      snapshot: () => prisma.trackedLink.findUnique({ where: { slug } }), verify: (row) => assert.equal(row.slug, slug) };
  }],
  ['link update', async () => {
    const row = await prisma.trackedLink.create({ data: linkInput(nextId()) });
    return { method: 'patch', route: `/links/${row.id}`, body: { active: false },
      snapshot: () => prisma.trackedLink.findUnique({ where: { id: row.id } }), verify: (saved) => assert.equal(saved.active, false) };
  }],
  ['campaign create', async () => {
    const body = draftInput(nextId());
    return { route: '/campaigns', body, created: true,
      snapshot: () => prisma.campaign.findUnique({ where: { slug: body.slug }, include: { events: true } }),
      verify: (row) => { assert.equal(row.slug, body.slug); assert.equal(row.events.length, 1); } };
  }],
];
for (const status of ['DRAFT', 'SCHEDULED', 'LIVE', 'ENDED']) {
  cases.push([`campaign ${status} edit`, async () => {
    const row = await campaign(status);
    const body = ['LIVE', 'ENDED'].includes(status)
      ? { titleEn: 'Changed copy' } : { ...draftInput(row.slug), titleEn: 'Changed copy' };
    return { method: 'patch', route: `/campaigns/${row.id}`, body, snapshot: campaignSnapshot(row.id),
      verify: (saved) => { assert.equal(saved.titleEn, 'Changed copy'); assert.equal(saved.events.length, 1); } };
  }]);
}
for (const [action, beforeStatus, afterStatus] of [
  ['schedule', 'DRAFT', 'SCHEDULED'], ['live', 'DRAFT', 'LIVE'], ['end', 'LIVE', 'ENDED'], ['reopen', 'ENDED', 'DRAFT'],
]) {
  cases.push([`campaign ${action}`, async () => {
    const row = await campaign(beforeStatus);
    return { route: `/campaigns/${row.id}/transition`, body: { action }, snapshot: campaignSnapshot(row.id),
      verify: (saved) => { assert.equal(saved.status, afterStatus); assert.equal(saved.events.length, 1); } };
  }]);
}
for (const status of ['approved', 'rejected']) {
  cases.push([`application ${status}`, async () => {
    const row = await campaign('LIVE', { template: 'APPLY_COHORT', config: { seatCap: 10 } });
    const applicant = await user();
    const application = await prisma.campaignApplication.create({ data: { campaignId: row.id, userId: applicant.id, answers: {} } });
    return { route: `/campaigns/${row.id}/applications/${application.id}`, body: { status, note: BODY_MARKER }, snapshot: campaignSnapshot(row.id),
      verify: (saved) => { assert.equal(saved.applications[0].status, status); assert.equal(saved.events.length, 1); } };
  }]);
}
cases.push(['raffle fulfil', async () => {
  const row = await campaign('LIVE', { template: 'RAFFLE' });
  const winner = await user();
  const win = await prisma.campaignRaffleWin.create({ data: { campaignId: row.id, userId: winner.id, prizeIndex: 0, prizeKind: 'gift', labelEn: 'Gift', labelZh: 'Gift' } });
  return { route: `/campaigns/${row.id}/raffle/wins/${win.id}/fulfill`, body: {}, snapshot: campaignSnapshot(row.id),
    verify: (saved) => { assert.equal(saved.raffleWins[0].fulfilled, true); assert.equal(saved.events.length, 1); } };
}]);
for (const [action, nextStatus, body] of [
  ['quote', 'quoted', { quotedPriceUsd: 25, quotedCount: 7, note: BODY_MARKER }],
  ['decline', 'declined', { reason: BODY_MARKER }], ['assemble', 'assembling', { note: BODY_MARKER }],
]) {
  cases.push([`demand ${action}`, async () => {
    const buyer = await user();
    const row = await prisma.dataDemand.create({ data: { id: nextId(), buyerId: buyer.id, recordCount: 5, description: 'Synthetic request', bidUsd: 20 } });
    return { route: `/demands/${row.id}/${action}`, body,
      snapshot: () => prisma.dataDemand.findUnique({ where: { id: row.id }, include: { events: true } }),
      verify: (saved) => { assert.equal(saved.status, nextStatus); assert.equal(saved.events.length, 1); } };
  }]);
}
for (const status of ['approved', 'rejected']) {
  cases.push([`KYC ${status}`, async () => {
    const merchant = await user(nextId(), { isOrganization: true, userType: 'organization' });
    await prisma.legalEntity.create({ data: { userId: merchant.id, companyName: 'Synthetic company', brNumber: 'BR-TEST', beneficialOwner: 'Synthetic owner', address: 'Synthetic address', country: 'SG', email: 'company@example.test', kycStatus: 'submitted' } });
    return { route: `/merchants/${merchant.id}/kyc`, body: { status, note: BODY_MARKER },
      snapshot: () => prisma.legalEntity.findUnique({ where: { userId: merchant.id } }), verify: (saved) => assert.equal(saved.kycStatus, status) };
  }]);
}
for (const status of ['done', 'rejected']) {
  cases.push([`privacy ${status}`, async () => {
    const owner = await user();
    const row = await prisma.privacyRequest.create({ data: { userId: owner.id, kind: 'access' } });
    return { route: `/privacy-requests/${row.id}`, body: { status, note: BODY_MARKER },
      snapshot: () => prisma.privacyRequest.findUnique({ where: { id: row.id } }), verify: (saved) => assert.equal(saved.status, status) };
  }]);
}

describe('every generic DB mutation branch', () => {
  for (const [name, prepare] of cases) {
    for (const rejected of [false, true]) {
      it(`${name}: ${rejected ? 'refused audit rolls back business state and events' : 'business state and one redacted audit row commit together'}`, async () => {
        const fixture = await prepare();
        const beforeState = await fixture.snapshot();
        const actorId = rejected ? REFUSED : `${RUN}-admin`;
        const previous = await prisma.opsAuditLog.count({ where: { actorUserId: actorId } });
        const method = fixture.method || 'post';
        const res = await request(server)[method](`/api/ops${fixture.route}`).set('Authorization', rejected ? badToken : goodToken).send(fixture.body);
        assert.equal(res.status, rejected ? 500 : fixture.status || 200, JSON.stringify(res.body));
        const rows = await prisma.opsAuditLog.findMany({ where: { actorUserId: actorId }, orderBy: { createdAt: 'asc' } });
        assert.equal(rows.length, previous + (rejected ? 0 : 1));
        const afterState = await fixture.snapshot();
        if (rejected) {
          assert.deepEqual(afterState, beforeState);
        } else {
          fixture.verify(afterState);
          const audit = rows.at(-1);
          assert.equal(audit.action, 'ops.write');
          assert.equal(audit.detail.method, method.toUpperCase());
          assert.equal(audit.detail.status, fixture.status || 200);
          const segments = fixture.route.split('/').filter(Boolean);
          assert.equal(audit.targetId, fixture.created ? res.body.data.id : segments[1]);
          assert.equal(audit.targetType, segments[0] === 'merchants' ? 'user' : segments[0]);
          assert.equal(audit.reason, null, 'generic reasons stay unchanged and never copy request notes');
          assert.ok(!JSON.stringify(audit.detail).includes(BODY_MARKER));
          assert.deepEqual(Object.keys(audit.detail).sort(), ['method', 'params', 'route', 'status']);
        }
      });
    }
  }
});

describe('external output is handed out only after its audit persists', () => {
  for (const rejected of [false, true]) {
    it(`translation: ${rejected ? 'audit failure withholds output' : 'successful output has a durable row'}`, async () => {
      const previous = translations;
      const actorId = rejected ? REFUSED : `${RUN}-admin`;
      const beforeRows = await prisma.opsAuditLog.count({ where: { actorUserId: actorId } });
      const res = await request(server).post('/api/ops/campaigns/translate').set('Authorization', rejected ? badToken : goodToken).send({ title: BODY_MARKER });
      assert.equal(translations, previous + 1, 'only the synthetic translator ran');
      assert.equal(res.status, rejected ? 500 : 200);
      assert.equal(await prisma.opsAuditLog.count({ where: { actorUserId: actorId } }), beforeRows + (rejected ? 0 : 1));
      assert.equal(Boolean(res.body.data), !rejected);
    });
    it(`cover: ${rejected ? 'audit failure removes the file and withholds its URL' : 'successful URL has a durable row'}`, async () => {
      const beforeFiles = new Set(await fs.readdir(coverDir));
      try {
        const res = await request(server).post('/api/ops/campaigns/cover').set('Authorization', rejected ? badToken : goodToken)
          .attach('image', Buffer.from('synthetic-image-bytes'), { filename: 'synthetic.png', contentType: 'image/png' });
        assert.equal(res.status, rejected ? 500 : 200, JSON.stringify(res.body));
        const added = (await fs.readdir(coverDir)).filter((file) => !beforeFiles.has(file));
        assert.equal(added.length, rejected ? 0 : 1);
        if (rejected) assert.equal(res.body.data, undefined);
        else {
          assert.equal(res.body.data.path, `/assets/campaigns/${added[0]}`);
          const rows = await prisma.opsAuditLog.findMany({ where: { actorUserId: `${RUN}-admin`, targetId: res.body.data.path } });
          assert.equal(rows.length, 1);
          assert.equal(rows[0].targetType, 'campaign_cover');
        }
      } finally {
        for (const file of await fs.readdir(coverDir)) if (!beforeFiles.has(file)) await fs.unlink(path.join(coverDir, file));
      }
    });
  }
});
