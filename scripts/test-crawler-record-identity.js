/**
 * Node assertions for Connect Earn ingest identity.
 * Run: node scripts/test-crawler-record-identity.js
 */

const assert = require('assert');
const { validateDataItem } = require('../src/services/crawlerService');
const {
  extractSourceId,
  calculateDataQuality,
  isClientSmoothedRecord,
} = require('../src/utils/crawlerRecordIdentity');
const {
  isAcceptedCrawlerSource,
  normalizeCrawlerSource,
} = require('../src/constants/crawlerSources');

function shopItem(overrides = {}) {
  return {
    source: 'shein',
    type: 'order',
    timestamp: '2026-09-05T00:00:00.000Z',
    payload: {
      title: 'Linen shirt',
      productTitle: 'Linen shirt',
      date: '2026-08-01',
    },
    metadata: {
      sourceUrl: 'https://m.shein.com/user/orders',
      host: 'm.shein.com',
      extract: 'generic',
      cleaned: true,
    },
    ...overrides,
  };
}

const sheinWithId = shopItem({
  payload: { title: 'Linen shirt', orderId: 'SO-1001', date: '2026-08-01' },
});
assert.strictEqual(extractSourceId('shein', sheinWithId.payload, sheinWithId.metadata), 'SO-1001');
assert.strictEqual(extractSourceId('amazon', { orderid: '112-1234567-1234567' }), '112-1234567-1234567');

const titleOnly = shopItem();
assert.strictEqual(
  extractSourceId('shein', titleOnly.payload, titleOnly.metadata),
  'title:m.shein.com:linen shirt:2026-08-01',
);

const genericA = extractSourceId(
  'generic',
  { title: 'Tea towel', date: '2026-01-02' },
  { sourceUrl: 'https://linen.shop/account/orders', host: 'linen.shop' },
);
const genericB = extractSourceId(
  'generic',
  { title: 'Tea towel', date: '2026-01-02' },
  { sourceUrl: 'https://other.shop/orders', host: 'other.shop' },
);
assert.notStrictEqual(genericA, genericB);
assert.ok(genericA.startsWith('title:linen.shop:'));
assert.notStrictEqual(
  extractSourceId('shein', { title: 'Linen shirt', date: '2026-08-01' }, { host: 'm.shein.com' }),
  extractSourceId('temu', { title: 'Linen shirt', date: '2026-08-01' }, { host: 'www.temu.com' }),
);

const sheinQuality = calculateDataQuality(titleOnly);
assert.ok(sheinQuality.score >= 50, `title-only SHEIN should not be low quality, got ${sheinQuality.score}`);
assert.strictEqual(sheinQuality.details.hasOfficialId, true);
assert.strictEqual(isClientSmoothedRecord(titleOnly), true);

const amazonOk = validateDataItem({
  source: 'amazon',
  type: 'order',
  timestamp: '2026-09-05T00:00:00.000Z',
  payload: { orderid: '112-1234567-1234567', title: 'Headphones' },
  metadata: { sourceUrl: 'https://www.amazon.com/your-orders' },
});
assert.deepStrictEqual(amazonOk.errors, []);

const amazonMissing = validateDataItem({
  source: 'amazon',
  type: 'order',
  timestamp: '2026-09-05T00:00:00.000Z',
  payload: { title: 'Headphones' },
  metadata: { sourceUrl: 'https://www.amazon.com/your-orders' },
});
assert.ok(amazonMissing.errors.some((row) => /orderid/i.test(row)));

const sheinValid = validateDataItem(titleOnly);
assert.deepStrictEqual(sheinValid.errors, []);
assert.ok(
  !sheinValid.warnings.some((row) => /quality score is low/i.test(row)),
  `smoothed title-only row should not be quality-penalized: ${sheinValid.warnings.join('; ')}`,
);

const emptyShop = validateDataItem(shopItem({ payload: {} }));
assert.ok(emptyShop.errors.some((row) => /order id or a title/i.test(row)));

const customType = validateDataItem(
  shopItem({
    type: 'custom',
    payload: { title: 'Tea towel', href: 'https://linen.shop/orders/1' },
    source: 'generic',
    metadata: {
      sourceUrl: 'https://linen.shop/account/orders',
      host: 'linen.shop',
      extract: 'generic',
      cleaned: true,
    },
  }),
);
assert.deepStrictEqual(customType.errors, []);

