/**
 * Record identity backfill (scripts/backfillSocialPostIdentity.js, part 2), pure parts: which
 * stored rows hold the previous release's post link key, the identity each record gets back, and
 * which copy keeps it. The database side is in test/db/crawlerPostIdentity.dbtest.js.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const { generateContentHash } = require('../../src/services/crawlerService');
const {
  legacyLinkKey,
  isRecordLinkKeyRow,
  recordIdentity,
  planRecord,
  supersededIdentity,
  SUPERSEDED_PREFIX,
  parseArgs,
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
