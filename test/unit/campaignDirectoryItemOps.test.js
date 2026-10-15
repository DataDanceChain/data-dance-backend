/**
 * Ops campaign create, update and go-live accept the SSO client id of an enabled first-party
 * partner client stored in the database (kind "partner"), next to the configured client, and still
 * refuse a developer client, a disabled partner client and an unknown id. Plus the Activities order:
 * the Data Planet directory item comes first among directory items.
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
  async findMany() {
    return [];
  },
  async create({ data }) {
    const row = { id: `c${rows.size + 1}`, ...data };
    rows.set(row.id, row);
    return { ...row };
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

const { create, update, transition } = require('../../src/controllers/opsCampaignController');
const { directoryPlanetFirst } = require('../../src/services/campaignEffects');

const savedClientId = process.env.SSO_TGE_CLIENT_ID;

function body(overrides = {}) {
  return {
    slug: 'directory-planet',
    template: 'DIRECTORY_ITEM',
    titleEn: 'Data Planet',
    blurbEn: 'Open Data Planet.',
    startsAt: '2026-10-01T00:00:00.000Z',
    endsAt: '2099-04-15T00:00:00.000Z',
    ctaKind: 'EXTERNAL',
    ctaValue: 'https://dataplanet.cc',
    purpose: 'Partner entry in the Activities list',
    legalText: 'Opens the partner page; DataDance terms apply.',
    ...overrides,
  };
}

function response() {
  return {
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
}

async function call(handler, req) {
  const res = response();
  await handler({ opsAdmin: { username: 'ops' }, params: {}, ...req }, res);
  return res;
}

async function partnerRow(clientId, { kind = 'partner', enabled = true } = {}) {
  await prisma.ssoDeveloperClient.create({
    data: { clientId, clientName: 'Data Planet', kind, enabled, redirectUris: ['https://dataplanet.cc/cb'] },
  });
}

describe('ops campaigns accept a first-party database partner client', () => {
  beforeEach(async () => {
    prisma.reset();
    rows.clear();
    events.length = 0;
    process.env.SSO_TGE_CLIENT_ID = 'tge-local';
    await partnerRow('sso_planet');
    await partnerRow('sso_paused', { enabled: false });
    await partnerRow('sso_developer', { kind: 'developer' });
  });
  afterEach(() => {
    if (savedClientId === undefined) delete process.env.SSO_TGE_CLIENT_ID;
    else process.env.SSO_TGE_CLIENT_ID = savedClientId;
  });

  it('create stores the partner client on a directory item', async () => {
    const res = await call(create, { body: body({ ssoClientId: 'sso_planet' }) });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.config.ssoClientId, 'sso_planet');
    assert.equal(res.body.data.publicCard.config.ssoClientId, 'sso_planet');
  });

  it('create still accepts the configured client', async () => {
    const res = await call(create, { body: body({ ssoClientId: 'tge-local' }) });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.config.ssoClientId, 'tge-local');
  });

  for (const [label, clientId] of [['a developer client', 'sso_developer'], ['a disabled partner client', 'sso_paused'], ['an unknown id', 'sso_nobody']]) {
    it(`create refuses ${label}`, async () => {
      const res = await call(create, { body: body({ ssoClientId: clientId }) });
      assert.equal(res.statusCode, 400);
      assert.equal(res.body.message, `Unknown SSO client "${clientId}": this server only knows "tge-local", "sso_planet"`);
      assert.equal(rows.size, 0);
    });
  }

  it('a draft save without the field keeps the stored partner client', async () => {
    rows.set('c1', { id: 'c1', status: 'DRAFT', ...body(), config: { ssoClientId: 'sso_planet' } });
    const res = await call(update, { params: { id: 'c1' }, body: body({ titleEn: 'Data Planet (new)' }) });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(rows.get('c1').titleEn, 'Data Planet (new)');
    assert.equal(rows.get('c1').config.ssoClientId, 'sso_planet');
  });

  it('a draft save is refused once that partner client is disabled', async () => {
    rows.set('c1', { id: 'c1', status: 'DRAFT', ...body(), config: { ssoClientId: 'sso_planet' } });
    await prisma.ssoDeveloperClient.update({ where: { clientId: 'sso_planet' }, data: { enabled: false } });
    const res = await call(update, { params: { id: 'c1' }, body: body() });
    assert.equal(res.statusCode, 400);
    assert.match(res.body.message, /Unknown SSO client "sso_planet"/);
  });

  for (const action of ['schedule', 'live']) {
    it(`${action} re-checks the stored partner client and keeps it`, async () => {
      rows.set('c1', { id: 'c1', status: 'DRAFT', ...body(), config: { ssoClientId: 'sso_planet' } });
      const res = await call(transition, { params: { id: 'c1' }, body: { action } });
      assert.equal(res.statusCode, 200, JSON.stringify(res.body));
      assert.equal(rows.get('c1').config.ssoClientId, 'sso_planet');
    });

    it(`${action} is refused once the stored partner client is no longer accepted`, async () => {
      rows.set('c1', { id: 'c1', status: 'DRAFT', ...body(), config: { ssoClientId: 'sso_planet' } });
      await prisma.ssoDeveloperClient.update({ where: { clientId: 'sso_planet' }, data: { enabled: false } });
      const res = await call(transition, { params: { id: 'c1' }, body: { action } });
      assert.equal(res.statusCode, 400);
      assert.equal(res.body.message, 'Unknown SSO client "sso_planet": this server only knows "tge-local"');
      assert.equal(rows.get('c1').status, 'DRAFT');
      assert.equal(events.length, 0);
    });
  }
});

describe('directoryPlanetFirst', () => {
  const row = (slug, template = 'DIRECTORY_ITEM') => ({ slug, template });
  const slugs = (rows) => rows.map((r) => r.slug);

  it('moves the Data Planet item before the other directory items, home cards keep their places', () => {
    const rows = [row('home-a', 'HOME_CARD'), row('dir-a'), row('home-b', 'HOME_CARD'), row('dir-b'), row('directory-planet')];
    assert.deepEqual(slugs(directoryPlanetFirst(rows)), ['home-a', 'directory-planet', 'dir-a', 'home-b', 'dir-b']);
  });

  it('puts it first when it is the only directory item', () => {
    const rows = [row('home-a', 'HOME_CARD'), row('home-b', 'HOME_CARD'), row('directory-planet')];
    assert.deepEqual(slugs(directoryPlanetFirst(rows)), ['directory-planet', 'home-a', 'home-b']);
  });

  it('leaves the list alone without it, and ignores that slug on another template', () => {
    const rows = [row('dir-a'), row('directory-planet', 'HOME_CARD'), row('dir-b')];
    assert.equal(directoryPlanetFirst(rows), rows);
  });
});

describe('scripts/setCampaignSsoClient.js arguments', () => {
  const { parseArgs, run, EXIT } = require('../../scripts/setCampaignSsoClient');

  it('reads --slug, --client-id, --clear and --apply in both spellings', () => {
    assert.deepEqual(parseArgs(['--slug', 'directory-planet', '--client-id=sso_planet', '--apply']), {
      slug: 'directory-planet', clientId: 'sso_planet', clear: false, apply: true,
    });
    assert.deepEqual(parseArgs(['--slug=directory-planet', '--clear']), {
      slug: 'directory-planet', clientId: null, clear: true, apply: false,
    });
  });

  for (const [label, argv] of [
    ['no slug', ['--client-id', 'sso_planet']],
    ['--client-id with --clear', ['--slug', 's', '--client-id', 'x', '--clear']],
    ['an empty --client-id', ['--slug', 's', '--client-id=']],
    ['--apply alone', ['--slug', 's', '--apply']],
    ['a missing value', ['--slug']],
    ['an unknown argument', ['--slug', 's', '--force']],
  ]) {
    it(`exits 2 with the usage line on ${label}, before reading anything`, async () => {
      const lines = [];
      const reads = { count: 0 };
      const code = await run(argv, { prisma: { campaign: { findUnique: async () => { reads.count += 1; } } }, out: (l) => lines.push(l) });
      assert.equal(code, EXIT.USAGE);
      assert.match(lines.join('\n'), /usage: node scripts\/setCampaignSsoClient\.js/);
      assert.equal(reads.count, 0);
    });
  }
});
