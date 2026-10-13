/**
 * Campaign copy through the ops save routes, as the admin form uses them: create, translate,
 * save again, reload. Copy written in Simplified Chinese keeps its own slot, the Traditional
 * translation is what zh-TW holds after every save, and an edit of a filled language is kept.
 * Both the draft save (parseDraft) and the live copy edit (applyCopyFields) are covered. The
 * model is a stand-in.
 */
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { installMockPrisma } = require('../helpers/mockPrisma');

const prisma = installMockPrisma();
const rows = new Map();
prisma.campaign = {
  async create({ data }) {
    const row = { id: `c${rows.size + 1}`, legalVersion: 1, publishedAt: null, ...data };
    rows.set(row.id, row);
    return { ...row };
  },
  async findUnique({ where }) {
    const row = rows.get(where.id);
    return row ? { ...row } : null;
  },
  async update({ where, data }) {
    const row = { ...rows.get(where.id), ...data };
    rows.set(where.id, row);
    return { ...row };
  },
};
prisma.campaignEvent = { create: async ({ data }) => data };

let reply = {};
let prompts = [];
const geminiPath = require.resolve(path.join(__dirname, '../../src/services/lifeContextGemini.js'));
require.cache[geminiPath] = {
  id: geminiPath,
  filename: geminiPath,
  loaded: true,
  children: [],
  exports: {
    defaultGeminiModel: () => 'stub-model',
    callGeminiJson: async (prompt) => {
      prompts.push(prompt);
      return reply;
    },
  },
};

const controller = require('../../src/controllers/opsCampaignController');
const { pickFromMap, pickQuestion } = require('../../src/utils/campaignI18n');

const SIMPLIFIED_TITLE = '点亮你的夏天';
const TRADITIONAL_TITLE = '點亮你的夏天';
const SIMPLIFIED_BLURB = '你的预订记录会讲述夏天。';
const TRADITIONAL_BLURB = '你的預訂紀錄會講述夏天。';

