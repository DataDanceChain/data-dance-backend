/**
 * authMiddleware.protect / auth.authenticate: which failures are a 401 (issue #2).
 *
 * Before the fix, every throw inside `protect` (a Prisma connection error included) was answered
 * with 401 "Unauthorized access. Please login again." and nothing was logged, so a database blip
 * logged every Wallet user out. Here the user lookup is driven through a fake PrismaClient whose
 * `findUnique` throws each error class, and the tokens are real jsonwebtoken output.
 */
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

// Keep the real Prisma error classes before the module is replaced by the stand-in below.
const { Prisma } = require('@prisma/client');

const JWT_SECRET = 'protect-unit-test-secret';
Object.assign(process.env, { JWT_SECRET, LOG_LEVEL: 'error' });
delete process.env.NODE_ENV;

// One controllable user lookup, shared by both middlewares (each builds its own PrismaClient).
const db = { findUnique: async () => null };
require.cache[require.resolve('@prisma/client')].exports = {
  Prisma,
  PrismaClient: function PrismaClient() {
    return { user: { findUnique: (args) => db.findUnique(args) } };
  },
};

// Capture every log line the middlewares write.
const logs = [];
const realLogger = require('../../src/utils/logger');
require.cache[require.resolve('../../src/utils/logger')].exports = {
  ...realLogger,
  createLogger: (name) => ({
    info: (message, meta) => logs.push({ level: 'info', name, message, meta }),
    warn: (message, meta) => logs.push({ level: 'warn', name, message, meta }),
    error: (message, meta) => logs.push({ level: 'error', name, message, meta }),
    debug: () => {},
    http: () => {},
  }),
};

const { protect } = require('../../src/middlewares/authMiddleware');
const { authenticate } = require('../../src/middlewares/auth');
const { errorHandler } = require('../../src/middlewares/errorMiddleware');
const {
  classifyAuthError,
  PRISMA_UNAVAILABLE_CODES,
  RETRY_AFTER_SECONDS,
} = require('../../src/middlewares/authErrors');

const app = express();
app.get('/protect', protect, (req, res) => res.json({ status: 'success', data: { id: req.user.id } }));
app.get('/authenticate', authenticate, (req, res) => res.json({ status: 'success', data: { id: req.user.id } }));
// Same wiring as src/app.js: unexpected errors reach the app's handler.
app.use(errorHandler);

const user = { id: 'user-1', email: 'sloan@example.com', disabledAt: null };
const PROTECT_401 = 'Unauthorized access. Please login again.';

function token(extra = {}, options = { expiresIn: '1h' }) {
  return jwt.sign({ id: user.id, ...extra }, JWT_SECRET, options);
}

function get(path, bearer) {
  const call = request(app).get(path);
  if (bearer !== undefined) call.set('Authorization', bearer);
  return call;
}

function errorLogs() {
  return logs.filter((line) => line.level === 'error');
}

/** Every string in a log line (message, meta values, nested) must be free of the token. */
function assertTokenNotLogged(bearerToken) {
  const text = JSON.stringify(logs);
  assert.ok(!text.includes(bearerToken), `token leaked into a log line: ${text}`);
}

// The Prisma classes as `@prisma/client` 5 builds them (name + code are what the classifier reads).
const prismaErrors = {
  init: () => new Prisma.PrismaClientInitializationError("Can't reach database server at `db:5432`", '5.0.0', 'P1001'),
  known: (code) => new Prisma.PrismaClientKnownRequestError(`prisma known ${code}`, { code, clientVersion: '5.0.0' }),
  panic: () => new Prisma.PrismaClientRustPanicError('query engine panicked', '5.0.0'),
};

beforeEach(() => {
  logs.length = 0;
  db.findUnique = async () => user;
});

describe('classifyAuthError', () => {
  it('names the three JWT errors, the connection-class Prisma errors, and nothing else', () => {
    for (const name of ['JsonWebTokenError', 'TokenExpiredError', 'NotBeforeError']) {
      assert.equal(classifyAuthError(Object.assign(new Error('x'), { name })), 'jwt', name);
    }
    assert.equal(classifyAuthError(prismaErrors.init()), 'db_unavailable');
    assert.equal(classifyAuthError(prismaErrors.panic()), 'db_unavailable');
    for (const code of PRISMA_UNAVAILABLE_CODES) {
      assert.equal(classifyAuthError(prismaErrors.known(code)), 'db_unavailable', code);
    }
    // A constraint violation is a bug in the query, not an outage.
    assert.equal(classifyAuthError(prismaErrors.known('P2002')), 'unexpected');
    assert.equal(classifyAuthError(new Error('boom')), 'unexpected');
    assert.equal(classifyAuthError(undefined), 'unexpected');
  });
});

