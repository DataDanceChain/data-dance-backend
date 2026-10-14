/**
 * auth.isOrganization: the middleware lets organization users through (and answers 403 otherwise)
 * without writing the user record to the console.
 */
const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');

Object.assign(process.env, { LOG_LEVEL: 'error' });

// auth.js builds a PrismaClient at load time; isOrganization never queries it.
const { Prisma } = require('@prisma/client');
require.cache[require.resolve('@prisma/client')].exports = {
  Prisma,
  PrismaClient: function PrismaClient() {
    return { user: { findUnique: async () => null } };
  },
};

const { isOrganization } = require('../../src/middlewares/auth');

function fakeRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

function orgUser(overrides = {}) {
  return {
    id: 'org-user-1',
    email: 'org@example.com',
    walletAddress: '0x0000000000000000000000000000000000000001',
    userType: 'organization',
    isOrganization: true,
    ...overrides,
  };
}

describe('isOrganization does not log the user', () => {
  let logSpy;

  beforeEach(() => {
    logSpy = mock.method(console, 'log', () => {});
  });

  afterEach(() => {
    logSpy.mock.restore();
  });

  function assertUserNotLogged(user) {
    for (const call of logSpy.mock.calls) {
      for (const arg of call.arguments) {
        assert.notEqual(arg, user, 'console.log received the user object');
      }
    }
    assert.equal(logSpy.mock.callCount(), 0);
  }

  it('passes an organization user (isOrganization flag) through silently', () => {
    const user = orgUser();
    const req = { user };
    const res = fakeRes();
    const next = mock.fn();

    isOrganization(req, res, next);

    assert.equal(next.mock.callCount(), 1);
    assert.equal(res.body, undefined);
    assertUserNotLogged(user);
  });

  it('passes an organization user (userType only) through silently', () => {
    const user = orgUser({ isOrganization: false });
    const req = { user };
    const res = fakeRes();
    const next = mock.fn();

    isOrganization(req, res, next);

    assert.equal(next.mock.callCount(), 1);
    assertUserNotLogged(user);
  });

  it('answers 403 for a non-organization user without logging it', () => {
    const user = orgUser({ userType: 'personal', isOrganization: false });
    const req = { user };
    const res = fakeRes();
    const next = mock.fn();

    isOrganization(req, res, next);

    assert.equal(next.mock.callCount(), 0);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.status, 'fail');
    assertUserNotLogged(user);
  });
});
