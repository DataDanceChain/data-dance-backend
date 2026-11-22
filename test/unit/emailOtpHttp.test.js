const { beforeEach, it } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const { installMockPrisma } = require('../helpers/mockPrisma');
const prisma = installMockPrisma();
const events = [];
const knownEmail = 'known@example.test';
const unknownEmail = 'unknown@example.test';
const callerId = 'client-provided-id';
let deliveredCode;
let mailFailure;

function replaceModule(path, exports) {
  const filename = require.resolve(path);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

replaceModule('../../src/utils/logger', {
  createLogger: () => ({
    info: (message, data) => events.push({ message, data }),
    error: (message, data) => events.push({ message, data }),
    warn() {},
  }),
});
replaceModule('../../src/utils/email', {
  async sendLoginCodeEmail(_email, code) {
    if (mailFailure) throw mailFailure;
    deliveredCode = code;
  },
});
replaceModule('../../src/controllers/authController', { register() {}, login() {} });

const authRoutes = require('../../src/routes/authRoutes');
const { requestIdMiddleware } = require('../../src/middlewares/requestIdMiddleware');
const { clearRateLimitStore } = require('../../src/middlewares/rateLimitMiddleware');
const { APP_REVIEW_EMAIL, APP_REVIEW_CODE, resetEmailOtpState } = require('../../src/services/emailOtpLogin');

const app = express();
app.use(requestIdMiddleware);
app.use(express.json());
app.use('/api/auth', authRoutes);

const post = (stage, body) => request(app)
  .post(`/api/auth/email-code/${stage}`)
  .set('X-Request-Id', callerId)
  .send(body);

function expectEvent(response, stage, reason) {
  const reqId = response.headers['x-request-id'];
  assert.match(reqId, /^[0-9a-f-]{36}$/);
  assert.notEqual(reqId, callerId);
  assert.deepEqual(events.filter((event) => event.data.reqId === reqId), [
    { message: 'email_otp_result', data: { reqId, stage, status: response.status, reason } },
  ]);
}

const record = { id: 'synthetic-id', email: knownEmail, web3authVerifier: 'google' };
const fakeDbError = new Error('internal database detail must not appear');

beforeEach(() => {
  process.env.EMAIL_OTP_LOGIN = 'true';
  process.env.JWT_SECRET = 'email-otp-http-unit-secret';
  process.env.JWT_EXPIRES_IN = '1h';
  clearRateLimitStore();
  resetEmailOtpState();
  events.length = 0;
  deliveredCode = undefined;
  mailFailure = undefined;
  prisma.user.findMany = async ({ where }) => where.email.equals === knownEmail ? [record] : [];
  prisma.user.findUnique = async () => record;
});

it('logs the same accepted outcome for both send branches and a uniform invalid-code response', async () => {
  const unknown = await post('send', { email: unknownEmail });
  assert.match(deliveredCode, /^\d{6}$/);
  const known = await post('send', { email: knownEmail });
  assert.equal(unknown.status, 200);
  assert.equal(known.status, 200);
  assert.deepEqual(unknown.body, { status: 'success', data: { accepted: true } });
  assert.deepEqual(known.body, unknown.body);
  expectEvent(known, 'send', 'accepted');
  expectEvent(unknown, 'send', 'accepted');

  const missing = await post('verify', { email: unknownEmail, code: '123456' });
  const wrongCode = deliveredCode === '000000' ? '111111' : '000000';
  const wrong = await post('verify', { email: knownEmail, code: wrongCode });
  const malformed = await post('verify', { email: knownEmail });
  assert.equal(missing.status, 401);
  assert.equal(wrong.status, 401);
  assert.equal(malformed.status, 401);
  assert.equal(missing.body.code, 'EMAIL_CODE_INVALID');
  assert.deepEqual(wrong.body, missing.body);
  assert.deepEqual(malformed.body, missing.body);
  expectEvent(missing, 'verify', 'invalid_code');
  expectEvent(wrong, 'verify', 'invalid_code');
  expectEvent(malformed, 'verify', 'invalid_input');

  const verified = await post('verify', { email: knownEmail, code: deliveredCode });
  assert.equal(verified.status, 200);
  assert.equal(verified.body.data.user.id, record.id);
  expectEvent(verified, 'verify', 'verified');
});

it('recovers the original Google account after a code without registering or changing its wallet', async () => {
  const walletAddress = '0x0000000000000000000000000000000000000001';
  const googleAccount = { ...record, authType: 'web3auth', walletAddress };
  prisma.user.findMany = async ({ where }) => where.email.equals === knownEmail ? [googleAccount] : [];
  prisma.user.create = async () => assert.fail('recovery must not create a user');
  prisma.user.update = async () => assert.fail('recovery must not change a user');
  prisma.user.updateMany = async () => assert.fail('recovery must not change a user');

  const unknown = await post('recovery/send', { email: unknownEmail });
  assert.equal(unknown.status, 200);
  assert.equal(deliveredCode, undefined);
  const sent = await post('recovery/send', { email: knownEmail });
  assert.deepEqual(sent.body, unknown.body);
  expectEvent(sent, 'recovery_send', 'accepted');
  assert.match(deliveredCode, /^\d{6}$/);

  const verified = await post('recovery/verify', { email: knownEmail, code: deliveredCode });
  assert.equal(verified.status, 200);
  assert.equal(verified.body.data.user.id, record.id);
  assert.equal(verified.body.data.user.walletAddress, walletAddress);
  const claims = jwt.verify(verified.body.data.token, process.env.JWT_SECRET);
  assert.equal(claims.id, record.id);
  assert.equal(claims.amr, 'email_otp');
  expectEvent(verified, 'recovery_verify', 'verified');
  assert.equal((await post('recovery/verify', { email: knownEmail, code: deliveredCode })).status, 401);
});

it('rejects a registration code and an account ID change during recovery', async () => {
  await post('send', { email: unknownEmail });
  assert.match(deliveredCode, /^\d{6}$/);
  const registrationCode = await post('recovery/verify', { email: unknownEmail, code: deliveredCode });
  assert.equal(registrationCode.status, 401);

  await post('recovery/send', { email: knownEmail });
  prisma.user.findMany = async () => [{ ...record, id: 'different-account-id' }];
  const reboundMailbox = await post('recovery/verify', { email: knownEmail, code: deliveredCode });
  assert.equal(reboundMailbox.status, 401);
  assert.deepEqual(reboundMailbox.body, registrationCode.body);
});

it('requires a delivered code and a unique active mailbox for recovery', async () => {
  const review = await post('recovery/verify', { email: APP_REVIEW_EMAIL, code: APP_REVIEW_CODE });
  assert.equal(review.status, 401);

  await post('recovery/send', { email: knownEmail });
  const code = deliveredCode;
  assert.match(code, /^\d{6}$/);
  prisma.user.findMany = async () => [record, { ...record, id: 'duplicate-account' }];
  assert.equal((await post('recovery/verify', { email: knownEmail, code })).status, 401);
});

it('correlates feature-off, validation and both 429 responses with the server request ID', async () => {
  process.env.EMAIL_OTP_LOGIN = 'false';
  for (const stage of ['send', 'verify']) {
    const disabled = await post(stage, { email: knownEmail });
    assert.equal(disabled.status, 404);
    assert.equal(disabled.body.code, 'EMAIL_LOGIN_UNAVAILABLE');
    expectEvent(disabled, stage, 'feature_disabled');
  }
  process.env.EMAIL_OTP_LOGIN = 'true';
  const malformed = await post('send', { email: 'invalid' });
  assert.equal(malformed.status, 400);
  assert.equal(malformed.body.code, 'INVALID_EMAIL');
  expectEvent(malformed, 'send', 'invalid_email');

  await post('send', { email: knownEmail });
  const addressLimit = await post('send', { email: knownEmail });
  assert.equal(addressLimit.status, 429);
  assert.equal(addressLimit.body.code, 'RATE_LIMITED');
  assert.equal(addressLimit.headers['retry-after'], String(addressLimit.body.retryAfter));
  expectEvent(addressLimit, 'send', 'address_throttled');

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const allowed = await post('send', { email: `other${attempt}@example.test` });
    assert.equal(allowed.status, 200);
  }
  const routeLimit = await post('send', { email: unknownEmail });
  assert.equal(routeLimit.status, 429);
  assert.equal(routeLimit.body.code, undefined);
  assert.equal(routeLimit.headers['retry-after'], String(routeLimit.body.retryAfter));
  expectEvent(routeLimit, 'send', 'request_throttled');
});

