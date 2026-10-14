/**
 * Facebook posts keyed by their permalink, as the App sends them from 2.0.6 (href is the post link,
 * see src/crawler/connect/postUrl.ts in the web client), and the transition from rows stored by
 * earlier App versions (href is the profile page, keyed by title). The upload runs through
 * uploadCrawlerData on the in-memory Prisma stand-in, with the unique indexes of CrawlerData
 * (contentHash; userId + source + sourceId) applied by createMany. The same cases on Postgres are
 * in test/db/crawlerPostIdentity.dbtest.js.
 */
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { installMockPrisma } = require('../helpers/mockPrisma');

const prisma = installMockPrisma();
process.env.LOG_LEVEL = 'error';

const stub = (rel, exportsValue) => {
  const filename = require.resolve(path.join(__dirname, '../../src', rel));
  require.cache[filename] = { id: filename, filename, loaded: true, exports: exportsValue, children: [] };
};
stub('services/campaignEffects.js', { awardConnectBoosts: async () => ({ extra: 0, awards: [] }) });
stub('services/distributionService.js', { distributeUplineRewards: async () => ({}) });
stub('services/referralService.js', { onInviteeFirstValidUpload: async () => ({ skipped: true }) });
// No stay-bonus campaign is running.
prisma.campaign = { findMany: async () => [], findFirst: async () => null };

// createMany as Postgres runs it: skipDuplicates drops a row that hits a unique index.
prisma.crawlerData.createMany = async ({ data, skipDuplicates }) => {
  let count = 0;
  for (const row of data) {
    const taken = prisma.crawlerData.rows.some(
      (r) =>
        r.contentHash === row.contentHash ||
        (row.sourceId != null && r.userId === row.userId && r.source === row.source && r.sourceId === row.sourceId),
    );
    if (taken) {
      if (!skipDuplicates) throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
      continue;
    }
    await prisma.crawlerData.create({ data: row });
    count += 1;
  }
  return { count };
};

const { uploadCrawlerData, generateContentHash } = require('../../src/services/crawlerService');
const {
  extractSourceId,
  legacyPostTitleSourceId,
  socialPostUrl,
} = require('../../src/utils/crawlerRecordIdentity');

const quiet = async (fn) => {
  const saved = [console.log, console.info, console.warn, console.error];
  console.log = console.info = console.warn = console.error = () => {};
  try {
    return await fn();
  } finally {
    [console.log, console.info, console.warn, console.error] = saved;
  }
};

const PROFILE = 'https://www.facebook.com/profile.php?id=100001';
const MARKET = 'https://facebook.com/jane.doe/posts/pfbid0SaturdayMarket';
const FERRY = 'https://facebook.com/permalink.php?story_fbid=pfbid0Harbour&id=100001';
const MORNING_1 = 'https://facebook.com/jane.doe/posts/pfbid0MorningOne';
const MORNING_2 = 'https://facebook.com/jane.doe/posts/pfbid0MorningTwo';
const TRAIL = 'https://facebook.com/jane.doe/posts/pfbid0LionRock';
const CAPTION = {
  market: 'Saturday market in Sham Shui Po, film and a quiet stall.',
  marketEdited: 'Saturday market in Sham Shui Po: film and a quiet stall.',
  ferry: 'Evening ferry across the harbour with the whole family.',
  morning: 'Good morning from Hong Kong, coffee first today.',
  trail: 'Trail run up Lion Rock before sunrise.',
  comment: 'Wow, that view from the top is amazing, we should all go together next weekend!',
};

/** One row as the App uploads it: the post link from 2.0.6, the profile page before. */
const item = (href, caption, profile = PROFILE) => ({
  source: 'facebook',
  type: 'custom',
  timestamp: '2026-10-14T01:00:00.000Z',
  metadata: { sourceUrl: profile, host: 'facebook.com', cleaned: true, extract: 'generic' },
  payload: { title: caption, productTitle: caption, date: '', href, caption, text: caption },
});
const upload = async (userId, items) => {
  const result = await quiet(() => uploadCrawlerData(items.map((i) => structuredClone(i)), userId));
  return [result.uploadedCount, result.duplicatesCount, result.pointsEarned];
};
const rowsOf = (userId) => prisma.crawlerData.rows.filter((r) => r.userId === userId);

