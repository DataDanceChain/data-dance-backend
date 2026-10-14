/**
 * The canonical post-link table shared with the web client. test/fixtures/postUrlCases.json is a
 * copy of the client's table: both sides run the same cases, so a record keyed by the client and
 * the same record keyed here get the same link.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const table = require('../fixtures/postUrlCases.json');
const {
  socialPostUrl,
  extractSourceId,
  isFacebookLink,
  officialRecordId,
  TITLE_BACKED_PREFIX,
} = require('../../src/utils/crawlerRecordIdentity');

describe('socialPostUrl runs the shared post-link table', () => {
  it('has cases for every social source and a non-social one', () => {
    const sources = new Set(table.cases.map((row) => row.source));
    for (const source of ['x', 'twitter', 'instagram', 'threads', 'tiktok', 'facebook', 'amazon']) {
      assert.ok(sources.has(source), source);
    }
  });

  for (const { source, href, canonical } of table.cases) {
    it(`${source} ${href}`, () => {
      assert.equal(socialPostUrl(source, { href }), canonical);
    });
  }

  it('keys a post record by its canonical link, the same key for every copy of the link', () => {
    for (const { source, href, canonical } of table.cases) {
      if (!canonical) continue;
      assert.equal(extractSourceId(source, { href }), `${TITLE_BACKED_PREFIX}post:${canonical}`, href);
    }
  });
});

describe('isFacebookLink runs the shared Facebook-link list', () => {
  it('has links on a Facebook host and links that are not', () => {
    assert.ok(table.facebookLinks.some((row) => row.facebook));
    assert.ok(table.facebookLinks.some((row) => !row.facebook));
  });

  for (const { value, facebook } of table.facebookLinks) {
    it(`${facebook ? 'Facebook' : 'not Facebook'}: ${JSON.stringify(value)}`, () => {
      assert.equal(isFacebookLink(value), facebook);
      // a Facebook link is never a Facebook row's order id; anything else may be
      const id = officialRecordId('facebook', { orderId: value });
      assert.equal(id, facebook || !value.trim() ? null : value.trim());
    });
  }
});
