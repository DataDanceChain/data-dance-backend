/**
 * POST /api/life-context/refined (saving a portrait extract), /refine and /clean (both call the AI
 * model) are throttled per signed-in user. protect and the controller are stand-ins: the real ones
 * need a database.
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
let refines = 0;
let cleans = 0;
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
  postRefine: (req, res) => {
    refines += 1;
    res.json({ status: 'success' });
  },
  postClean: (req, res) => {
    cleans += 1;
    res.json({ status: 'success' });
  },
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

const refine = (user) => request(app).post('/api/life-context/refine').set('x-test-user', user).send({ language: 'en' });
const clean = (user) =>
  request(app).post('/api/life-context/clean').set('x-test-user', user).send({ language: 'en', traces: [] });

beforeEach(() => {
  clearRateLimitStore();
  saves = 0;
  refines = 0;
  cleans = 0;
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

describe('POST /api/life-context/refine rate limit', () => {
  it('allows six distillations in ten minutes per user, then answers 429 without calling the model', async () => {
    for (let i = 0; i < 6; i += 1) assert.equal((await refine('user-a')).status, 200);
    const limited = await refine('user-a');
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers['retry-after']) >= 1);
    assert.equal(limited.body.status, 'error');
    assert.equal(refines, 6);
    assert.equal((await refine('user-b')).status, 200);
  });

  it('counts parallel requests on entry', async () => {
    const statuses = (await Promise.all(Array.from({ length: 10 }, () => refine('user-c')))).map((r) => r.status);
    assert.equal(statuses.filter((s) => s === 200).length, 6);
    assert.equal(refines, 6);
  });

  it('has its own bucket: saves and cleans do not spend it', async () => {
    for (let i = 0; i < 10; i += 1) await save('user-d');
    for (let i = 0; i < 10; i += 1) await clean('user-d');
    assert.equal((await refine('user-d')).status, 200);
  });
});

describe('POST /api/life-context/clean rate limit', () => {
  it('allows sixty batches in ten minutes per user, then answers 429 without calling the model', async () => {
    const statuses = (await Promise.all(Array.from({ length: 65 }, () => clean('user-a')))).map((r) => r.status);
    assert.equal(statuses.filter((s) => s === 200).length, 60);
    assert.equal(statuses.filter((s) => s === 429).length, 5);
    assert.equal(cleans, 60);
    assert.equal((await clean('user-b')).status, 200);
    assert.equal((await refine('user-a')).status, 200);
  });
});
