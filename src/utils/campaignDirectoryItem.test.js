const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  TEMPLATES,
  campaignSsoClientIds,
  ssoClientIdProblem,
  parseDraft,
  toPublicCard,
  validateCta,
} = require('./campaignRules');

const PLANET = 'sso_planet-row';
const saved = process.env.SSO_TGE_CLIENT_ID;

function item(overrides = {}) {
  return {
    slug: 'directory-planet',
    template: 'DIRECTORY_ITEM',
    titleEn: 'Data Planet',
    blurbEn: 'Open Data Planet.',
    startsAt: '2026-10-01T00:00:00.000Z',
    endsAt: '2027-04-15T00:00:00.000Z',
    ctaKind: 'EXTERNAL',
    ctaValue: 'https://dataplanet.cc',
    ...overrides,
  };
}

function itemRow(overrides = {}) {
  return {
    id: 'd1',
    slug: 'directory-planet',
    template: 'DIRECTORY_ITEM',
    titleEn: 'Data Planet',
    titleZh: 'Data Planet',
    blurbEn: 'b',
    blurbZh: 'b',
    pillEn: 'Live',
    pillZh: null,
    startsAt: new Date('2026-10-01T00:00:00.000Z'),
    endsAt: new Date('2027-04-15T00:00:00.000Z'),
    ctaKind: 'EXTERNAL',
    ctaValue: 'https://dataplanet.cc',
    coverImageUrl: null,
    config: { shareTextEn: null, shareTextZh: null, ssoClientId: PLANET, i18n: { title: { en: 'Data Planet' } } },
    ...overrides,
  };
}

describe('DIRECTORY_ITEM campaigns', () => {
  beforeEach(() => {
    process.env.SSO_TGE_CLIENT_ID = 'tge-local';
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.SSO_TGE_CLIENT_ID;
    else process.env.SSO_TGE_CLIENT_ID = saved;
  });

  it('is a known template, parsed like a home card', () => {
    assert.equal(TEMPLATES.has('DIRECTORY_ITEM'), true);
    const parsed = parseDraft(item({ shareTextEn: 'Share me', coverImageUrl: '/assets/campaigns/planet.png' }));
    assert.equal(parsed.error, undefined);
    assert.equal(parsed.data.template, 'DIRECTORY_ITEM');
    assert.equal(parsed.data.ctaKind, 'EXTERNAL');
    assert.equal(parsed.data.ctaValue, 'https://dataplanet.cc');
    assert.equal(parsed.data.coverImageUrl, '/assets/campaigns/planet.png');
    assert.equal(parsed.data.config.shareTextEn, 'Share me');
    assert.equal(parsed.data.config.ssoClientId, null);
  });

  it('applies the home card link rules', () => {
    assert.equal(parseDraft(item({ ctaValue: 'http://dataplanet.cc' })).error, 'External links must use https');
    assert.equal(parseDraft(item({ ctaValue: 'https://example.com' })).error, 'That external host is not allowed');
    assert.equal(parseDraft(item({ ctaKind: 'ROUTE', ctaValue: '/user/index' })).error, undefined);
  });

  it('allows dataplanet.cc and its subdomains as external hosts, and nothing that only ends like it', () => {
    assert.equal(validateCta('EXTERNAL', 'https://dataplanet.cc'), null);
    assert.equal(validateCta('EXTERNAL', 'https://www.dataplanet.cc/pages/x'), null);
    assert.equal(validateCta('EXTERNAL', 'https://notdataplanet.cc'), 'That external host is not allowed');
    assert.equal(validateCta('EXTERNAL', 'https://dataplanet.cc.example.com'), 'That external host is not allowed');
    assert.equal(parseDraft(item({ coverImageUrl: 'https://dataplanet.cc/cover.png' })).error, undefined);
  });

  it('stores the configured client id, trimmed', () => {
    assert.equal(parseDraft(item({ ssoClientId: ' tge-local ' })).data.config.ssoClientId, 'tge-local');
  });

  it('the public card carries the home card config, including ssoClientId and i18n', () => {
    const card = toPublicCard(itemRow());
    assert.equal(card.template, 'DIRECTORY_ITEM');
    assert.deepEqual(card.config, {
      shareTextEn: null,
      shareTextZh: null,
      ssoClientId: PLANET,
      i18n: { title: { en: 'Data Planet' } },
    });
  });

  it('the public card has no ssoClientId for a non-EXTERNAL item, or a blank one', () => {
    assert.equal(toPublicCard(itemRow({ ctaKind: 'ROUTE', ctaValue: '/user/index' })).config.ssoClientId, null);
    assert.equal(toPublicCard(itemRow({ config: { ssoClientId: '   ' } })).config.ssoClientId, null);
  });
});