async function call(handler, req) {
  const res = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  await handler({ opsAdmin: { username: 'ops' }, params: {}, ...req }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  return res.body.data;
}

/** The admin's empty form, with copy written in Simplified Chinese only. */
function simplifiedDraft() {
  return {
    slug: 'summer-copy',
    template: 'HOME_CARD',
    copySource: 'zh',
    titleEn: '',
    titleZh: SIMPLIFIED_TITLE,
    titleJa: '',
    titleZhTw: '',
    blurbEn: '',
    blurbZh: SIMPLIFIED_BLURB,
    blurbJa: '',
    blurbZhTw: '',
    pillEn: '',
    pillZh: '',
    pillJa: '',
    pillZhTw: '',
    startsAt: '2026-10-01T00:00:00.000Z',
    endsAt: '2026-11-01T00:00:00.000Z',
    ctaKind: 'ROUTE',
    ctaValue: '/user/index',
    shareTextEn: '',
    shareTextZh: '',
    shareTextJa: '',
    shareTextZhTw: '',
  };
}

/** The admin form after loading a saved row: one-language columns, other languages from i18n. */
function formFromRow(row) {
  const i18n = row.config?.i18n || {};
  const pick = (key, locale) => i18n[key]?.[locale] || '';
  return {
    ...simplifiedDraft(),
    copySource: i18n.source || 'en',
    titleEn: row.titleEn,
    titleZh: row.titleZh,
    titleJa: pick('title', 'ja'),
    titleZhTw: pick('title', 'zh-TW'),
    blurbEn: row.blurbEn,
    blurbZh: row.blurbZh,
    blurbJa: pick('blurb', 'ja'),
    blurbZhTw: pick('blurb', 'zh-TW'),
    pillEn: row.pillEn || '',
    pillZh: row.pillZh || '',
    pillJa: pick('pill', 'ja'),
    pillZhTw: pick('pill', 'zh-TW'),
  };
}

/** The admin form for an application card after loading a saved row, question fields included. */
function applyFormFromRow(row) {
  const config = row.config || {};
  const i18n = config.i18n || {};
  const form = { ...formFromRow(row), slug: row.slug, template: row.template, seatCap: config.seatCap };
  for (const index of [1, 2, 3]) {
    const key = `question${index}`;
    form[`${key}En`] = config[`${key}En`] || '';
    form[`${key}Zh`] = config[`${key}Zh`] || '';
    form[`${key}Ja`] = i18n[key]?.ja || config[`${key}Ja`] || '';
    form[`${key}ZhTw`] = i18n[key]?.['zh-TW'] || config[`${key}ZhTw`] || '';
  }
  return form;
}

/** The admin's "translate the other languages" button: source field out, filled fields back in. */
async function translateForm(form) {
  const field = (prefix) =>
    form.copySource === 'zh-TW'
      ? form[`${prefix}ZhTw`]
      : form.copySource === 'zh'
        ? form[`${prefix}Zh`]
        : form.copySource === 'ja'
          ? form[`${prefix}Ja`]
          : form[`${prefix}En`];
  const data = await call(controller.translate, {
    body: { source: form.copySource, strings: { title: field('title'), blurb: field('blurb') } },
  });
  const next = { ...form };
  for (const prefix of ['title', 'blurb']) {
    const map = data[prefix] || {};
    next[`${prefix}En`] = map.en || form[`${prefix}En`];
    next[`${prefix}Zh`] = map.zh || form[`${prefix}Zh`];
    next[`${prefix}Ja`] = map.ja || form[`${prefix}Ja`];
    next[`${prefix}ZhTw`] = map['zh-TW'] || form[`${prefix}ZhTw`];
  }
  return next;
}

async function save(id, form) {
  return call(controller.update, { params: { id }, body: form });
}

function assertTraditional(row) {
  const i18n = row.config.i18n;
  assert.equal(i18n.title['zh-TW'], TRADITIONAL_TITLE);
  assert.equal(i18n.blurb['zh-TW'], TRADITIONAL_BLURB);
  assert.equal(pickFromMap(i18n.title, 'zh-TW'), TRADITIONAL_TITLE);
  assert.equal(i18n.title.zh, SIMPLIFIED_TITLE);
  assert.equal(i18n.source, 'zh');
}

describe('campaign copy written in Simplified Chinese, saved through the ops routes', () => {
  beforeEach(() => {
    rows.clear();
    prompts = [];
    reply = {
      title: { en: 'Light up your summer', 'zh-TW': TRADITIONAL_TITLE, ja: '夏を灯そう', ko: '여름을 밝혀요' },
      blurb: { en: 'Your bookings tell the story.', 'zh-TW': TRADITIONAL_BLURB, ja: '予約が夏の物語になる。' },
    };
  });

  for (const status of ['DRAFT', 'LIVE']) {
    it(`${status}: save, translate, save again keeps the Traditional copy under zh-TW`, async () => {
      const created = await call(controller.create, { body: simplifiedDraft() });
      assert.equal(created.config.i18n.source, 'zh');
      assert.equal(created.config.i18n.title['zh-TW'], '');
      assert.equal(created.config.i18n.title.zh, SIMPLIFIED_TITLE);
      assert.equal(pickFromMap(created.config.i18n.title, 'zh-TW'), SIMPLIFIED_TITLE);
      rows.get(created.id).status = status;

      const loaded = formFromRow(rows.get(created.id));
      assert.equal(loaded.copySource, 'zh');
      assert.equal(loaded.titleZh, SIMPLIFIED_TITLE);
      assert.equal(loaded.titleZhTw, '');

      const translated = await translateForm(loaded);
      assert.match(prompts[0], /Source language: Simplified Chinese \(zh\)\./);
      const saved = await save(created.id, translated);
      assertTraditional(saved);
      assert.equal(saved.titleZh, SIMPLIFIED_TITLE);
      assert.equal(saved.titleEn, 'Light up your summer');

      // Reload, translate again from the same Simplified source, save: still Traditional.
      const reloaded = formFromRow(rows.get(created.id));
      assert.equal(reloaded.copySource, 'zh');
      assert.equal(reloaded.titleZhTw, TRADITIONAL_TITLE);
      assertTraditional(await save(created.id, await translateForm(reloaded)));
      assert.match(prompts[1], /Source language: Simplified Chinese \(zh\)\./);
    });

    it(`${status}: an edit of a filled language after the first save is kept`, async () => {
      const created = await call(controller.create, { body: simplifiedDraft() });
      rows.get(created.id).status = status;
      await save(created.id, await translateForm(formFromRow(rows.get(created.id))));

      const form = formFromRow(rows.get(created.id));
      const edited = await save(created.id, {
        ...form,
        titleEn: 'Light up your whole summer',
        titleZhTw: '點亮你的整個夏天',
        blurbJa: '予約が夏の物語を語る。',
      });
      assert.equal(edited.titleEn, 'Light up your whole summer');
      assert.equal(edited.config.i18n.title.en, 'Light up your whole summer');
      assert.equal(edited.config.i18n.title['zh-TW'], '點亮你的整個夏天');
      assert.equal(edited.config.i18n.blurb.ja, '予約が夏の物語を語る。');
      assert.equal(edited.config.i18n.title.ja, '夏を灯そう');
      assert.equal(edited.config.i18n.title.zh, SIMPLIFIED_TITLE);
    });
  }

  it('an English-only card edited in English does not keep the old English for Chinese readers', async () => {
    const created = await call(controller.create, {
      body: { ...simplifiedDraft(), copySource: 'en', titleEn: 'Old title', titleZh: '', blurbEn: 'Old blurb', blurbZh: '' },
    });
    const form = formFromRow(rows.get(created.id));
    assert.equal(form.titleZh, 'Old title');
    const edited = await save(created.id, { ...form, titleEn: 'New title' });
    assert.equal(edited.config.i18n.title.en, 'New title');
    assert.equal(pickFromMap(edited.config.i18n.title, 'zh-TW'), 'New title');
  });
});

describe('application questions written in one language, edited, then saved again', () => {
  beforeEach(() => {
    rows.clear();
  });

  const cards = [
    {
      name: 'English-only',
      body: { copySource: 'en', titleEn: 'Apply', blurbEn: 'Join the cohort' },
      suffix: 'En',
      slot: 'en',
      before: 'Old question?',
      after: 'New question?',
    },
    {
      name: 'Japanese-only',
      body: { copySource: 'ja', titleJa: '応募', blurbJa: '参加しよう' },
      suffix: 'Ja',
      slot: 'ja',
      before: '古い質問？',
      after: '新しい質問？',
    },
  ];

  for (const status of ['DRAFT', 'LIVE']) {
    for (const card of cards) {
      it(`${status}: ${card.name} card keeps the edited question through later saves`, async () => {
        const created = await call(controller.create, {
          body: {
            ...simplifiedDraft(),
            slug: 'apply-copy',
            template: 'APPLY_COHORT',
            titleZh: '',
            blurbZh: '',
            ...card.body,
            seatCap: 20,
            [`question1${card.suffix}`]: card.before,
            [`question2${card.suffix}`]: `${card.before} 2`,
            [`question3${card.suffix}`]: `${card.before} 3`,
          },
        });
        rows.get(created.id).status = status;

        const assertQuestion = (row) => {
          const question = row.config.i18n.question1;
          assert.equal(question[card.slot], card.after);
          assert.equal(question.zh, undefined);
          assert.equal(Object.values(question).filter(Boolean).length, 1);
          assert.equal(row.config.question1En, card.after);
          assert.equal(row.config.question1Zh, card.after);
          for (const language of ['en', 'zh-TW', 'ja', 'ko']) {
            assert.equal(pickQuestion(row.config, 1, language), card.after, language);
          }
        };

        const edited = await save(created.id, {
          ...applyFormFromRow(rows.get(created.id)),
          [`question1${card.suffix}`]: card.after,
        });
        assertQuestion(edited);

        const again = await save(created.id, applyFormFromRow(rows.get(created.id)));
        assertQuestion(again);
        assert.deepEqual(again.config.i18n, edited.config.i18n);

        const titled = await save(created.id, { ...applyFormFromRow(rows.get(created.id)), titleEn: 'Apply now' });
        assertQuestion(titled);
        assert.deepEqual(titled.config.i18n.question2, edited.config.i18n.question2);
      });
    }
  }
});