it('keeps upstream failures uniform outside the server and classifies them without raw data', async () => {
  prisma.user.findMany = async () => { throw fakeDbError; };
  const db = await post('send', { email: knownEmail });
  assert.equal(db.status, 503);
  assert.equal(db.body.code, 'EMAIL_LOGIN_UNAVAILABLE');
  expectEvent(db, 'send', 'db_lookup_failed');

  prisma.user.findMany = async () => [record];
  const smtpCases = [
    [{ code: 'EMAIL_DISABLED' }, 'smtp_configuration_missing'],
    [{ code: 'EAUTH', responseCode: 535 }, 'smtp_authentication_failed'],
    [{ code: 'EENVELOPE', responseCode: 550 }, 'smtp_provider_refused'],
    [{ code: 'ECONNECTION' }, 'smtp_send_failed'],
  ];
  for (const [properties, reason] of smtpCases) {
    resetEmailOtpState();
    mailFailure = Object.assign(new Error('internal mail detail must not appear'), properties);
    const smtp = await post('send', { email: knownEmail });
    assert.equal(smtp.status, 503);
    assert.deepEqual(smtp.body, db.body);
    expectEvent(smtp, 'send', reason);
  }

  resetEmailOtpState();
  mailFailure = undefined;
  await post('send', { email: knownEmail });
  prisma.user.findUnique = async () => { throw fakeDbError; };
  const verifyDb = await post('verify', { email: knownEmail, code: deliveredCode });
  assert.equal(verifyDb.status, 503);
  assert.deepEqual(verifyDb.body, db.body);
  expectEvent(verifyDb, 'verify', 'db_lookup_failed');

  resetEmailOtpState();
  await post('send', { email: knownEmail });
  prisma.user.findUnique = async () => record;
  delete process.env.JWT_SECRET;
  const unexpected = await post('verify', { email: knownEmail, code: deliveredCode });
  assert.equal(unexpected.status, 500);
  assert.deepEqual(unexpected.body, { status: 'error', message: 'Server error' });
  expectEvent(unexpected, 'verify', 'unexpected_failure');
});
