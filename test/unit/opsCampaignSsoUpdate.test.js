/**
 * Ops campaign update keeps an EXTERNAL home card's partner SSO client id when the admin form
 * saves without it (the form has no such field), so a copy edit never silently turns the SSO
 * hand-off off again.
 */
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { installMockPrisma } = require('../helpers/mockPrisma');

const prisma = installMockPrisma();
const rows = new Map();
const events = [];
prisma.campaign = {
  async findUnique({ where }) {
    const row = rows.get(where.id);
    return row ? { ...row } : null;
  },
  async update({ where, data }) {
    const row = { ...rows.get(where.id), ...data };
    rows.set(where.id, row);
    return { ...row };
  },
};
prisma.campaignEvent = {
  async create({ data }) {
    events.push(data);
    return data;
  },
};

const { update } = require('../../src/controllers/opsCampaignController');

const savedClientId = process.env.SSO_TGE_CLIENT_ID;

function storedCard(overrides = {}) {
  return {
    id: 'c1',
    slug: 'tge-partner-login',
    template: 'HOME_CARD',
    status: 'DRAFT',
    titleEn: 'Partner login',
    titleZh: null,
    blurbEn: 'Open the partner page already signed in.',
    blurbZh: null,
    pillEn: null,
    pillZh: null,
    legalText: null,
    legalVersion: 1,
    publishedAt: null,
    startsAt: new Date('2026-09-01T00:00:00.000Z'),
    endsAt: new Date('2026-10-01T00:00:00.000Z'),
    ctaKind: 'EXTERNAL',
    ctaValue: 'https://tge.datadance.ai/login',
    coverImageUrl: null,
    config: { shareTextEn: 'Share me', shareTextZh: null, ssoClientId: 'tge-local' },
    ...overrides,
  };
}

/** The flat body the admin HOME_CARD form sends: no ssoClientId, no config key. */
function adminForm(overrides = {}) {
  return {
    slug: 'tge-partner-login',
    template: 'HOME_CARD',
    titleEn: 'Partner login (fixed typo)',
    blurbEn: 'Open the partner page already signed in.',
    startsAt: '2026-09-01T00:00:00.000Z',
    endsAt: '2026-10-01T00:00:00.000Z',
    ctaKind: 'EXTERNAL',
    ctaValue: 'https://tge.datadance.ai/login',
    shareTextEn: 'Share me',
    ...overrides,
  };
}

async function callUpdate(body) {
  const res = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  await update({ params: { id: 'c1' }, body, opsAdmin: { username: 'ops' } }, res);
  return res;
}

describe('ops campaign update keeps the SSO client id', () => {
  beforeEach(() => {
    rows.clear();
    events.length = 0;
    rows.set('c1', storedCard());
    process.env.SSO_TGE_CLIENT_ID = 'tge-local';
  });
  afterEach(() => {
    if (savedClientId === undefined) delete process.env.SSO_TGE_CLIENT_ID;
    else process.env.SSO_TGE_CLIENT_ID = savedClientId;
  });

  it('keeps the stored id when a DRAFT save omits the field', async () => {
    const res = await callUpdate(adminForm());
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(rows.get('c1').titleEn, 'Partner login (fixed typo)');
    assert.equal(rows.get('c1').config.ssoClientId, 'tge-local');
    assert.equal(res.body.data.publicCard.config.ssoClientId, 'tge-local');
  });

  it('keeps the stored id on a SCHEDULED card too', async () => {
    rows.set('c1', storedCard({ status: 'SCHEDULED' }));
    const res = await callUpdate(adminForm());
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(rows.get('c1').config.ssoClientId, 'tge-local');
  });

  it('clears the id when the save sends an explicit empty string', async () => {
    const res = await callUpdate(adminForm({ ssoClientId: '' }));
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(rows.get('c1').config.ssoClientId, null);
  });

  it('drops the id when the card is switched away from EXTERNAL', async () => {
    const res = await callUpdate(adminForm({ ctaKind: 'ROUTE', ctaValue: '/user/index' }));
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(rows.get('c1').config.ssoClientId, null);
  });

  it('rejects an unknown id sent in the body instead of falling back', async () => {
    const res = await callUpdate(adminForm({ ssoClientId: 'someone-else' }));
    assert.equal(res.statusCode, 400);
    assert.match(res.body.message, /Unknown SSO client "someone-else"/);
    assert.equal(rows.get('c1').config.ssoClientId, 'tge-local');
  });
});
