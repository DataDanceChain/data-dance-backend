/**
 * Record identity backfill (scripts/backfillSocialPostIdentity.js, part 2), pure parts: which
 * stored rows hold the previous release's post link key, the identity each record gets back, and
 * which copy keeps it; and part 1's claims across pages. The database side is in
 * test/db/crawlerPostIdentity.dbtest.js.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const { generateContentHash } = require('../../src/services/crawlerService');
const { socialPostUrl } = require('../../src/utils/crawlerRecordIdentity');
const {
  legacyLinkKey,
  isRecordLinkKeyRow,
  recordIdentity,
  planRecord,
  supersededIdentity,
  SUPERSEDED_PREFIX,
  CERTAIN_PERMALINK_SQL,
  parseArgs,
  backfillSocialPostIdentity,
} = require('../../scripts/backfillSocialPostIdentity');

const amazonMeta = { sourceUrl: 'https://www.amazon.com/gp/css/order-history' };
const amazon = (orderid, href, sourceId) => ({
  id: `row-${orderid}-${href || 'plain'}`,
  userId: 'user-b',
  source: 'amazon',
  metadata: amazonMeta,
  payload: { orderid, title: 'Desk lamp', price: '12.00', currency: 'USD', ...(href ? { href } : {}) },
  sourceId,
});

describe('previous release post link key', () => {
  it('rebuilds the stored key for each social link form', () => {
    const cases = [
      ['https://x.com/someone/status/222?s=20', 'title:amazon.com:https://x.com/someone/status/222'],
      ['https://www.instagram.com/p/AbC123/', 'title:amazon.com:https://instagram.com/p/AbC123'],
      ['https://www.threads.net/@h/post/XyZ9', 'title:amazon.com:https://threads.net/@h/post/XyZ9'],
      ['https://www.tiktok.com/@h/video/1001', 'title:amazon.com:https://tiktok.com/@h/video/1001'],
      ['x.com/someone/status/7', 'title:amazon.com:x.com/someone/status/7'],
    ];
    for (const [href, key] of cases) assert.equal(legacyLinkKey(amazon('111-1', href)), key, href);
  });

  it('has no key for a row without a social link', () => {
    assert.equal(legacyLinkKey(amazon('111-1')), '');
    assert.equal(legacyLinkKey(amazon('111-1', 'https://www.amazon.com/gp/product/B000')), '');
  });

  it('picks only non-social rows still stored under that key', () => {
    const link = 'https://x.com/someone/status/222';
    assert.equal(isRecordLinkKeyRow(amazon('111-1', link, 'title:amazon.com:https://x.com/someone/status/222')), true);
    // stored under the order id, or under a title key that is not the link key
    assert.equal(isRecordLinkKeyRow(amazon('111-1', link, '111-1')), false);
    assert.equal(isRecordLinkKeyRow(amazon('111-1', link, 'title:amazon.com:desk lamp:')), false);
    assert.equal(isRecordLinkKeyRow(amazon('111-1', link, null)), false);
    // a social post is part 1's
    const post = {
      userId: 'user-a', source: 'x', metadata: { sourceUrl: 'https://x.com/' },
      payload: { href: 'https://x.com/ddc/status/500', caption: 'hello' },
      sourceId: 'title:x.com:https://x.com/ddc/status/500',
    };
    assert.equal(isRecordLinkKeyRow(post), false);
    // a social-catalog source without a permalink identity is a record
    const reddit = {
      userId: 'user-c', source: 'reddit', metadata: { sourceUrl: 'https://www.reddit.com/user/me/submitted/' },
      payload: { title: 'A thread', href: 'https://x.com/a/status/9' },
      sourceId: 'title:reddit.com:https://x.com/a/status/9',
    };
    assert.equal(isRecordLinkKeyRow(reddit), true);
  });

  it('rebuilds the key with the host named in the metadata', () => {
    const link = 'https://x.com/someone/status/222';
    for (const host of ['post', 'superseded']) {
      const row = { ...amazon('111-1', link, `title:${host}:${link}`), metadata: { ...amazonMeta, host } };
      assert.equal(legacyLinkKey(row), `title:${host}:${link}`);
      assert.equal(isRecordLinkKeyRow(row), true, host);
    }
  });

  it('picks a social row whose link is not a post permalink', () => {
    const redirect = (host, link) => ({
      userId: 'user-d', source: 'x', metadata: { sourceUrl: 'https://x.com/home', ...(host ? { host } : {}) },
      payload: { href: `${link}?u=https://x.com/a/status/1`, title: 'Morning run' },
      sourceId: `title:${host || 'x.com'}:${link}`,
    });
    assert.equal(isRecordLinkKeyRow(redirect('', 'https://t.co/r')), true);
    assert.equal(isRecordLinkKeyRow(redirect('post', 'https://t.co/r')), true);
    assert.equal(recordIdentity(redirect('', 'https://t.co/r')).sourceId, 'title:x.com:morning run:');
  });
});

describe('social rows the candidate query skips', () => {
  // The SQL patterns, read the way Postgres reads them (~*: case-insensitive, '.' matches newline).
  const certain = (source, text) =>
    Buffer.byteLength(text) <= 2048 &&
    new RegExp(CERTAIN_PERMALINK_SQL[source === 'twitter' ? 'x' : source], 'is').test(text);
  const sources = ['x', 'twitter', 'instagram', 'threads', 'tiktok', 'facebook'];
  const hosts = [
    'x.com', 'twitter.com', 'www.x.com', 'mobile.twitter.com', 'm.x.com', 'www.m.x.com', 'X.COM', 'x.com.evil.example',
    'instagram.com', 'www.instagram.com', 'threads.net', 'threads.com', 'www.threads.net', 'tiktok.com', 'm.tiktok.com',
    'evil.example', 't.co', 'x.com:443', 'user@x.com',
    'facebook.com', 'www.facebook.com', 'm.facebook.com', 'web.facebook.com', 'fb.com', 'facebook.com.evil.example',
    'notfacebook.com', 'facebook.com:443', 'user@facebook.com',
  ];
  const paths = [
    '/someone/status/1845', '/i/web/status/1845', '/someone/statuses/1845', '/status/status/1845', '/someone/status/abc',
    '/someone/status/1845/photo/1', '/someone/status/1845/../../b', '/a/../status/1845', '/./status/1845', '/%2e%2e/status/1845',
    '/p/AbC123', '/reel/AbC1_-x', '/reels/AbCd', '/tv/AbC', '/handle/p/AbC123', '/reel/p/AbC123', '/p/AbC123/../x',
    '/@h/post/XyZ9', '/h/post/XyZ9', '/../post/XyZ9', '/post/post/XyZ9', '/@h/post/XyZ', '/@a.b/post/XyZ9a',
    '/@h/video/1001', '/@h/photo/1001', '/h/video/1001', '/@../video/1001', '/@h/video/10x',
    '/jane.doe/posts/pfbid0Ab', '/jane.doe/posts/pfbid0Ab/x', '/posts/posts/Ab12', '/jane.doe/posts/Ab1', '/posts/Ab12',
    '/../posts/Ab12', '/./posts/Ab12', '/a./posts/Ab12', '/.a/posts/Ab12', '/jane.doe/posts/Ab12/../../x', '/a/posts/Ab%2012',
    `/a/posts/${'b'.repeat(200)}`, `/a/posts/${'b'.repeat(201)}`, '/a/videos/Ab12', '/reel/Ab12',
    '', '/', '//someone/status/1845',
  ];
  const tails = ['', '/', '?s=20', '#frag', '/?x=1#y', '?q=' + 'a'.repeat(2100), '\n', ' ', '/x y'];
  const schemes = ['https://', 'http://', 'HTTPS://', 'ftp://', 'https:/', ' https://'];

  it('every link they match is a permalink of that platform (no false skip)', () => {
    let matched = 0;
    for (const source of sources) {
      for (const scheme of schemes) {
        for (const host of hosts) {
          for (const path of paths) {
            for (const tail of tails) {
              const href = `${scheme}${host}${path}${tail}`;
              if (!certain(source, href)) continue;
              matched += 1;
              for (const field of ['href', 'id', 'orderId', 'orderid']) {
                assert.notEqual(socialPostUrl(source, { [field]: href }), '', `${source} ${field} ${JSON.stringify(href)}`);
              }
            }
          }
        }
      }
    }
    assert.ok(matched > 100, `only ${matched} links matched`);
  });

  it('match the usual permalink of each platform', () => {
    assert.ok(certain('x', 'https://x.com/DataDance/status/1845000000000000001?s=20'));
    assert.ok(certain('twitter', 'https://twitter.com/DataDance/status/1845000000000000001'));
    assert.ok(certain('instagram', 'https://www.instagram.com/p/AbC123/'));
    assert.ok(certain('threads', 'https://www.threads.net/@h/post/XyZ9'));
    assert.ok(certain('tiktok', 'https://www.tiktok.com/@h/video/1001'));
    assert.ok(certain('facebook', 'https://www.facebook.com/jane.doe/posts/pfbid0SaturdayMarket?__tn__=R'));
    // other Facebook forms are decided in code
    assert.equal(certain('facebook', 'https://www.facebook.com/permalink.php?story_fbid=pfbid0Harbour&id=1'), false);
    // a redirect link, or another platform's link, is left to the code
    assert.equal(certain('x', 'https://t.co/r?u=https://x.com/a/status/1'), false);
    assert.equal(certain('x', 'https://www.instagram.com/p/AbC123/'), false);
  });
});

describe('identity a record gets back', () => {
  it('an order id, one record per source across users', () => {
    const target = recordIdentity(amazon('111-1', 'https://x.com/a/status/1'));
    assert.equal(target.kind, 'order');
    assert.equal(target.sourceId, '111-1');
    assert.equal(target.scope, recordIdentity({ ...amazon('111-1', 'https://x.com/b/status/2'), userId: 'user-d' }).scope);
    assert.equal(target.contentHash, generateContentHash(amazon('111-1', 'https://x.com/a/status/1').payload));
  });

  it('a title key, per user, when the shop row has no order id', () => {
    const temu = (userId) => ({
      userId, source: 'temu', metadata: { sourceUrl: 'https://www.temu.com/bgt_order.html' },
      payload: { title: 'Socks', href: 'https://x.com/t/status/7' },
    });
    const target = recordIdentity(temu('user-c'));
    assert.equal(target.kind, 'title');
    assert.equal(target.sourceId, 'title:temu.com:socks:');
    assert.notEqual(target.scope, recordIdentity(temu('user-d')).scope);
  });

  it('the content hash alone, per user and source, when there is neither', () => {
    const row = { ...amazon('', 'https://x.com/a/status/1'), payload: { title: 'Lamp', href: 'https://x.com/a/status/1' } };
    const target = recordIdentity(row);
    assert.equal(target.kind, 'content');
    assert.equal(target.sourceId, null);
    assert.notEqual(target.scope, recordIdentity({ ...row, userId: 'user-d' }).scope);
  });
});

describe('which copy keeps the identity', () => {
  const at = (s) => new Date(`2026-10-12T00:00:${String(s).padStart(2, '0')}Z`);
  const record = (rows) => ({ kind: 'order', sourceId: '222-2', scope: 'o', source: 'amazon', rows });

  it('the earliest copy: a link-key row is restored, every later copy superseded', () => {
    const plan = planRecord(record([{ id: 'b4', createdAt: at(4) }, { id: 'b3', createdAt: at(3) }]), [{ id: 'b5', createdAt: at(5) }]);
    assert.equal(plan.restore.id, 'b3');
    assert.deepEqual(plan.supersede.map(({ row, linkKey }) => [row.id, linkKey]), [['b4', true], ['b5', false]]);
    assert.deepEqual(plan.storedIds, ['b5']);
  });

  it('an earlier row already holding the identity keeps it', () => {
    const plan = planRecord(record([{ id: 'b1', createdAt: at(1) }]), [{ id: 'h1', createdAt: at(0) }]);
    assert.equal(plan.restore, null);
    assert.equal(plan.holder.id, 'h1');
    assert.deepEqual(plan.supersede.map(({ row }) => row.id), ['b1']);
  });

  it('copies written in one upload are ordered by id', () => {
    const plan = planRecord(record([{ id: 'z', createdAt: at(2) }, { id: 'a', createdAt: at(2) }]), []);
    assert.equal(plan.restore.id, 'a');
  });
});

describe('superseded identity', () => {
  it('is marked, unique per row, stable across runs, and never an upload hash', () => {
    const one = supersededIdentity('row-1');
    assert.equal(one.sourceId, `${SUPERSEDED_PREFIX}row-1`);
    assert.ok(one.sourceId.startsWith('title:superseded:'));
    assert.deepEqual(supersededIdentity('row-1'), one);
    assert.notEqual(supersededIdentity('row-2').contentHash, one.contentHash);
    assert.match(one.contentHash, /^[0-9a-f]{64}$/);
    assert.equal(one.contentHash, crypto.createHash('sha256').update('superseded:row-1').digest('hex'));
  });

  it('keeps the CLI: dry run by default, --apply to write', () => {
    assert.equal(parseArgs([]).apply, false);
    assert.equal(parseArgs(['--apply']).apply, true);
    assert.throws(() => parseArgs(['--delete']), /Unknown argument/);
  });
});

describe('social backfill claims (part 1)', () => {
  // Pages of one row each, in (userId, createdAt, id) order, from a table where no other row holds
  // an identity: only the identities claimed in this run decide.
  const pagedClient = (rows) => {
    let offset = 0;
    return {
      $queryRaw: async () => rows.slice(offset, (offset += 1)),
      crawlerData: { findMany: async () => [] },
    };
  };
  const post = (id, userId, href, current) => {
    const payload = { href, caption: id };
    const row = { id, userId, source: 'x', payload, metadata: {}, createdKey: '2026-10-01T00:00:00.000000' };
    if (!current) return { ...row, sourceId: href, contentHash: generateContentHash(payload) };
    return { ...row, sourceId: 'title:post:https://x.com/i/status/5', contentHash: generateContentHash(payload, { source: 'x', userId }) };
  };

  it('hold for one user across pages and start empty for the next user', async () => {
    const rows = [
      post('a1', 'user-a', 'https://x.com/a/status/5'),
      post('a2', 'user-a', 'https://twitter.com/A/status/5'),
      post('b1', 'user-b', 'https://x.com/a/status/5'),
      post('c1', 'user-c', 'https://x.com/a/status/5', true),
      post('c2', 'user-c', 'https://x.com/a/status/5?s=20'),
    ];
    const report = await backfillSocialPostIdentity({ client: pagedClient(rows), batch: 1 });
    assert.deepEqual([report.scanned, report.updated, report.current], [5, 2, 1]);
    assert.deepEqual(
      report.conflicts.map((c) => [c.id, c.keptBy]),
      [['a2', 'earlier row in this run'], ['c2', 'earlier row in this run']],
    );
  });
});
