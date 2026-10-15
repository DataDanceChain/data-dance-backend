/**
 * Directory items and their SSO client, on REAL Postgres (`npm run test:db`; needs
 * TEST_DATABASE_URL pointing at a throwaway, migrated database whose name contains "test").
 *
 * Through the ops campaign controller: a DIRECTORY_ITEM card naming an enabled first-party partner
 * client (SsoDeveloperClient kind "partner") is created, kept on a draft save and taken live; a
 * developer client, a disabled partner client and an unknown id are refused. The public list shows
 * the live item with its ssoClientId, the Data Planet item ahead of other directory items.
 * scripts/setCampaignSsoClient.js shows, dry-runs, writes and clears config.ssoClientId of one card
 * and refuses cards and ids it must not touch. Fixture rows carry a per-run prefix (the Data Planet
 * item uses its fixed slug) and are deleted afterwards.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required for test:db (a throwaway, migrated database)');
if (!/\/[^/?]*test[^/?]*(\?|$)/.test(url)) throw new Error('TEST_DATABASE_URL must name a database containing "test" — refusing to write fixtures anywhere else');

const RUN = `di${crypto.randomBytes(3).toString('hex')}`;
const id = (name) => `${RUN}-${name}`;
const SECRET_HASH = crypto.createHash('sha256').update('not-used').digest('hex');
const PLANET_SLUG = 'directory-planet';
const ROW_INITIATE = 'https://login.planet.example.org/ddc/start';

Object.assign(process.env, {
  DATABASE_URL: url,
  LOG_LEVEL: 'error',
  SSO_ENVIRONMENT: 'test',
  SSO_TGE_ENABLED: 'true',
  SSO_TGE_CLIENT_ID: id('env'),
  SSO_TGE_INITIATE_LOGIN_URI: 'https://tge.example.com/login/ddc',
  SSO_SESSION_SECRET: `${RUN}-session-secret`,
});

const prisma = require('../../src/utils/prisma');
const ops = require('../../src/controllers/opsCampaignController');
const { listActivePublic } = require('../../src/services/campaignEffects');
const script = require('../../scripts/setCampaignSsoClient');

const SLUGS = [PLANET_SLUG, id('other-item'), id('route-item'), id('sale'), id('home'), id('dev-card')];

function draftBody(overrides = {}) {
  return {
    slug: PLANET_SLUG,
    template: 'DIRECTORY_ITEM',
    titleEn: 'Data Planet',
    blurbEn: 'Open Data Planet.',
    startsAt: '2026-10-01T00:00:00.000Z',
    endsAt: '2099-12-31T00:00:00.000Z',
    ctaKind: 'EXTERNAL',
    ctaValue: 'https://dataplanet.cc',
    purpose: 'Partner entry in the Activities list',
    legalText: 'Opens the partner page; DataDance terms apply.',
    ...overrides,
  };
}

async function call(handler, req) {
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
  await handler({ opsAdmin: { username: 'dbtest' }, params: {}, ...req }, res);
  return res;
}

async function clientRow(name, { kind = 'partner', enabled = true, initiateLoginUri = null } = {}) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO "SsoDeveloperClient"(id, "clientId", "clientName", "contactEmail", "secretHash", "redirectUris", enabled, kind, "initiateLoginUri")
     VALUES ($1, $1, 'Data Planet', $2, $3, ARRAY['https://planet.example.org/oauth/callback']::text[], $4, $5, $6)`,
    id(name), `${RUN}@example.test`, SECRET_HASH, enabled, kind, initiateLoginUri,
  );
}

async function card(slug, overrides = {}) {
  return prisma.campaign.create({
    data: {
      slug,
      internalName: slug,
      titleEn: 'Card',
      titleZh: 'Card',
      blurbEn: 'Card',
      blurbZh: 'Card',
      template: 'DIRECTORY_ITEM',
      status: 'LIVE',
      startsAt: new Date('2026-10-01T00:00:00Z'),
      endsAt: new Date('2099-12-31T00:00:00Z'),
      ctaKind: 'EXTERNAL',
      ctaValue: 'https://dataplanet.cc/other',
      config: { shareTextEn: 'Share', i18n: { title: { en: 'Card' } } },
      createdBy: 'dbtest',
      updatedBy: 'dbtest',
      ...overrides,
    },
  });
}

const bySlug = (slug) => prisma.campaign.findUnique({ where: { slug } });
const eventsOf = async (slug) => prisma.campaignEvent.findMany({ where: { campaignId: (await bySlug(slug)).id } });
const scriptEvents = async (slug) => (await eventsOf(slug)).filter((event) => event.action === 'set-sso-client');

async function runScript(argv, opts = {}) {
  const lines = [];
  const code = await script.run(argv, { prisma, out: (line) => lines.push(line), ...opts });
  return { code, text: lines.join('\n') };
}

describe('directory items and their SSO client, on Postgres', () => {
  before(async () => {
    await prisma.campaign.deleteMany({ where: { slug: PLANET_SLUG } });
    await clientRow('planet', { initiateLoginUri: ROW_INITIATE });
    await clientRow('planet-none');
    await clientRow('paused', { enabled: false, initiateLoginUri: ROW_INITIATE });
    await clientRow('dev', { kind: 'developer', initiateLoginUri: ROW_INITIATE });
  });

  after(async () => {
    const campaigns = await prisma.campaign.findMany({ where: { slug: { in: SLUGS } }, select: { id: true } });
    const ids = campaigns.map((row) => row.id);
    await prisma.campaignEvent.deleteMany({ where: { campaignId: { in: ids } } });
    await prisma.campaign.deleteMany({ where: { id: { in: ids } } });
    await prisma.$executeRawUnsafe('DELETE FROM "SsoDeveloperClient" WHERE "clientId" LIKE $1', `${RUN}-%`);
    await prisma.$disconnect();
  });

  it('create refuses a developer client, a disabled partner client and an unknown id; nothing is stored', async () => {
    for (const clientId of [id('dev'), id('paused'), id('nobody')]) {
      const res = await call(ops.create, { body: draftBody({ ssoClientId: clientId }) });
      assert.equal(res.statusCode, 400, clientId);
      assert.match(res.body.message, new RegExp(`Unknown SSO client "${clientId}": this server only knows "${id('env')}", .*"${id('planet')}"`));
    }
    assert.equal(await bySlug(PLANET_SLUG), null);
  });

  it('create stores a directory item naming the first-party partner client', async () => {
    const res = await call(ops.create, { body: draftBody({ ssoClientId: id('planet') }) });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const row = await bySlug(PLANET_SLUG);
    assert.equal(row.template, 'DIRECTORY_ITEM');
    assert.equal(row.status, 'DRAFT');
    assert.equal(row.config.ssoClientId, id('planet'));
  });

  it('a draft save without the field keeps it, and going live re-checks and keeps it', async () => {
    const row = await bySlug(PLANET_SLUG);
    const saved = await call(ops.update, { params: { id: row.id }, body: draftBody({ titleEn: 'Data Planet!' }) });
    assert.equal(saved.statusCode, 200, JSON.stringify(saved.body));
    assert.equal((await bySlug(PLANET_SLUG)).config.ssoClientId, id('planet'));
    const live = await call(ops.transition, { params: { id: row.id }, body: { action: 'live' } });
    assert.equal(live.statusCode, 200, JSON.stringify(live.body));
    const after = await bySlug(PLANET_SLUG);
    assert.equal(after.status, 'LIVE');
    assert.equal(after.config.ssoClientId, id('planet'));
  });

  it('the public list shows the live item with its client, ahead of a newer directory item', async () => {
    await card(id('other-item'), { startsAt: new Date(Date.now() - 1000) });
    const items = (await listActivePublic()).filter((item) => SLUGS.includes(item.slug));
    assert.deepEqual(items.map((item) => item.slug), [PLANET_SLUG, id('other-item')]);
    assert.equal(items[0].template, 'DIRECTORY_ITEM');
    assert.equal(items[0].config.ssoClientId, id('planet'));
    assert.equal(items[1].config.ssoClientId, null);
  });

  it('the script shows the card and the hand-off state without writing', async () => {
    const before = await bySlug(PLANET_SLUG);
    const { code, text } = await runScript(['--slug', PLANET_SLUG]);
    assert.equal(code, 0, text);
    assert.match(text, /template: +DIRECTORY_ITEM/);
    assert.match(text, new RegExp(`before: +${id('planet')}`));
    assert.match(text, /app hand-off: available/);
    assert.equal(text.includes(SECRET_HASH), false);
    assert.equal(text.includes('@example.test'), false);
    assert.deepEqual(await bySlug(PLANET_SLUG), before);
  });

  it('the script dry run prints before and after and writes nothing', async () => {
    const before = await bySlug(PLANET_SLUG);
    const eventsBefore = (await eventsOf(PLANET_SLUG)).length;
    const { code, text } = await runScript(['--slug', PLANET_SLUG, '--client-id', id('planet-none')]);
    assert.equal(code, 0, text);
    assert.match(text, new RegExp(`after: +${id('planet-none')}`));
    assert.match(text, /app hand-off: available -> refused \(CLIENT_DISABLED\): no initiate_login_uri/);
    assert.match(text, /dry run: nothing written/);
    assert.deepEqual(await bySlug(PLANET_SLUG), before);
    assert.equal((await eventsOf(PLANET_SLUG)).length, eventsBefore);
  });

  it('--apply writes only config.ssoClientId of that card, with updatedBy and an event', async () => {
    await card(id('home'), { template: 'HOME_CARD', config: { ssoClientId: id('planet') } });
    const before = await bySlug(PLANET_SLUG);
    const otherBefore = await bySlug(id('home'));
    assert.equal((await scriptEvents(PLANET_SLUG)).length, 0);
    const { code, text } = await runScript([`--slug=${PLANET_SLUG}`, `--client-id=${id('env')}`, '--apply']);
    assert.equal(code, 0, text);
    assert.match(text, new RegExp(`written: +${id('env')}$`, 'm'));
    const after = await bySlug(PLANET_SLUG);
    assert.deepEqual(after.config, { ...before.config, ssoClientId: id('env') });
    assert.equal(after.updatedBy, 'ops-script');
    for (const key of ['status', 'titleEn', 'ctaKind', 'ctaValue', 'startsAt', 'endsAt', 'template']) {
      assert.deepEqual(after[key], before[key], key);
    }
    assert.deepEqual(await bySlug(id('home')), otherBefore, 'another card is untouched');
    const written = await scriptEvents(PLANET_SLUG);
    assert.equal(written.length, 1, 'one event for the one write');
    const [event] = written;
    assert.equal(event.actor, 'ops-script');
    assert.equal(event.note, `ssoClientId ${id('planet')} -> ${id('env')}`);
  });

  it('setting the id already stored writes nothing', async () => {
    const before = await bySlug(PLANET_SLUG);
    const events = (await scriptEvents(PLANET_SLUG)).length;
    const { code, text } = await runScript(['--slug', PLANET_SLUG, '--client-id', id('env'), '--apply']);
    assert.equal(code, 0, text);
    assert.match(text, /unchanged: nothing to write/);
    assert.deepEqual(await bySlug(PLANET_SLUG), before);
    assert.equal((await scriptEvents(PLANET_SLUG)).length, events, 'no write, no event');
  });

  it('--clear --apply removes it and keeps the rest of the config', async () => {
    const before = await bySlug(PLANET_SLUG);
    const events = (await scriptEvents(PLANET_SLUG)).length;
    const { code, text } = await runScript(['--slug', PLANET_SLUG, '--clear', '--apply']);
    assert.equal(code, 0, text);
    assert.equal((await scriptEvents(PLANET_SLUG)).length, events + 1, 'one event for the one write');
    assert.match(text, /after: +\(none\)/);
    assert.match(text, /-> none \(the card opens the plain link\)/);
    assert.deepEqual((await bySlug(PLANET_SLUG)).config, { ...before.config, ssoClientId: null });
  });

  it('refuses ids that are not accepted, with exit 1, and writes nothing', async () => {
    const before = await bySlug(PLANET_SLUG);
    const events = (await scriptEvents(PLANET_SLUG)).length;
    for (const clientId of [id('dev'), id('paused'), id('nobody'), 'tge']) {
      const { code, text } = await runScript(['--slug', PLANET_SLUG, '--client-id', clientId, '--apply']);
      assert.equal(code, 1, text);
      assert.match(text, new RegExp(`refused: Unknown SSO client "${clientId}"`));
    }
    assert.deepEqual(await bySlug(PLANET_SLUG), before);
    assert.equal((await scriptEvents(PLANET_SLUG)).length, events);
  });

  it('a card naming a developer client shows its hand-off as refused, and the id cannot be set', async () => {
    await card(id('dev-card'), { config: { ssoClientId: id('dev') } });
    const shown = await runScript(['--slug', id('dev-card')]);
    assert.equal(shown.code, 0, shown.text);
    assert.match(shown.text, new RegExp(`app hand-off: refused \\(CLIENT_DISABLED\\): client "${id('dev')}" is kind "developer"`));
    assert.equal(shown.text.includes('available'), false);
    const before = await bySlug(id('dev-card'));
    const set = await runScript(['--slug', id('dev-card'), '--client-id', id('dev'), '--apply']);
    assert.equal(set.code, 1, set.text);
    assert.match(set.text, new RegExp(`refused: Unknown SSO client "${id('dev')}"`));
    assert.deepEqual(await bySlug(id('dev-card')), before);
  });

  it('refuses a non-EXTERNAL card, a template without a client and an unknown slug', async () => {
    await card(id('route-item'), { ctaKind: 'ROUTE', ctaValue: '/user/index' });
    await card(id('sale'), { template: 'REDEEM_SALE', ctaKind: 'ROUTE', ctaValue: '/user/points', config: { percentOff: 10 } });
    for (const slug of [id('route-item'), id('sale')]) {
      const before = await bySlug(slug);
      const { code, text } = await runScript(['--slug', slug, '--client-id', id('planet'), '--apply']);
      assert.equal(code, 1, text);
      assert.match(text, /only an EXTERNAL home card or directory item hands off/);
      assert.deepEqual(await bySlug(slug), before);
    }
    const missing = await runScript(['--slug', id('nowhere'), '--client-id', id('planet')]);
    assert.equal(missing.code, 1);
    assert.match(missing.text, /no campaign with slug/);
  });

  it('a card saved while the script ran is not overwritten, and no event is written', async () => {
    const before = await bySlug(PLANET_SLUG);
    const events = (await scriptEvents(PLANET_SLUG)).length;
    const stale = {
      ssoDeveloperClient: prisma.ssoDeveloperClient,
      campaignEvent: prisma.campaignEvent,
      campaign: {
        findUnique: async (args) => {
          const row = await prisma.campaign.findUnique(args);
          return row && args.where.slug ? { ...row, updatedAt: new Date(row.updatedAt.getTime() - 1000) } : row;
        },
        updateMany: (args) => prisma.campaign.updateMany(args),
      },
      $transaction: (fn) => prisma.$transaction(fn),
    };
    const { code, text } = await runScript(['--slug', PLANET_SLUG, '--client-id', id('planet'), '--apply'], { prisma: stale });
    assert.equal(code, 1, text);
    assert.match(text, /the card changed while this ran; nothing written/);
    assert.deepEqual(await bySlug(PLANET_SLUG), before);
    assert.equal((await scriptEvents(PLANET_SLUG)).length, events);
  });

  it('when the event cannot be written, the card is not changed either', async () => {
    const before = await bySlug(PLANET_SLUG);
    const events = (await scriptEvents(PLANET_SLUG)).length;
    // Only the event writer handed to the transaction fails; one used outside it would succeed.
    const brokenEvents = { create: async () => { throw new Error('event store unavailable'); } };
    const broken = {
      ssoDeveloperClient: prisma.ssoDeveloperClient,
      campaign: prisma.campaign,
      campaignEvent: prisma.campaignEvent,
      $transaction: (fn) => prisma.$transaction((tx) => fn({ campaign: tx.campaign, campaignEvent: brokenEvents })),
    };
    const { code, text } = await runScript(['--slug', PLANET_SLUG, '--client-id', id('planet'), '--apply'], { prisma: broken });
    assert.equal(code, 3, text);
    assert.match(text, /error: event store unavailable/);
    assert.deepEqual(await bySlug(PLANET_SLUG), before);
    assert.equal((await scriptEvents(PLANET_SLUG)).length, events);
  });
});
