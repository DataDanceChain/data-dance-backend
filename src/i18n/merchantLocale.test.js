const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { LOCALES, resolveLocale, localizeHeader, localizeHeaders, licenceTerms, csvNotice } = require('./merchantLocale');

describe('merchant locale', () => {
  it('has the four product languages', () => {
    assert.deepEqual(LOCALES, ['en', 'zh-TW', 'ja', 'ko']);
  });

  it('maps every Chinese tag to zh-TW', () => {
    for (const tag of ['zh', 'zh-CN', 'zh-Hans', 'zh-SG', 'zh-TW', 'zh-Hant', 'zh-HK', 'zh-Hant-TW', 'zh_CN']) {
      assert.equal(resolveLocale(tag), 'zh-TW', tag);
    }
    assert.equal(resolveLocale('zh-CN,zh;q=0.9,en;q=0.8'), 'zh-TW');
  });

  it('resolves ja, ko and English, and anything else to English', () => {
    assert.equal(resolveLocale('ja-JP'), 'ja');
    assert.equal(resolveLocale('ko'), 'ko');
    assert.equal(resolveLocale('ko-KR,ko;q=0.9'), 'ko');
    assert.equal(resolveLocale('en-GB'), 'en');
    assert.equal(resolveLocale('fr-FR'), 'en');
    assert.equal(resolveLocale(''), 'en');
    assert.equal(resolveLocale(undefined), 'en');
  });

  it('labels CSV headers in Korean and Traditional Chinese', () => {
    assert.deepEqual(localizeHeaders(['order-id', 'email', 'price'], 'ko'), ['주문 번호', '이메일', '가격']);
    assert.deepEqual(localizeHeaders(['order-id', 'email'], 'zh-CN'), ['訂單編號', '電郵']);
    assert.equal(localizeHeader('주문번호', 'en'), 'Order ID');
    assert.equal(localizeHeader('unknown_column', 'ko'), 'unknown_column');
  });

  it('licence terms and the CSV notice exist in every product language', () => {
    for (const locale of LOCALES) {
      assert.equal(licenceTerms(locale).length, 4, locale);
      assert.match(csvNotice({ locale, version: 'v1', buyer: 'b', purchaseId: 'p' }), /^# DataDance .+ v1\n# /, locale);
    }
    assert.deepEqual(licenceTerms('zh'), licenceTerms('zh-TW'));
    assert.deepEqual(licenceTerms('fr'), licenceTerms('en'));
    assert.match(csvNotice({ locale: 'ko', version: 'v1', buyer: 'b', purchaseId: 'p' }), /구매자=b; 구매=p/);
  });
});
