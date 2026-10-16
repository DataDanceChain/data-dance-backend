/**
 * A post row may carry the canonical link instead of the link the platform showed (the web client
 * keys records by it). Every canonical form in the shared table reads back as itself, and a row
 * with the canonical link gets the same record key and content hash as one with the original.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const table = require('../fixtures/postUrlCases.json');
const { socialPostUrl, extractSourceId } = require('../../src/utils/crawlerRecordIdentity');
const { generateContentHash } = require('../../src/services/crawlerService');

const posts = table.cases.filter((row) => row.canonical);

describe('socialPostUrl reads its own canonical forms', () => {
  it('the table has canonical-input rows for every social source', () => {
    const inputs = new Set(posts.filter((row) => row.href === row.canonical).map((row) => row.source));
    for (const source of ['x', 'instagram', 'threads', 'tiktok', 'facebook']) assert.ok(inputs.has(source), source);
    const forms = new Set(posts.filter((row) => row.href === row.canonical).map((row) => new URL(row.href).pathname.split('/')[1]));
    for (const form of ['i', 'p', 'post', 'video', 'photo']) assert.ok(forms.has(form), form);
  });

  it('the table has a canonical-input row for every Facebook form', () => {
    const form = (href) => {
      const parts = new URL(href).pathname.split('/').filter(Boolean);
      return parts[1] === 'posts' || parts[1] === 'videos' ? parts[1] : parts[0];
    };
    const forms = new Set(posts.filter((row) => row.source === 'facebook' && row.href === row.canonical).map((row) => form(row.href)));
    for (const name of ['posts', 'videos', 'reel', 'share', 'permalink.php', 'story.php', 'photo.php', 'watch']) {
      assert.ok(forms.has(name), name);
    }
  });

  for (const { source, href, canonical } of posts) {
    it(`${source} ${canonical} (from ${href})`, () => {
      assert.equal(socialPostUrl(source, { href: canonical }), canonical);
      for (const field of ['id', 'orderId', 'orderid']) {
        assert.equal(socialPostUrl(source, { [field]: canonical }), canonical, field);
      }
      assert.equal(extractSourceId(source, { href: canonical }), extractSourceId(source, { href }));
      assert.equal(
        generateContentHash({ href: canonical, title: 'later caption' }, { source, userId: 'u1' }),
        generateContentHash({ href, title: 'first caption' }, { source, userId: 'u1' }),
      );
    });
  }

  it('a canonical link of another platform is not a post of this source', () => {
    assert.equal(socialPostUrl('instagram', { href: 'https://threads.net/post/DAbc123x' }), '');
    assert.equal(socialPostUrl('threads', { href: 'https://tiktok.com/video/7312345678901234567' }), '');
    assert.equal(socialPostUrl('tiktok', { href: 'https://x.com/i/status/1845000000000000001' }), '');
    assert.equal(socialPostUrl('amazon', { href: 'https://tiktok.com/photo/7312345678901234568' }), '');
    assert.equal(socialPostUrl('instagram', { href: 'https://facebook.com/reel/99887766' }), '');
    assert.equal(socialPostUrl('facebook', { href: 'https://instagram.com/p/ABC123def' }), '');
  });
});