describe('protect: real authentication failures stay 401 with the same message text', () => {
  it('no Authorization header', async () => {
    const res = await get('/protect');
    assert.equal(res.status, 401);
    assert.deepEqual(res.body, { status: 'fail', message: 'Authentication required. Please login first.' });
    assert.equal(errorLogs().length, 0);
  });

  it('malformed header (scheme only / wrong scheme)', async () => {
    for (const header of ['Bearer', 'Bearer ', 'Basic abc']) {
      const res = await get('/protect', header);
      assert.equal(res.status, 401, header);
      assert.equal(res.body.status, 'fail');
    }
    assert.equal(errorLogs().length, 0);
  });

  it('invalid JWT', async () => {
    const res = await get('/protect', 'Bearer not.a.jwt');
    assert.equal(res.status, 401);
    assert.deepEqual(res.body, { status: 'fail', message: PROTECT_401 });
    assert.equal(errorLogs().length, 0, 'a bad token is not an incident');
  });

  it('JWT signed with another secret', async () => {
    const res = await get('/protect', `Bearer ${jwt.sign({ id: user.id }, 'other-secret')}`);
    assert.equal(res.status, 401);
    assert.deepEqual(res.body, { status: 'fail', message: PROTECT_401 });
  });

  it('expired JWT', async () => {
    const res = await get('/protect', `Bearer ${token({}, { expiresIn: -60 })}`);
    assert.equal(res.status, 401);
    assert.deepEqual(res.body, { status: 'fail', message: PROTECT_401 });
    assert.equal(errorLogs().length, 0);
  });

  it('JWT not yet valid (NotBeforeError)', async () => {
    const res = await get('/protect', `Bearer ${token({}, { notBefore: '1h' })}`);
    assert.equal(res.status, 401);
    assert.deepEqual(res.body, { status: 'fail', message: PROTECT_401 });
  });

  it('JWT without a user id is 401, not a query', async () => {
    let called = false;
    db.findUnique = async () => { called = true; return user; };
    const res = await get('/protect', `Bearer ${jwt.sign({ sub: 'ops', type: 'ops_admin' }, JWT_SECRET)}`);
    assert.equal(res.status, 401);
    assert.deepEqual(res.body, { status: 'fail', message: PROTECT_401 });
    assert.equal(called, false);
  });

  it('user not found', async () => {
    db.findUnique = async () => null;
    const res = await get('/protect', `Bearer ${token()}`);
    assert.equal(res.status, 401);
    assert.deepEqual(res.body, { status: 'fail', message: 'User associated with this token does not exist' });
    assert.equal(errorLogs().length, 0);
  });

  it('valid JWT and user passes; disabled account is 403', async () => {
    assert.equal((await get('/protect', `Bearer ${token()}`)).status, 200);
    db.findUnique = async () => ({ ...user, disabledAt: new Date() });
    const res = await get('/protect', `Bearer ${token()}`);
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'ACCOUNT_DISABLED');
  });
});

describe('protect: a database outage is 503 + Retry-After, logged, token kept out of the log', () => {
  const cases = [
    ['PrismaClientInitializationError', prismaErrors.init],
    ['PrismaClientRustPanicError', prismaErrors.panic],
    ...[...PRISMA_UNAVAILABLE_CODES].map((code) => [`PrismaClientKnownRequestError ${code}`, () => prismaErrors.known(code)]),
  ];

  for (const [label, make] of cases) {
    it(label, async () => {
      const error = make();
      db.findUnique = async () => { throw error; };
      const bearer = token();
      const res = await get('/protect', `Bearer ${bearer}`);

      assert.equal(res.status, 503, res.text);
      assert.equal(res.headers['retry-after'], String(RETRY_AFTER_SECONDS));
      assert.deepEqual(res.body, {
        status: 'error',
        code: 'DATABASE_UNAVAILABLE',
        message: 'Service temporarily unavailable. Please try again shortly.',
      });
      assert.notEqual(res.body.message, PROTECT_401, 'must not look like an auth failure to the Wallet');

      const lines = errorLogs();
      assert.equal(lines.length, 1, JSON.stringify(logs));
      assert.equal(lines[0].meta.errorName, error.name);
      assert.equal(lines[0].meta.errorMessage, error.message);
      assert.equal(lines[0].meta.kind, 'db_unavailable');
      assertTokenNotLogged(bearer);
    });
  }
});

