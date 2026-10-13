/**
 * POST /api/life-context/refined (saving a portrait extract) is throttled per signed-in user.
 * protect and the controller are stand-ins: the real ones need a database.
 */
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const express = require('express');
const request = require('supertest');

process.env.LOG_LEVEL = 'error';

const SRC = path.join(__dirname, '../../src');
const stub = (rel, exportsValue) => {
  const filename = require.resolve(path.join(SRC, rel));
  require.cache[filename] = { id: filename, filename, loaded: true, exports: exportsValue, children: [] };
};

let saves = 0;
const ok = (req, res) => res.json({ status: 'success' });
stub('middlewares/authMiddleware.js', {
  protect: (req, res, next) => {
    req.user = { id: req.get('x-test-user') || 'user-a' };
    next();
  },
});
stub('controllers/lifeContextController.js', {
  getStatus: ok,
  updateSettings: ok,
  getTokens: ok,
  createToken: ok,
  deleteToken: ok,
  postRefine: ok,
  postClean: ok,
  postSavedRefined: (req, res) => {
    saves += 1;
    res.json({ status: 'success' });
  },
});

const lifeContextRoutes = require('../../src/routes/lifeContextRoutes');
const { clearRateLimitStore } = require('../../src/middlewares/rateLimitMiddleware');

const app = express();
app.use(express.json());
app.use('/api/life-context', lifeContextRoutes);

const save = (user) => request(app).post('/api/life-context/refined').set('x-test-user', user).send({ refined: {} });

beforeEach(() => {
  clearRateLimitStore();
  saves = 0;
});

describe('POST /api/life-context/refined rate limit', () => {
  it('allows ten saves a minute per user, then answers 429 without saving', async () => {
    for (let i = 0; i < 10; i += 1) assert.equal((await save('user-a')).status, 200);
    const limited = await save('user-a');
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers['retry-after']) >= 1);
    assert.equal(limited.body.status, 'error');
    assert.equal(saves, 10);
  });

  it('counts each user on their own', async () => {
    for (let i = 0; i < 10; i += 1) await save('user-a');
    assert.equal((await save('user-a')).status, 429);
    assert.equal((await save('user-b')).status, 200);
  });

  it('counts parallel requests on entry', async () => {
    const statuses = (await Promise.all(Array.from({ length: 20 }, () => save('user-c')))).map((r) => r.status);
    assert.equal(statuses.filter((s) => s === 200).length, 10);
    assert.equal(statuses.filter((s) => s === 429).length, 10);
  });
});
