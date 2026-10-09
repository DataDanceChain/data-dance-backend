const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { validSlug, normalizeSlug, normalizeTarget, publicUrl } = require('../../src/services/trackedLinkPolicy');

describe('tracked links', () => {
  it('accepts a short slug and rejects spaces', () => {
    assert.equal(validSlug(normalizeSlug('Reddit')), true);
    assert.equal(normalizeSlug(' Event '), 'event');
    assert.equal(validSlug('a'), false);
    assert.equal(validSlug('has space'), false);
    assert.equal(validSlug('ok-slug'), true);
  });

  it('keeps an app link free of a target and requires https otherwise', () => {
    assert.deepEqual(normalizeTarget('app', 'https://example.com'), { url: null });
    assert.equal(normalizeTarget('page', 'http://forms.gle/abc').error, 'A https link is required');
    assert.equal(normalizeTarget('redirect', '').error, 'A https link is required');
    assert.match(normalizeTarget('page', 'https://forms.gle/9hDn2DKauL8B4NQs8').url, /^https:\/\/forms\.gle\//);
  });

  it('builds the public address from the slug', () => {
    assert.equal(publicUrl('event'), 'https://app.datadance.ai/go/event');
  });
});
