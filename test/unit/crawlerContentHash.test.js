const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { generateContentHash } = require('../../src/services/crawlerService');
const {
  extractSourceId,
  hasRecordIdentity,
  isTitleBackedSourceId,
  socialPostUrl,
} = require('../../src/utils/crawlerRecordIdentity');

const ALICE = 'user-alice';
const BOB = 'user-bob';
const hash = (source, payload, userId = ALICE) => generateContentHash(payload, { source, userId });

describe('social post content hash', () => {
  it('treats a changed like count as the same Instagram post', () => {
    const first = hash('instagram', {
      id: 'https://www.instagram.com/p/ABC123def/comments/?hl=en',
      title: '1,204 赞 36 评论 Sunset over the bay',
      caption: 'Sunset over the bay',
    });
    const later = hash('instagram', {
      href: 'https://instagram.com/p/ABC123def/',
      title: '1,299 赞 40 评论 Sunset over the bay',
      caption: 'Sunset over the bay',
    });
    const other = hash('instagram', {
      href: 'https://www.instagram.com/reel/Other999/',
      title: 'Morning coffee',
    });

    assert.equal(first, later);
    assert.notEqual(first, other);

    const sourceId = extractSourceId('instagram', {
      href: 'https://www.instagram.com/p/ABC123def/comments/?hl=en',
      title: '1,299 赞 Sunset over the bay',
    }, { host: 'instagram.com' });
    assert.equal(isTitleBackedSourceId(sourceId), true);
    assert.match(sourceId, /instagram\.com\/p\/ABC123def$/);
  });

  it('gives two users who saw the same post a record each', () => {
    const post = { href: 'https://x.com/DataDance/status/1845000000000000001', title: 'Launch day' };
    assert.notEqual(hash('x', post, ALICE), hash('x', post, BOB));
    assert.equal(hash('x', post, ALICE), hash('x', { ...post, title: 'Launch day 12 likes' }, ALICE));
    // The per-user source id is the same string; the unique key (userId, source, sourceId) separates them.
    assert.ok(isTitleBackedSourceId(extractSourceId('x', post, {})));
  });

  it('still hashes shop orders by their payload', () => {
    const one = hash('shein', { orderId: 'SO-1', title: 'Linen shirt' });
    const two = hash('shein', { orderId: 'SO-1', title: 'Tea towel' });
    assert.notEqual(one, two);
  });

  it('without a user id a social row falls back to the payload hash', () => {
    const post = { href: 'https://x.com/a/status/1', title: 'One' };
    assert.equal(
      generateContentHash(post, { source: 'x' }),
      generateContentHash(post),
    );
  });
});

describe('X permalinks are one post across hosts and handle spelling', () => {
  const variants = [
    'https://x.com/DataDance/status/1845000000000000001',
    'https://x.com/datadance/status/1845000000000000001?s=20',
    'https://twitter.com/DATADANCE/status/1845000000000000001',
    'https://mobile.twitter.com/datadance/status/1845000000000000001/photo/1',
    'https://www.twitter.com/datadance/status/1845000000000000001#reply',
    'https://mobile.x.com/datadance/status/1845000000000000001',
    'https://x.com/i/web/status/1845000000000000001',
    'http://twitter.com/datadance/statuses/1845000000000000001',
  ];

  it('canonicalizes every variant to the status id', () => {
    for (const href of variants) {
      assert.equal(socialPostUrl('x', { href }), 'https://x.com/i/status/1845000000000000001', href);
    }
  });

  it('gives every variant one source id and one hash', () => {
    const ids = new Set(variants.map((href) => extractSourceId('x', { href, title: 'Launch' }, { host: 'x.com' })));
    const hashes = new Set(variants.map((href) => hash('x', { href, title: 'Launch' })));
    assert.equal(ids.size, 1);
    assert.equal(hashes.size, 1);
  });

  it('accepts the twitter alias as the source', () => {
    assert.equal(socialPostUrl('twitter', { href: variants[0] }), 'https://x.com/i/status/1845000000000000001');
  });

  it('matches only the platform hosts themselves', () => {
    for (const href of [
      'https://netflix.com/a/status/1',
      'https://evilx.com/a/status/1',
      'https://x.com.example.net/a/status/1',
      'https://example.com/redirect?u=https://x.com/a/status/1',
      'https://example.com/x.com/a/status/1',
      'javascript://x.com/a/status/1',
      'x.com/a/status/1',
      'https://x.com/a/status/not-a-number',
      'https://x.com/status/1',
    ]) {
      assert.equal(socialPostUrl('x', { href }), '', href);
    }
  });

  it('a post on another platform is not this platform\'s post', () => {
    assert.equal(socialPostUrl('instagram', { href: variants[0] }), '');
    assert.equal(socialPostUrl('x', { href: 'https://www.instagram.com/p/ABC123def/' }), '');
  });
});