describe('protect: any other error is logged and handed to the app error handler (500)', () => {
  it('PrismaClientKnownRequestError with a non-connection code', async () => {
    const error = prismaErrors.known('P2002');
    db.findUnique = async () => { throw error; };
    const bearer = token();
    const res = await get('/protect', `Bearer ${bearer}`);

    assert.equal(res.status, 500, res.text);
    assert.equal(res.headers['retry-after'], undefined);
    // Shape produced by src/middlewares/errorMiddleware.js for next(error).
    assert.equal(res.body.status, 'error');
    assert.equal(res.body.message, error.message);
    assert.ok('stack' in res.body);
    assert.notEqual(res.body.message, PROTECT_401);

    const lines = errorLogs();
    assert.equal(lines.length, 1);
    assert.equal(lines[0].meta.errorName, 'PrismaClientKnownRequestError');
    assert.equal(lines[0].meta.errorCode, 'P2002');
    assert.equal(lines[0].meta.kind, 'unexpected');
    assertTokenNotLogged(bearer);
  });

  it('an error whose message quotes the token is logged with the token masked', async () => {
    const bearer = token();
    db.findUnique = async () => { throw new Error(`lookup failed for Bearer ${bearer}`); };
    const res = await get('/protect', `Bearer ${bearer}`);

    assert.equal(res.status, 500);
    const lines = errorLogs();
    assert.equal(lines.length, 1);
    assert.equal(lines[0].meta.errorMessage, 'lookup failed for Bearer [redacted]');
    assertTokenNotLogged(bearer);
  });
});

describe('auth.authenticate follows the same contract', () => {
  it('JWT errors are 401 with the existing messages', async () => {
    let res = await get('/authenticate', 'Bearer not.a.jwt');
    assert.equal(res.status, 401);
    assert.deepEqual(res.body, { status: 'fail', message: '无效的认证令牌' });

    res = await get('/authenticate', `Bearer ${token({}, { expiresIn: -60 })}`);
    assert.equal(res.status, 401);
    assert.deepEqual(res.body, { status: 'fail', message: '认证令牌已过期' });

    res = await get('/authenticate', `Bearer ${token({}, { notBefore: '1h' })}`);
    assert.equal(res.status, 401, 'NotBeforeError used to fall through to 500');
    assert.deepEqual(res.body, { status: 'fail', message: '无效的认证令牌' });

    res = await get('/authenticate', `Bearer ${jwt.sign({ sub: 'ops' }, JWT_SECRET)}`);
    assert.equal(res.status, 401);

    assert.equal(errorLogs().length, 0);
  });

  it('missing header / user not found / disabled keep their responses', async () => {
    assert.equal((await get('/authenticate')).status, 401);
    db.findUnique = async () => null;
    let res = await get('/authenticate', `Bearer ${token()}`);
    assert.equal(res.status, 401);
    assert.deepEqual(res.body, { status: 'fail', message: '用户不存在' });
    db.findUnique = async () => ({ ...user, disabledAt: new Date() });
    res = await get('/authenticate', `Bearer ${token()}`);
    assert.equal(res.status, 403);
    db.findUnique = async () => user;
    assert.equal((await get('/authenticate', `Bearer ${token()}`)).status, 200);
  });

  it('database outage is 503 + Retry-After, logged without the token', async () => {
    for (const make of [prismaErrors.init, prismaErrors.panic, () => prismaErrors.known('P1017')]) {
      logs.length = 0;
      const error = make();
      db.findUnique = async () => { throw error; };
      const bearer = token();
      const res = await get('/authenticate', `Bearer ${bearer}`);

      assert.equal(res.status, 503, res.text);
      assert.equal(res.headers['retry-after'], String(RETRY_AFTER_SECONDS));
      assert.deepEqual(res.body, { status: 'error', code: 'DATABASE_UNAVAILABLE', message: '数据库暂时不可用，请稍后重试' });
      assert.equal(errorLogs().length, 1);
      assert.equal(errorLogs()[0].meta.errorName, error.name);
      assertTokenNotLogged(bearer);
    }
  });

  it('unexpected error goes to the app error handler (500) and is logged without the token', async () => {
    const bearer = token();
    db.findUnique = async () => { throw new Error(`boom ${bearer}`); };
    const res = await get('/authenticate', `Bearer ${bearer}`);
    assert.equal(res.status, 500);
    assert.equal(res.body.status, 'error');
    assert.equal(errorLogs().length, 1);
    assert.equal(errorLogs()[0].meta.errorMessage, 'boom [redacted]');
    assertTokenNotLogged(bearer);
  });
});