describe('campaignSsoClientIds', () => {
  it('lists the configured client first, then the first-party database clients', () => {
    assert.deepEqual(campaignSsoClientIds([PLANET, 'sso_other'], { SSO_TGE_CLIENT_ID: 'tge-local' }), ['tge-local', PLANET, 'sso_other']);
  });

  it('drops retired ids, blanks and repeats', () => {
    assert.deepEqual(
      campaignSsoClientIds(['tge', ' ', PLANET, `${PLANET} `, 'tge-rehearsal', null], { SSO_TGE_CLIENT_ID: 'tge' }),
      [PLANET],
    );
  });

  it('is empty when nothing is configured', () => {
    assert.deepEqual(campaignSsoClientIds([], {}), []);
  });

  it('reads SSO_TGE_CLIENT_ID from process.env by default', () => {
    process.env.SSO_TGE_CLIENT_ID = 'tge-default';
    try {
      assert.deepEqual(campaignSsoClientIds(), ['tge-default']);
    } finally {
      if (saved === undefined) delete process.env.SSO_TGE_CLIENT_ID;
      else process.env.SSO_TGE_CLIENT_ID = saved;
    }
  });
});

describe('parseDraft options.ssoClientIds', () => {
  const accepted = ['tge-local', PLANET];

  beforeEach(() => {
    process.env.SSO_TGE_CLIENT_ID = 'tge-local';
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.SSO_TGE_CLIENT_ID;
    else process.env.SSO_TGE_CLIENT_ID = saved;
  });

  it('accepts a first-party database client on a directory item and on a home card', () => {
    assert.equal(parseDraft(item({ ssoClientId: PLANET }), { ssoClientIds: accepted }).data.config.ssoClientId, PLANET);
    const home = item({ slug: 'planet-home', template: 'HOME_CARD', ssoClientId: PLANET });
    assert.equal(parseDraft(home, { ssoClientIds: accepted }).data.config.ssoClientId, PLANET);
  });

  it('keeps accepting the configured client', () => {
    assert.equal(parseDraft(item({ ssoClientId: 'tge-local' }), { ssoClientIds: accepted }).data.config.ssoClientId, 'tge-local');
  });

  it('refuses an id that is not in the list (a developer client), naming the accepted ids', () => {
    const parsed = parseDraft(item({ ssoClientId: 'sso_developer' }), { ssoClientIds: accepted });
    assert.equal(parsed.error, `Unknown SSO client "sso_developer": this server only knows "tge-local", "${PLANET}"`);
  });

  it('refuses a retired id even if a caller lists it', () => {
    assert.match(parseDraft(item({ ssoClientId: 'tge' }), { ssoClientIds: ['tge', PLANET] }).error, /Unknown SSO client "tge"/);
  });

  it('without the option only the configured client is accepted', () => {
    assert.match(parseDraft(item({ ssoClientId: PLANET })).error, /this server only knows "tge-local"$/);
  });

  it('with an empty list nothing is accepted', () => {
    assert.match(parseDraft(item({ ssoClientId: PLANET }), { ssoClientIds: [] }).error, /no partner SSO client is configured/);
  });

  it('ssoClientIdProblem is empty for an accepted id', () => {
    assert.equal(ssoClientIdProblem(PLANET, accepted), '');
    assert.match(ssoClientIdProblem('x'.repeat(80), accepted), new RegExp(`"${'x'.repeat(64)}"`));
  });
});
