const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeLocale, pickFromMap, buildCampaignI18n, firstFilled } = require('./campaignI18n');
const { collectStrings, applyParsed } = require('../services/campaignTranslate');

describe('campaign i18n', () => {
  it('normalizes product locales', () => {
    assert.equal(normalizeLocale('zh-TW'), 'zh-TW');
    assert.equal(normalizeLocale('zh-Hant-TW'), 'zh-TW');
    assert.equal(normalizeLocale('ja-JP'), 'ja');
    assert.equal(normalizeLocale('zh-CN'), 'zh');
    assert.equal(normalizeLocale('en-US'), 'en');
  });

  it('picks ja and zh-TW before falling back', () => {
    const map = { en: 'Summer', zh: '夏天', 'zh-TW': '夏季', ja: '夏' };
    assert.equal(pickFromMap(map, 'ja'), '夏');
    assert.equal(pickFromMap(map, 'zh-TW'), '夏季');
    assert.equal(pickFromMap(map, 'zh'), '夏天');
    assert.equal(pickFromMap({ en: 'Summer' }, 'ja'), 'Summer');
    assert.equal(pickFromMap({ en: 'Summer', zh: '夏天' }, 'zh-TW'), '夏天');
  });

  it('builds maps from one core language', () => {
    const i18n = buildCampaignI18n({ copySource: 'ja', titleJa: '夏の地図', blurbJa: '滞在を点灯' });
    assert.equal(i18n.source, 'ja');
    assert.equal(firstFilled(i18n.title), '夏の地図');
    assert.equal(i18n.title.ja, '夏の地図');
  });
});

describe('campaign translate helpers', () => {
  it('keeps the source string and fills other locales from Gemini JSON', () => {
    const collected = collectStrings({
      source: 'en',
      strings: { title: 'Light up your summer', blurb: 'Your bookings tell the story.' },
    });
    const bundle = applyParsed(
      {
        title: { zh: '点亮你的夏天', 'zh-TW': '點亮你的夏天', ja: '夏を灯そう' },
        blurb: { zh: '预订记录会讲述夏天。', 'zh-TW': '預訂紀錄會講述夏天。', ja: '予約が夏の物語になる。' },
      },
      collected.source,
      collected.strings,
      [],
    );
    assert.equal(bundle.title.en, 'Light up your summer');
    assert.equal(bundle.title.ja, '夏を灯そう');
    assert.equal(bundle.blurb['zh-TW'], '預訂紀錄會講述夏天。');
  });

  it('reads Gemini JSON that nests locale maps under strings', () => {
    const collected = collectStrings({
      source: 'en',
      strings: { title: 'Light up your summer' },
    });
    const bundle = applyParsed(
      { strings: { title: { zh: '点亮你的夏天', 'zh-TW': '點亮你的夏天', ja: '夏を灯そう' } } },
      collected.source,
      collected.strings,
      [],
    );
    assert.equal(bundle.title.ja, '夏を灯そう');
    assert.equal(bundle.title['zh-TW'], '點亮你的夏天');
  });
});

describe('live campaign copy patch', () => {
  const { applyCopyFields } = require('./campaignRules');

  it('updates ja and zh-TW without changing the live window', () => {
    const existing = {
      titleEn: 'Summer map',
      titleZh: '夏季地图',
      blurbEn: 'Light stays',
      blurbZh: '点亮住宿',
      pillEn: 'Live',
      pillZh: '进行中',
      template: 'HOME_CARD',
      config: { shareTextEn: 'Share this', i18n: { source: 'en', title: { en: 'Summer map' } } },
    };
    const patched = applyCopyFields(existing, {
      copySource: 'en',
      titleEn: 'Summer map',
      titleZh: '夏季地图',
      titleJa: '夏の地図',
      titleZhTw: '夏季地圖',
      blurbEn: 'Light stays',
      blurbZh: '点亮住宿',
      blurbJa: '滞在を灯す',
      blurbZhTw: '點亮住宿',
    });
    assert.equal(patched.data.titleEn, 'Summer map');
    assert.equal(patched.data.config.i18n.title.ja, '夏の地図');
    assert.equal(patched.data.config.i18n.title['zh-TW'], '夏季地圖');
    assert.equal(patched.data.config.shareTextEn, 'Share this');
  });
});
