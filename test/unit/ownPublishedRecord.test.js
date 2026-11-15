const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { validateDataItem } = require('../../src/services/crawlerService');
const { isOwnPublishedRecord } = require('../../src/utils/crawlerRecordIdentity');

const social = (source, payload, sourceUrl) => ({
  source,
  type: 'custom',
  timestamp: '2026-11-06T00:00:00.000Z',
  payload,
  metadata: { sourceUrl, extract: 'generic', cleaned: true },
});

describe('social uploads are the signed-in account\'s own posts', () => {
  it('keeps a post on that account\'s X profile and drops the home timeline', () => {
    const post = { href: 'https://x.com/DataDance/status/1845000000000000001', title: 'Launch day' };
    assert.equal(isOwnPublishedRecord('x', post, { sourceUrl: 'https://x.com/DataDance' }), true);
    assert.equal(isOwnPublishedRecord('x', post, { sourceUrl: 'https://x.com/home' }), false);
    assert.equal(isOwnPublishedRecord('x', post, { sourceUrl: 'https://x.com/other' }), false);
    const home = validateDataItem(social('x', post, 'https://x.com/home'));
    assert.ok(home.errors.some((row) => /signed-in account/i.test(row)));
    assert.deepEqual(validateDataItem(social('x', post, 'https://x.com/datadance')).errors, []);
  });

  it('drops an X status link that does not name its author', () => {
    const post = { href: 'https://x.com/i/web/status/1845000000000000001', title: 'Launch day' };
    assert.equal(isOwnPublishedRecord('x', post, { sourceUrl: 'https://x.com/DataDance' }), false);
  });

  it('keeps an Instagram post read on that profile and drops the home feed and profile chrome', () => {
    const onProfile = { href: 'https://www.instagram.com/p/ABC123def/', title: 'Sunset reel' };
    assert.equal(isOwnPublishedRecord('instagram', onProfile, { sourceUrl: 'https://www.instagram.com/jane/' }), true);
    assert.equal(isOwnPublishedRecord('instagram', onProfile, { sourceUrl: 'https://www.instagram.com/' }), false);
    const named = { href: 'https://www.instagram.com/jane/reel/ABC123def/', title: 'Sunset reel' };
    assert.equal(isOwnPublishedRecord('instagram', named, { sourceUrl: 'https://www.instagram.com/jane/' }), true);
    assert.equal(isOwnPublishedRecord('instagram', named, { sourceUrl: 'https://www.instagram.com/other/' }), false);
    const chrome = { href: 'https://www.instagram.com/p/ABC123def/', title: 'Foto profil Race' };
    assert.equal(isOwnPublishedRecord('instagram', chrome, { sourceUrl: 'https://www.instagram.com/jane/' }), false);
  });

  it('drops Discord channel chrome and a Discord channel page', () => {
    const stamp = { href: 'https://discord.com/channels/1260952177917038725/1260952178604904522', title: '[4:24 PM] Sunday, November 8, 2026' };
    assert.equal(isOwnPublishedRecord('discord', stamp, { sourceUrl: 'https://discord.com/channels/@me' }), false);
    assert.equal(
      isOwnPublishedRecord('discord', { href: stamp.href, title: 'hello from the server' }, { sourceUrl: 'https://discord.com/channels/@me' }),
      false,
    );
  });

  it('keeps the account\'s own page on the other social sources and drops their feeds', () => {
    assert.equal(
      isOwnPublishedRecord('tiktok', { href: 'https://www.tiktok.com/@jane/video/7312345678901234567', title: 'Clip' }, { sourceUrl: 'https://www.tiktok.com/@jane' }),
      true,
    );
    assert.equal(
      isOwnPublishedRecord('tiktok', { href: 'https://www.tiktok.com/@other/video/7312345678901234567', title: 'Clip' }, { sourceUrl: 'https://www.tiktok.com/@jane' }),
      false,
    );
    assert.equal(isOwnPublishedRecord('reddit', { title: 'My post' }, { sourceUrl: 'https://www.reddit.com/user/me/submitted/' }), true);
    assert.equal(isOwnPublishedRecord('reddit', { title: 'Front page' }, { sourceUrl: 'https://www.reddit.com/' }), false);
    assert.equal(isOwnPublishedRecord('youtube', { title: 'Upload' }, { sourceUrl: 'https://www.youtube.com/@jane/videos' }), true);
    assert.equal(isOwnPublishedRecord('youtube', { title: 'Home' }, { sourceUrl: 'https://www.youtube.com/feed/you' }), false);
    assert.equal(isOwnPublishedRecord('linkedin', { title: 'Update' }, { sourceUrl: 'https://www.linkedin.com/in/me/' }), true);
    assert.equal(isOwnPublishedRecord('pinterest', { title: 'Pin' }, { sourceUrl: 'https://www.pinterest.com/_created/' }), true);
    assert.equal(isOwnPublishedRecord('facebook', { href: 'https://facebook.com/jane.doe/posts/pfbid0SaturdayMarket', title: 'Market' }, { sourceUrl: 'https://www.facebook.com/me' }), true);
    assert.equal(isOwnPublishedRecord('facebook', { href: 'https://facebook.com/other/posts/pfbid0SaturdayMarket', title: 'Market' }, { sourceUrl: 'https://www.facebook.com/jane.doe' }), false);
    assert.equal(isOwnPublishedRecord('threads', { href: 'https://www.threads.net/@jane/post/DAbc123x', title: 'Note' }, { sourceUrl: 'https://www.threads.net/@jane' }), true);
    assert.equal(isOwnPublishedRecord('threads', { href: 'https://www.threads.net/@jane/post/DAbc123x', title: 'Note' }, { sourceUrl: 'https://www.threads.net/' }), false);
    assert.equal(isOwnPublishedRecord('twitch', { title: 'VOD' }, { sourceUrl: 'https://www.twitch.tv/jane/videos' }), true);
    assert.equal(isOwnPublishedRecord('twitch', { title: 'Browse' }, { sourceUrl: 'https://www.twitch.tv/' }), false);
  });

  it('leaves shop and travel records alone', () => {
    const order = social('shein', { orderId: 'SO-1', title: 'Linen shirt' }, 'https://m.shein.com/user/orders');
    order.type = 'order';
    assert.equal(isOwnPublishedRecord('shein', order.payload, order.metadata), true);
    assert.deepEqual(validateDataItem(order).errors, []);
  });
});
