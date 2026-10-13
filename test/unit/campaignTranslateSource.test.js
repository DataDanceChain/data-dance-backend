/**
 * Campaign copy translation by source language. Copy written in Simplified Chinese (zh, zh-CN,
 * zh-Hans) is not the zh-TW text: zh-TW is still translated, and the Simplified text keeps its
 * own zh slot and never fills zh-TW. The model is a stand-in.
 */
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const SRC = path.join(__dirname, '../../src');
const stub = (rel, exportsValue) => {
  const filename = require.resolve(path.join(SRC, rel));
  require.cache[filename] = { id: filename, filename, loaded: true, exports: exportsValue, children: [] };
};

let prompts = [];
let reply = {};
stub('services/lifeContextGemini.js', {
  defaultGeminiModel: () => 'stub-model',
  callGeminiJson: async (prompt) => {
    prompts.push(prompt);
    return reply;
  },
});

const { translateCampaignCopy } = require('../../src/services/campaignTranslate');

const SIMPLIFIED = '点亮你的夏天';
const TRADITIONAL = '點亮你的夏天';

beforeEach(() => {
  prompts = [];
  reply = {};
});

function fillLine(prompt) {
  return prompt.split('\n').find((line) => line.startsWith('Fill these locales:')) || '';
}

describe('campaign copy translated from Simplified Chinese', () => {
  for (const tag of ['zh', 'zh-CN', 'zh-Hans', 'zh_SG']) {
    it(`${tag}: zh-TW comes back as the Traditional translation`, async () => {
      reply = {
        title: { en: 'Light up your summer', 'zh-TW': TRADITIONAL, ja: '夏を灯そう', ko: '여름을 밝혀요' },
      };
      const bundle = await translateCampaignCopy({ source: tag, strings: { title: SIMPLIFIED } });
      assert.equal(bundle.title['zh-TW'], TRADITIONAL);
      assert.notEqual(bundle.title['zh-TW'], SIMPLIFIED);
      assert.equal(bundle.title.en, 'Light up your summer');
      assert.equal(bundle.title.ja, '夏を灯そう');
      assert.equal(bundle.title.ko, '여름을 밝혀요');
      assert.equal(prompts.length, 1);
      assert.match(prompts[0], /Source language: Simplified Chinese \(zh\)\./);
      assert.match(fillLine(prompts[0]), /\(zh-TW\)/);
    });
  }

  it('reads the copySource field the same way', async () => {
    reply = { title: { 'zh-TW': TRADITIONAL } };
    const bundle = await translateCampaignCopy({ copySource: 'zh', title: SIMPLIFIED });
    assert.equal(bundle.title['zh-TW'], TRADITIONAL);
  });

  it('a Traditional reply wins over a Simplified one, in any key order', async () => {
    reply = { title: { zh: SIMPLIFIED, 'zh-Hant': TRADITIONAL, en: 'Light up your summer' } };
    const bundle = await translateCampaignCopy({ source: 'zh', strings: { title: SIMPLIFIED } });
    assert.equal(bundle.title['zh-TW'], TRADITIONAL);
  });

  it('keeps the Simplified source in zh, and zh-TW empty when the model returns no Traditional copy', async () => {
    reply = { title: { en: 'Light up your summer', zh: '别的简体' } };
    const bundle = await translateCampaignCopy({ source: 'zh', strings: { title: SIMPLIFIED } });
    assert.equal(bundle.title['zh-TW'], '');
    assert.equal(bundle.title.zh, SIMPLIFIED);
    assert.equal(bundle.title.en, 'Light up your summer');
  });

  it('prize labels get the Traditional translation too', async () => {
    reply = { title: { 'zh-TW': TRADITIONAL }, prizeLabels: [{ en: 'Grand prize', 'zh-TW': '頭獎' }] };
    const bundle = await translateCampaignCopy({ source: 'zh', strings: { title: SIMPLIFIED }, prizeLabels: ['头奖'] });
    assert.equal(bundle.prizeLabels[0]['zh-TW'], '頭獎');
    assert.equal(bundle.prizeLabels[0].en, 'Grand prize');
  });
});

describe('campaign copy translated from a product language', () => {
  for (const tag of ['zh-TW', 'zh-Hant', 'zh-HK']) {
    it(`${tag}: the source text is the zh-TW copy and zh-TW is not a target`, async () => {
      reply = { title: { en: 'Light up your summer', 'zh-TW': '別的譯文', ja: '夏を灯そう', ko: '여름을 밝혀요' } };
      const bundle = await translateCampaignCopy({ source: tag, strings: { title: TRADITIONAL } });
      assert.equal(bundle.title['zh-TW'], TRADITIONAL);
      assert.equal(bundle.title.en, 'Light up your summer');
      assert.match(prompts[0], /Source language: Traditional Chinese \(Taiwan\) \(zh-TW\)\./);
      assert.doesNotMatch(fillLine(prompts[0]), /\(zh-TW\)/);
    });
  }

  it('en and ko keep their own source text', async () => {
    reply = { title: { en: 'Other', 'zh-TW': TRADITIONAL, ko: '다른' } };
    const en = await translateCampaignCopy({ source: 'en', strings: { title: 'Light up your summer' } });
    assert.equal(en.title.en, 'Light up your summer');
    assert.equal(en.title['zh-TW'], TRADITIONAL);
    const ko = await translateCampaignCopy({ source: 'ko-KR', strings: { title: '여름을 밝혀요' } });
    assert.equal(ko.title.ko, '여름을 밝혀요');
    assert.doesNotMatch(fillLine(prompts[1]), /\(ko\)/);
  });
});
