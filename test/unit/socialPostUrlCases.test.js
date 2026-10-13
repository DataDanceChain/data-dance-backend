/**
 * The canonical post-link table shared with the web client. test/fixtures/postUrlCases.json is a
 * copy of the client's table: both sides run the same cases, so a record keyed by the client and
 * the same record keyed here get the same link.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const table = require('../fixtures/postUrlCases.json');
const { socialPostUrl, extractSourceId, TITLE_BACKED_PREFIX } = require('../../src/utils/crawlerRecordIdentity');

describe('socialPostUrl runs the shared post-link table', () => {
  it('has cases for every social source and a non-social one', () => {
    const sources = new Set(table.cases.map((row) => row.source));
    for (const source of ['x', 'twitter', 'instagram', 'threads', 'tiktok', 'amazon']) {
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
