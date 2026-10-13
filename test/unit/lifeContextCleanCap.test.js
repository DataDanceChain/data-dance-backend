/**
 * POST /api/life-context/clean takes at most CLEAN_MAX_TRACES records per call (one AI model
 * request) and clips each field before it reaches the prompt. The services are stand-ins: the
 * real ones need a database or the model.
 */
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

process.env.LOG_LEVEL = 'error';

const SRC = path.join(__dirname, '../../src');
const realGemini = require(path.join(SRC, 'services/lifeContextGemini.js'));
const stub = (rel, exportsValue) => {
  const filename = require.resolve(path.join(SRC, rel));
  require.cache[filename] = { id: filename, filename, loaded: true, exports: exportsValue, children: [] };
};

let calls = [];
stub('services/lifeContextGemini.js', {
  asRefined: realGemini.asRefined,
  cleanCrawlerTraces: async (traces, language) => {
    calls.push({ traces, language });
    return { keep: traces, drop: [], model: 'stub-model' };
  },
});
stub('services/lifeContextSettings.js', { getSettings: async () => ({}), upsertSettings: async () => ({}), saveRefined: async () => {} });
stub('services/lifeContextDistill.js', { loadPortrait: async () => ({}), loadVault: async () => ({}), refinePortrait: async () => {} });
stub('services/mcpTokenService.js', { issueMcpToken: async () => ({}), listMcpTokens: async () => [], revokeMcpToken: async () => true });

const { CLEAN_MAX_TRACES } = require('../../src/constants/lifeContext');
const { postClean } = require('../../src/controllers/lifeContextController');

function call(body) {
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
  return postClean({ body, user: { id: 'user-a' } }, res).then(() => res);
}

const rows = (n) => Array.from({ length: n }, (_, i) => ({ id: `r${i}`, source: 'amazon', title: `Item ${i}` }));

beforeEach(() => {
  calls = [];
});

describe('POST /api/life-context/clean record cap', () => {
  it('is sixty, the batch size the App sends', () => {
    assert.equal(CLEAN_MAX_TRACES, 60);
  });

  it('accepts a full batch in one model call', async () => {
    const res = await call({ language: 'ko', traces: rows(CLEAN_MAX_TRACES) });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status, 'success');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].traces.length, CLEAN_MAX_TRACES);
    assert.equal(calls[0].language, 'ko');
  });

  it('refuses a larger batch with 400 before calling the model', async () => {
    const res = await call({ language: 'en', traces: rows(CLEAN_MAX_TRACES + 1) });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.status, 'error');
    assert.match(res.body.message, /at most 60 records/);
    assert.equal(calls.length, 0);
  });

  it('clips each field before the prompt', async () => {
    await call({ traces: [{ id: 'x'.repeat(500), source: 's'.repeat(500), title: 't'.repeat(5000) }] });
    const [row] = calls[0].traces;
    assert.equal(row.id.length, 200);
    assert.equal(row.source.length, 40);
    assert.equal(row.title.length, 300);
  });
});

describe('distillation language hint', () => {
  it('names the four product languages', () => {
    assert.equal(realGemini.languageHint('en'), 'English');
    assert.equal(realGemini.languageHint('zh-CN'), 'Traditional Chinese');
    assert.equal(realGemini.languageHint('zh-TW'), 'Traditional Chinese');
    assert.equal(realGemini.languageHint('ja'), 'Japanese');
    assert.equal(realGemini.languageHint('ko-KR'), 'Korean');
  });
});