describe('other social permalinks', () => {
  it('Instagram: /p/, /reel/ and a handle prefix are one post; shortcode case is kept', () => {
    const forms = [
      'https://www.instagram.com/p/ABC123def/',
      'https://instagram.com/reel/ABC123def/?igsh=1',
      'https://www.instagram.com/someone/p/ABC123def/comments/',
      'https://m.instagram.com/reels/ABC123def',
    ];
    for (const href of forms) assert.equal(socialPostUrl('instagram', { href }), 'https://instagram.com/p/ABC123def', href);
    assert.notEqual(socialPostUrl('instagram', { href: 'https://instagram.com/p/abc123DEF/' }), 'https://instagram.com/p/ABC123def');
  });

  it('Threads: .net and .com, any handle spelling', () => {
    assert.equal(socialPostUrl('threads', { href: 'https://www.threads.com/@DataDance/post/DAbc123x' }), 'https://threads.net/post/DAbc123x');
    assert.equal(socialPostUrl('threads', { href: 'https://threads.net/@datadance/post/DAbc123x?xmt=1' }), 'https://threads.net/post/DAbc123x');
  });

  it('TikTok: the video id', () => {
    assert.equal(
      socialPostUrl('tiktok', { href: 'https://www.tiktok.com/@DataDance/video/7312345678901234567?lang=en' }),
      'https://tiktok.com/video/7312345678901234567',
    );
  });

  it('a social source without a permalink keeps its title identity', () => {
    const sourceId = extractSourceId('x', { title: 'Launch day', date: '2026-10-01' }, { host: 'x.com' });
    assert.equal(sourceId, 'title:x.com:launch day:2026-10-01');
    assert.equal(socialPostUrl('facebook', { href: 'https://x.com/a/status/1' }), '');
  });
});

describe('a non-social order keeps its own identity whatever links it holds', () => {
  const amazonOrder = '112-1234567-1234567';

  it('Amazon keeps its official order id and payload hash', () => {
    const withLinks = [
      'https://x.com/a/status/1',
      'https://x.com/a/status/2',
      'https://www.instagram.com/p/ABC123def/',
    ].map((href) => ({ orderid: amazonOrder, title: 'Desk lamp', href }));
    for (const payload of withLinks) {
      assert.equal(socialPostUrl('amazon', payload), '');
      assert.equal(extractSourceId('amazon', payload, {}), amazonOrder);
    }
    // The hash stays the payload hash (the global official id is what rejects a second claim).
    assert.equal(hash('amazon', withLinks[0]), generateContentHash(withLinks[0]));
  });

  it('Luma / Airbnb / Booking and shop rows keep their official ids', () => {
    assert.equal(extractSourceId('luma', { eventId: 'evt-1', href: 'https://x.com/a/status/1' }, {}), 'evt-1');
    assert.equal(extractSourceId('airbnb', { tripId: 'trip-1', id: 'https://x.com/a/status/1' }, {}), 'trip-1');
    assert.equal(extractSourceId('booking', { bookingId: 'bk-1', href: 'https://twitter.com/a/status/9' }, {}), 'bk-1');
    assert.equal(extractSourceId('shein', { orderId: 'SO-1', href: 'https://x.com/a/status/1' }, {}), 'SO-1');
  });

  it('a non-social row with only a social link has no record identity from it', () => {
    assert.equal(hasRecordIdentity('amazon', { href: 'https://x.com/a/status/1' }), false);
    assert.equal(hasRecordIdentity('x', { href: 'https://x.com/a/status/1' }), true);
  });
});
