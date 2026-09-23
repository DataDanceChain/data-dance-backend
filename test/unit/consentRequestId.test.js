/**
 * POST /api/oauth/consent with a missing or malformed `requestId` is a client error.
 *
 * It used to reach `prisma.oAuthAuthorization.findUnique({ where: { id: undefined } })`, which the
 * real Prisma client rejects with a PrismaClientValidationError — answered as 500 server_error
 * and logged at error level. The in-memory mock accepts `undefined` silently, so this suite makes
 * findUnique behave like the real client for exactly that input.
 */
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const { installMockPrisma } = require('../helpers/mockPrisma');

const prisma = installMockPrisma();
require.cache[require.resolve('@prisma/client')].exports = {
  PrismaClient: function PrismaClient() {
    return prisma;
  },
};

// Real Prisma: a unique lookup whose key is undefined/null is a validation error, not "no row".
const realFindUnique = prisma.oAuthAuthorization.findUnique.bind(prisma.oAuthAuthorization);
prisma.oAuthAuthorization.findUnique = async (args) => {
  if (!args || !args.where || args.where.id === undefined || args.where.id === null) {
    const err = new Error('Invalid `prisma.oAuthAuthorization.findUnique()` invocation: Argument `id` must not be null.');
    err.name = 'PrismaClientValidationError';
    throw err;
  }
  return realFindUnique(args);
};

const JWT_SECRET = 'ddc-user-session-secret';
Object.assign(process.env, {
  LOG_LEVEL: 'error',
  WEB3AUTH_VERIFY_MODE: 'off',
  APNS_KEY_ID: 'TESTKEY001',
  APNS_TEAM_ID: 'TESTTEAM01',
  SSO_ENVIRONMENT: 'test',
  SSO_TGE_ENABLED: 'true',
  SSO_TGE_CLIENT_ID: 'tge-test',
  SSO_TGE_CLIENT_SECRET_SHA256: crypto.createHash('sha256').update('tge-secret-dev').digest('hex'),
  SSO_TGE_REDIRECT_URIS: 'https://tge.example.com/oauth/callback',
  PUBLIC_BASE_URL: 'https://api.test.local',
  APP_PUBLIC_URL: 'https://app.test.local',
  JWT_SECRET,
  SSO_SESSION_SECRET: 'ddc-sso-session-secret-different',
});

const app = require('../../src/app');
const { clearRateLimitStore } = require('../../src/middlewares/rateLimitMiddleware');

const user = { id: 'user-rid-1', email: 'rid@example.com', isOrganization: false, userType: 'regular', disabledAt: null };
const bearer = () => `Bearer ${jwt.sign({ id: user.id, ver: 2 }, JWT_SECRET, { expiresIn: '5m' })}`;

describe('POST /api/oauth/consent requestId validation', () => {
  beforeEach(() => {
    clearRateLimitStore();
    prisma.user.rows.splice(0, prisma.user.rows.length, { ...user });
  });

  for (const [label, body] of [
    ['missing', { allow: true }],
    ['null', { requestId: null, allow: true }],
    ['empty string', { requestId: '', allow: false }],
    ['not a string', { requestId: { id: 'x' }, allow: true }],
    ['absurdly long', { requestId: 'r'.repeat(300), allow: true }],
  ]) {
    it(`${label} requestId → 400 invalid_request, never 500`, async () => {
      const res = await request(app).post('/api/oauth/consent').set('Authorization', bearer()).send(body);
      assert.equal(res.status, 400, `got ${res.status} ${JSON.stringify(res.body)}`);
      assert.equal(res.body.error, 'invalid_request');
      assert.match(res.body.error_description, /requestId/);
    });
  }

  it('a well-formed but unknown requestId is still the ordinary "expired" answer', async () => {
    const res = await request(app).post('/api/oauth/consent').set('Authorization', bearer()).send({ requestId: 'no-such-request', allow: true });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'invalid_request');
    assert.match(res.body.error_description, /expired/);
  });
});
