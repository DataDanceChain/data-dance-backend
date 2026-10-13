const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  LOCALES,
  normalizeLocale,
  sourceLocale,
  asMap,
  mergeMaps,
  pickFromMap,
  pickQuestion,
  buildCampaignI18n,
  firstFilled,
} = require('./campaignI18n');
const { collectStrings, applyParsed } = require('../services/campaignTranslate');

describe('campaign i18n', () => {
  it('has the four product languages', () => {
    assert.deepEqual(LOCALES, ['en', 'zh-TW', 'ja', 'ko']);
  });

  it('maps every Chinese tag to zh-TW and keeps ja, ko and en', () => {
    for (const tag of ['zh', 'zh-CN', 'zh-Hans', 'zh-SG', 'zh-TW', 'zh-Hant', 'zh-HK', 'zh-Hant-TW', 'zh_CN', 'ZH-tw']) {
      assert.equal(normalizeLocale(tag), 'zh-TW', tag);
    }
    assert.equal(normalizeLocale('ja-JP'), 'ja');
    assert.equal(normalizeLocale('ko'), 'ko');
    assert.equal(normalizeLocale('ko-KR'), 'ko');
    assert.equal(normalizeLocale('en-US'), 'en');
    assert.equal(normalizeLocale('fr-FR'), '');
    assert.equal(normalizeLocale('zhx'), '');
  });

  it('picks ja, ko and zh-TW before falling back', () => {
    const map = { en: 'Summer', zh: '夏天', 'zh-TW': '夏季', ja: '夏', ko: '여름' };
    assert.equal(pickFromMap(map, 'ja'), '夏');
    assert.equal(pickFromMap(map, 'ko-KR'), '여름');
    assert.equal(pickFromMap(map, 'zh-TW'), '夏季');
    assert.equal(pickFromMap(map, 'zh'), '夏季');
    assert.equal(pickFromMap(map, 'zh-CN'), '夏季');
    assert.equal(pickFromMap({ en: 'Summer' }, 'ja'), 'Summer');
    assert.equal(pickFromMap({ en: 'Summer' }, 'ko'), 'Summer');
    assert.equal(pickFromMap({ en: 'Summer', zh: '夏天' }, 'zh-TW'), '夏天');
    assert.equal(pickFromMap({ zh: '夏天' }, 'en'), '夏天');
  });

  it('a Traditional-tagged copy wins over Simplified, in any key order', () => {
    assert.equal(asMap({ zh: '夏天', 'zh-TW': '夏季' })['zh-TW'], '夏季');
    assert.equal(asMap({ 'zh-Hant': '夏季', 'zh-CN': '夏天' })['zh-TW'], '夏季');
    assert.equal(asMap({ 'zh-HK': '夏季', zh: '夏天' })['zh-TW'], '夏季');
    assert.equal(asMap({ zh: '夏天' })['zh-TW'], '夏天');
    assert.deepEqual(Object.keys(asMap({ zh: '夏天', fr: 'été' })).sort(), ['en', 'ja', 'ko', 'zh-TW']);
  });

  it('new Traditional copy from the form replaces a stored Simplified-only title', () => {
    const i18n = buildCampaignI18n(
      { titleZhTw: '夏季地圖', i18n: { title: { en: 'Summer map', zh: '夏季地图' } } },
      { titleEn: 'Summer map', titleZh: '夏季地图' },
    );
    assert.equal(i18n.title['zh-TW'], '夏季地圖');
    assert.equal(i18n.title.zh, '夏季地图');
    const kept = buildCampaignI18n(
      { i18n: { title: { en: 'Summer map', zh: '夏季地图' } } },
      { titleEn: 'Summer map', titleZh: '夏季地图' },
    );
    assert.equal(kept.title['zh-TW'], '');
    assert.equal(kept.title.zh, '夏季地图');
    assert.equal(pickFromMap(kept.title, 'zh-TW'), '夏季地图');
  });

  it('stores Simplified copy in its own zh slot, never under zh-TW', () => {
    for (const tag of ['zh', 'zh-CN', 'zh-Hans', 'zh_SG']) {
      const map = mergeMaps({ [tag]: '夏天' });
      assert.equal(map['zh-TW'], '', tag);
      assert.equal(map.zh, '夏天', tag);
    }
    assert.deepEqual(mergeMaps({ 'zh-Hant': '夏季', zh: '夏天' }), { en: '', 'zh-TW': '夏季', ja: '', ko: '', zh: '夏天' });
    assert.equal(firstFilled({ zh: '夏天' }), '夏天');
  });

  it('stores the copy source by the translate rule: a Simplified pick stays zh', () => {
    for (const tag of ['zh', 'zh-CN', 'zh-Hans']) assert.equal(sourceLocale(tag), 'zh', tag);
    for (const tag of ['zh-TW', 'zh-Hant', 'zh-HK']) assert.equal(sourceLocale(tag), 'zh-TW', tag);
    assert.equal(sourceLocale(''), 'en');
    assert.equal(sourceLocale('fr'), 'en');
    assert.equal(buildCampaignI18n({ copySource: 'zh', titleZh: '夏天' }).source, 'zh');
    assert.equal(buildCampaignI18n({ copySource: 'zh-CN', titleZh: '夏天' }).source, 'zh');
    assert.equal(buildCampaignI18n({ copySource: 'zh-TW', titleZhTw: '夏季' }).source, 'zh-TW');
    assert.equal(buildCampaignI18n({ titleZh: '夏天', i18n: { source: 'zh', title: { zh: '夏天' } } }).source, 'zh');
  });

  it('form fields outrank the stored copy; an empty field keeps it', () => {
    const stored = { source: 'en', title: { en: 'Old', 'zh-TW': '舊', ja: '古い' }, shareText: { en: 'Old share' } };
    const i18n = buildCampaignI18n(
      { titleEn: 'New', titleZhTw: '新', titleJa: '', shareTextEn: 'New share', i18n: stored },
      { titleEn: 'New' },
    );
    assert.equal(i18n.title.en, 'New');
    assert.equal(i18n.title['zh-TW'], '新');
    assert.equal(i18n.title.ja, '古い');
    assert.equal(i18n.shareText.en, 'New share');
  });

  it('a one-language field that only echoes another language is not kept as copy', () => {
    const stored = { title: { en: 'Old' }, question1: { en: 'Where to?' } };
    const i18n = buildCampaignI18n(
      { titleEn: 'New', titleZh: 'Old', question1En: 'Where next?', question1Zh: 'Where to?', i18n: stored },
      { titleEn: 'New', titleZh: 'Old' },
    );
    assert.equal(i18n.title.en, 'New');
    assert.equal(i18n.title.zh, undefined);
    assert.equal(pickFromMap(i18n.title, 'zh-TW'), 'New');
    assert.equal(i18n.question1.zh, undefined);
    assert.equal(pickFromMap(i18n.question1, 'zh-TW'), 'Where next?');
    const typed = buildCampaignI18n({ titleZh: '夏天', i18n: stored }, { titleZh: '夏天' });
    assert.equal(typed.title.zh, '夏天');
    const long = 'あ'.repeat(90);
    const trimmed = buildCampaignI18n({ titleEn: long, i18n: { title: { ja: long } } }, { titleEn: long.slice(0, 80) });
    assert.equal(trimmed.title.en, '');
  });

  it('reads Korean form fields', () => {
    const i18n = buildCampaignI18n({ titleEn: 'Summer map', titleKo: '여름 지도', blurbEn: 'Light stays', blurbKo: '숙소를 밝혀요' });
    assert.equal(i18n.title.ko, '여름 지도');
    assert.equal(i18n.blurb.ko, '숙소를 밝혀요');
    assert.equal(i18n.title.zh, undefined);
  });

  it('falls back to the stored Traditional question for zh tags', () => {
    const config = { question1En: 'Where to?', question1Zh: '去哪里？', question1ZhTw: '去哪裡？' };
    assert.equal(pickQuestion(config, 1, 'zh-CN'), '去哪裡？');
    assert.equal(pickQuestion({ question1En: 'Where to?', question1Zh: '去哪里？' }, 1, 'zh-TW'), '去哪里？');
    assert.equal(pickQuestion(config, 1, 'ko'), 'Where to?');
    assert.equal(pickQuestion({ ...config, i18n: { question1: { ko: '어디로?' } } }, 1, 'ko'), '어디로?');
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
        title: { zh: '点亮你的夏天', 'zh-TW': '點亮你的夏天', ja: '夏を灯そう', ko: '여름을 밝혀요' },
        blurb: { zh: '预订记录会讲述夏天。', 'zh-TW': '預訂紀錄會講述夏天。', ja: '予約が夏の物語になる。' },
      },
      collected.source,
      collected.strings,
      [],
    );
    assert.equal(bundle.title.en, 'Light up your summer');
    assert.equal(bundle.title.ja, '夏を灯そう');
    assert.equal(bundle.title.ko, '여름을 밝혀요');
    assert.equal(bundle.title['zh-TW'], '點亮你的夏天');
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
    assert.equal(patched.data.config.i18n.title.zh, '夏季地图');
    assert.equal(patched.data.titleZh, '夏季地图');
    assert.equal(patched.data.config.shareTextEn, 'Share this');
  });

  it('keeps Korean copy and writes it to the config fields', () => {
    const existing = {
      titleEn: 'Summer map',
      titleZh: '夏季地图',
      blurbEn: 'Light stays',
      blurbZh: '点亮住宿',
      template: 'HOME_CARD',
      config: { i18n: { source: 'en', title: { en: 'Summer map' } } },
    };
    const patched = applyCopyFields(existing, {
      titleKo: '여름 지도',
      shareTextEn: 'Share this',
      shareTextKo: '공유하기',
    });
    assert.equal(patched.data.config.i18n.title.ko, '여름 지도');
    assert.equal(patched.data.config.shareTextKo, '공유하기');
    assert.equal(patched.data.config.shareTextZh, undefined);
  });
});
