const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { parseDraft, toPublicCard } = require('./campaignRules');

const ENV_KEYS = ['SSO_TGE_CLIENT_ID'];
const saved = {};

function draft(overrides = {}) {
  return {
    slug: 'tge-partner-login',
    template: 'HOME_CARD',
    titleEn: 'Partner login',
    blurbEn: 'Open the partner page already signed in.',
    startsAt: '2026-09-01T00:00:00.000Z',
    endsAt: '2026-10-01T00:00:00.000Z',
    ctaKind: 'EXTERNAL',
    ctaValue: 'https://tge.datadance.ai/login',
    shareTextEn: 'Share me',
    shareTextZh: '分享',
    ...overrides,
  };
}

function homeRow(overrides = {}) {
  return {
    id: 'c1',
    slug: 'tge-partner-login',
    template: 'HOME_CARD',
    titleEn: 'Partner login',
    titleZh: '合作方登录',
    blurbEn: 'b',
    blurbZh: 'b',
    pillEn: null,
    pillZh: null,
    startsAt: new Date('2026-09-01T00:00:00.000Z'),
    endsAt: new Date('2026-10-01T00:00:00.000Z'),
    ctaKind: 'EXTERNAL',
    ctaValue: 'https://tge.datadance.ai/login',
    coverImageUrl: null,
    config: { shareTextEn: 'Share me', shareTextZh: '分享', ssoClientId: 'tge-local' },
    ...overrides,
  };
}

describe('HOME_CARD ssoClientId (parse)', () => {
  beforeEach(() => {
    ENV_KEYS.forEach((key) => {
      saved[key] = process.env[key];
    });
    process.env.SSO_TGE_CLIENT_ID = 'tge-local';
  });
  afterEach(() => {
    ENV_KEYS.forEach((key) => {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    });
  });

  it('accepts the configured partner client id on an EXTERNAL card, trimmed', () => {
    const parsed = parseDraft(draft({ ssoClientId: '  tge-local  ' }));
    assert.equal(parsed.error, undefined);
    assert.equal(parsed.data.config.ssoClientId, 'tge-local');
  });

  it('accepts the production id when that is the configured client', () => {
    process.env.SSO_TGE_CLIENT_ID = 'sso-rehearsal';
    const parsed = parseDraft(draft({ ssoClientId: 'sso-rehearsal' }));
    assert.equal(parsed.data.config.ssoClientId, 'sso-rehearsal');
  });

  it('rejects the retired client id even when the environment still names it', () => {
    process.env.SSO_TGE_CLIENT_ID = 'tge';
    const parsed = parseDraft(draft({ ssoClientId: 'tge' }));
    assert.match(parsed.error, /no partner SSO client is configured/);
  });

  it('keeps an id already stored in config (schedule / go-live re-parse the existing row)', () => {
    const parsed = parseDraft(draft({ config: { ssoClientId: 'tge-local' } }));
    assert.equal(parsed.data.config.ssoClientId, 'tge-local');
  });

  it('rejects an id this server does not know with a clear message', () => {
    const parsed = parseDraft(draft({ ssoClientId: 'tge' }));
    assert.match(parsed.error, /Unknown SSO client "tge": this server only knows "tge-local"/);
  });

  it('rejects any id when no partner client is configured', () => {
    delete process.env.SSO_TGE_CLIENT_ID;
    const parsed = parseDraft(draft({ ssoClientId: 'tge-local' }));
    assert.match(parsed.error, /no partner SSO client is configured/);
  });

  it('stores null for an empty or missing id', () => {
    assert.equal(parseDraft(draft({ ssoClientId: '   ' })).data.config.ssoClientId, null);
    assert.equal(parseDraft(draft()).data.config.ssoClientId, null);
  });

  it('drops the id for non-EXTERNAL cards, even an unknown one', () => {
    const route = parseDraft(draft({ ctaKind: 'ROUTE', ctaValue: '/user/index', ssoClientId: 'tge-local' }));
    assert.equal(route.data.config.ssoClientId, null);
    const bogus = parseDraft(draft({ ctaKind: 'ROUTE', ctaValue: '/user/index', ssoClientId: 'nope' }));
    assert.equal(bogus.error, undefined);
    assert.equal(bogus.data.config.ssoClientId, null);
  });

  it('leaves the share text fields unchanged', () => {
    const { config } = parseDraft(draft({ ssoClientId: 'tge-local' })).data;
    assert.equal(config.shareTextEn, 'Share me');
    assert.equal(config.shareTextZh, '分享');
    assert.equal(config.shareTextJa, null);
    assert.equal(config.shareTextZhTw, null);
  });
});

describe('HOME_CARD ssoClientId (public card)', () => {
  it('exposes ssoClientId on an EXTERNAL home card next to the share text', () => {
    assert.deepEqual(toPublicCard(homeRow()).config, {
      shareTextEn: 'Share me',
      shareTextZh: '分享',
      ssoClientId: 'tge-local',
    });
  });

  it('is null for a non-EXTERNAL home card even when config carries one', () => {
    const card = toPublicCard(homeRow({ ctaKind: 'ROUTE', ctaValue: '/user/index' }));
    assert.equal(card.config.ssoClientId, null);
  });

  it('is null when the card has no id stored', () => {
    const card = toPublicCard(homeRow({ config: { shareTextEn: 'Share me' } }));
    assert.deepEqual(card.config, { shareTextEn: 'Share me', shareTextZh: null, ssoClientId: null });
  });

  it('does not add ssoClientId to other templates', () => {
    const card = toPublicCard(
      homeRow({ template: 'REDEEM_SALE', ctaKind: 'ROUTE', config: { percentOff: 10, ssoClientId: 'tge-local' } }),
    );
    assert.deepEqual(card.config, { percentOff: 10 });
  });
});