assert.strictEqual(normalizeCrawlerSource('twitter'), 'x');
assert.strictEqual(normalizeCrawlerSource('trip.com'), 'trip');
assert.strictEqual(normalizeCrawlerSource('ctrip'), 'trip');
assert.ok(isAcceptedCrawlerSource('twitter'));
assert.ok(isAcceptedCrawlerSource('instagram'));
assert.ok(isAcceptedCrawlerSource('rakuten'));
assert.ok(isAcceptedCrawlerSource('expedia'));
assert.ok(isAcceptedCrawlerSource('uber'));
assert.ok(!isAcceptedCrawlerSource('not-a-real-source'));
assert.ok(!isAcceptedCrawlerSource('taobao'));
assert.ok(!isAcceptedCrawlerSource('jd'));
assert.ok(!isAcceptedCrawlerSource('jd.com'));
assert.ok(!isAcceptedCrawlerSource('jingdong'));
assert.ok(!isAcceptedCrawlerSource('pinduoduo'));
assert.ok(!isAcceptedCrawlerSource('xiaohongshu'));
assert.ok(!isAcceptedCrawlerSource('red'));
assert.ok(!isAcceptedCrawlerSource('weibo'));
assert.ok(!isAcceptedCrawlerSource('douyin'));
assert.ok(!isAcceptedCrawlerSource('didi'));

const socialTitleOnly = {
  source: 'instagram',
  type: 'post',
  timestamp: '2026-09-05T00:00:00.000Z',
  payload: { title: 'Sunset reel' },
  metadata: {
    sourceUrl: 'https://www.instagram.com/p/abc',
    host: 'instagram.com',
    extract: 'generic',
    cleaned: true,
  },
};
assert.deepStrictEqual(validateDataItem(socialTitleOnly).errors, []);
assert.strictEqual(
  extractSourceId('instagram', socialTitleOnly.payload, socialTitleOnly.metadata),
  'title:instagram.com:sunset reel:',
);
assert.ok(calculateDataQuality(socialTitleOnly).score >= 50);
assert.strictEqual(isClientSmoothedRecord(socialTitleOnly), true);

const twitterAlias = {
  ...socialTitleOnly,
  source: 'twitter',
  metadata: {
    sourceUrl: 'https://x.com/user/status/1',
    host: 'x.com',
    extract: 'generic',
    cleaned: true,
  },
};
const twitterValid = validateDataItem(twitterAlias);
assert.deepStrictEqual(twitterValid.errors, []);
assert.strictEqual(twitterAlias.source, 'x');
assert.notStrictEqual(twitterAlias.source, 'amazon');

const travelTitleOnly = {
  source: 'expedia',
  type: 'trip',
  timestamp: '2026-09-05T00:00:00.000Z',
  payload: { title: 'Tokyo hotel', date: '2026-07-12' },
  metadata: {
    sourceUrl: 'https://www.expedia.com/trips',
    host: 'expedia.com',
    extract: 'generic',
    cleaned: true,
  },
};
assert.deepStrictEqual(validateDataItem(travelTitleOnly).errors, []);
assert.strictEqual(
  extractSourceId('expedia', travelTitleOnly.payload, travelTitleOnly.metadata),
  'title:expedia.com:tokyo hotel:2026-07-12',
);

const lifeTitleOnly = {
  source: 'uber',
  type: 'trip',
  timestamp: '2026-09-05T00:00:00.000Z',
  payload: { title: 'Airport ride' },
  metadata: {
    sourceUrl: 'https://riders.uber.com/trips',
    host: 'riders.uber.com',
    extract: 'generic',
    cleaned: true,
  },
};
assert.deepStrictEqual(validateDataItem(lifeTitleOnly).errors, []);
assert.ok(extractSourceId('uber', lifeTitleOnly.payload, lifeTitleOnly.metadata).startsWith('title:'));

const rejected = validateDataItem({
  source: 'not-a-real-source',
  type: 'order',
  timestamp: '2026-09-05T00:00:00.000Z',
  payload: { title: 'Nope' },
  metadata: { sourceUrl: 'https://example.com' },
});
assert.ok(rejected.errors.some((row) => /supported Connect source/i.test(row)));

console.log('crawler record identity assertions passed');