describe('Facebook post identity', () => {
  it('keys a post by its permalink: one key per post, the same for a caption edit', () => {
    const market = extractSourceId('facebook', item(MARKET, CAPTION.market).payload, item(MARKET, '').metadata);
    assert.equal(market, `title:post:${MARKET}`);
    assert.equal(extractSourceId('facebook', item(MARKET, CAPTION.marketEdited).payload), market);
    assert.equal(
      extractSourceId('facebook', { href: 'https://www.facebook.com/jane.doe/posts/pfbid0SaturdayMarket?comment_id=9' }),
      market,
    );
    assert.notEqual(extractSourceId('facebook', item(MORNING_2, CAPTION.morning).payload), extractSourceId('facebook', item(MORNING_1, CAPTION.morning).payload));
    assert.equal(
      generateContentHash(item(MARKET, CAPTION.market).payload, { source: 'facebook', userId: 'u1' }),
      generateContentHash(item(MARKET, CAPTION.marketEdited).payload, { source: 'facebook', userId: 'u1' }),
    );
    assert.notEqual(
      generateContentHash(item(MARKET, CAPTION.market).payload, { source: 'facebook', userId: 'u1' }),
      generateContentHash(item(MARKET, CAPTION.market).payload, { source: 'facebook', userId: 'u2' }),
    );
  });

  it('a profile page is not a post: the row keeps its title key', () => {
    const old = item(PROFILE, CAPTION.market);
    assert.equal(socialPostUrl('facebook', old.payload), '');
    assert.equal(extractSourceId('facebook', old.payload, old.metadata), `title:facebook.com:${CAPTION.market.toLowerCase()}:`);
  });

  it('the older title key of a post is the key a row from an earlier App version holds', () => {
    const now = item(MARKET, CAPTION.market);
    const before = item(PROFILE, CAPTION.market);
    assert.equal(legacyPostTitleSourceId('facebook', now.payload, now.metadata), extractSourceId('facebook', before.payload, before.metadata));
    // nothing for a row without a post link, a post without a title, or another source
    assert.equal(legacyPostTitleSourceId('facebook', before.payload, before.metadata), '');
    assert.equal(legacyPostTitleSourceId('facebook', { href: MARKET }, now.metadata), '');
    const tweet = { href: 'https://x.com/DataDance/status/1845000000000000001', title: 'Launch day' };
    assert.equal(legacyPostTitleSourceId('x', tweet, { host: 'x.com' }), '');
    assert.equal(legacyPostTitleSourceId('instagram', { href: 'https://www.instagram.com/p/ABC123def/', title: 'A' }, {}), '');
  });
});

describe('Facebook uploads (in-memory store)', () => {
  beforeEach(() => {
    prisma.reset();
    for (const id of ['user-n', 'user-m', 'user-a', 'user-x']) prisma.user.rows.push({ id, totalPoints: 0 });
  });

  it('n1: two posts with the same caption are both stored; the same page again stores nothing', async () => {
    const page = [item(MARKET, CAPTION.market), item(FERRY, CAPTION.ferry), item(MORNING_1, CAPTION.morning), item(MORNING_2, CAPTION.morning), item(TRAIL, CAPTION.trail)];
    assert.deepEqual(await upload('user-n', page), [5, 0, 50]);
    assert.deepEqual(await upload('user-n', page), [0, 5, 0]);
    assert.deepEqual(
      rowsOf('user-n').map((r) => r.sourceId),
      [MARKET, FERRY, MORNING_1, MORNING_2, TRAIL].map((link) => `title:post:${link}`),
    );
  });

  it('n3: a caption edit of the same post is a duplicate', async () => {
    assert.deepEqual(await upload('user-n', [item(MARKET, CAPTION.market)]), [1, 0, 10]);
    assert.deepEqual(await upload('user-n', [item(MARKET, CAPTION.marketEdited), item(FERRY, CAPTION.ferry)]), [1, 1, 10]);
    assert.equal(rowsOf('user-n').length, 2);
  });

  it('n4: a second user who sees the same post keeps a copy of their own', async () => {
    assert.deepEqual(await upload('user-n', [item(MARKET, CAPTION.market)]), [1, 0, 10]);
    const other = 'https://www.facebook.com/profile.php?id=100002';
    assert.deepEqual(await upload('user-m', [item(MARKET, CAPTION.market, other)]), [1, 0, 10]);
    assert.deepEqual([rowsOf('user-n').length, rowsOf('user-m').length], [1, 1]);
  });

  it('c3: a row from an earlier App version, then the post link with the same title, is a duplicate', async () => {
    // An earlier App version: the profile page as href; two posts with one caption were one row.
    assert.deepEqual(await upload('user-a', [item(PROFILE, CAPTION.market), item(PROFILE, CAPTION.ferry), item(PROFILE, CAPTION.morning)]), [3, 0, 30]);
    const page = [item(MARKET, CAPTION.market), item(FERRY, CAPTION.ferry), item(MORNING_1, CAPTION.morning), item(MORNING_2, CAPTION.morning)];
    assert.deepEqual(await upload('user-a', page), [0, 4, 0]);
    assert.deepEqual(await upload('user-a', page), [0, 4, 0]);
    assert.equal(rowsOf('user-a').length, 3);
  });

  it('a row from an earlier App version under another title: the post is stored once (accepted)', async () => {
    // The earlier version read a long comment as the title, or the caption was edited since: that
    // title key does not match, so the post is stored once under its permalink, then is a duplicate.
    assert.deepEqual(await upload('user-a', [item(PROFILE, CAPTION.comment)]), [1, 0, 10]);
    assert.deepEqual(await upload('user-a', [item(TRAIL, CAPTION.trail)]), [1, 0, 10]);
    assert.deepEqual(await upload('user-a', [item(TRAIL, CAPTION.trail)]), [0, 1, 0]);
    assert.deepEqual(rowsOf('user-a').map((r) => r.sourceId), [`title:facebook.com:${CAPTION.comment.toLowerCase()}:`, `title:post:${TRAIL}`]);
  });

  it('the older title key is read for Facebook only', async () => {
    const meta = { sourceUrl: 'https://x.com/home', host: 'x.com', extract: 'generic' };
    const x = (payload) => ({ source: 'x', type: 'post', timestamp: '2026-10-14T01:00:00.000Z', metadata: meta, payload });
    assert.deepEqual(await upload('user-x', [x({ title: 'Launch day', date: '', href: 'https://x.com/home' })]), [1, 0, 10]);
    // the same title as an X post link is a record of its own, as before
    assert.deepEqual(await upload('user-x', [x({ title: 'Launch day', date: '', href: 'https://x.com/DataDance/status/1845000000000000001' })]), [1, 0, 10]);
  });
});
