const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { generateContentHash } = require('../../src/services/crawlerService');
const { extractSourceId, isTitleBackedSourceId } = require('../../src/utils/crawlerRecordIdentity');

describe('social post content hash', () => {
  it('treats a changed like count as the same Instagram post', () => {
    const first = generateContentHash({
      id: 'https://www.instagram.com/p/ABC123def/comments/?hl=en',
      title: '1,204 赞 36 评论 Sunset over the bay',
      caption: 'Sunset over the bay',
    });
    const later = generateContentHash({
      href: 'https://instagram.com/p/ABC123def/',
      title: '1,299 赞 40 评论 Sunset over the bay',
      caption: 'Sunset over the bay',
    });
    const other = generateContentHash({
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

  it('still hashes shop orders by their payload', () => {
    const one = generateContentHash({ orderId: 'SO-1', title: 'Linen shirt' });
    const two = generateContentHash({ orderId: 'SO-1', title: 'Tea towel' });
    assert.notEqual(one, two);
  });
});
