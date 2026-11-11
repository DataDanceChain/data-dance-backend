const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'email-otp-unit-secret';
process.env.JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '1h';

const {
  resetEmailOtpState,
  requestEmailLoginCode,
  verifyEmailLoginCode,
  CODE_TTL_MS,
  RESEND_INTERVAL_MS,
  MAX_SENDS_PER_HOUR,
  MAX_ATTEMPTS,
} = require('../../src/services/emailOtpLogin');
const { rejectEmailOtpSession } = require('../../src/middlewares/emailOtpSession');
const { registrationDecision } = require('../../src/constants/developerRegistration');

const ON = { EMAIL_OTP_LOGIN: 'true' };
const NOW = 1_700_000_000_000;

function user(overrides = {}) {
  return {
    id: 'user-1',
    email: 'ada@example.com',
    password: 'hashed',
    privateKey: 'secret-key',
    xAccessToken: 'x-token',
    xRefreshToken: 'x-refresh',
    web3authVerifier: 'google',
    disabledAt: null,
    referralCode: 'ABC123',
    ...overrides,
  };
}

function harness(rows, options = {}) {
  const sent = [];
  const db = Array.isArray(rows) ? rows : [rows];
  const findUsersByEmail = async (email) => {
    const bound = db.find((row) => row.loginEmail?.email === email);
    return bound ? [bound] : db.filter((row) => row.email.toLowerCase() === email);
  };
  return {
    sent,
    async send(email) {
      const result = await requestEmailLoginCode({
        email,
        now: options.now ?? NOW,
        env: ON,
        findUsersByEmail,
        sendMail: async (to, code) => {
          if (options.failSend) throw new Error('smtp down');
          sent.push({ to, code });
        },
        randomCode: () => options.code || '123456',
      });
      return result;
    },
    verify(email, code, now = options.now ?? NOW) {
      return verifyEmailLoginCode({
        email,
        code,
        now,
        env: ON,
        findUsersByEmail,
      });
    },
  };
}

describe('email login codes', () => {
  beforeEach(() => resetEmailOtpState());

  it('stays closed unless the switch is exactly true, and does not send', async () => {
    let sent = 0;
    const result = await requestEmailLoginCode({
      email: 'ada@example.com',
      env: {},
      findUsersByEmail: async () => [user()],
      sendMail: async () => { sent += 1; },
    });
    assert.equal(result.status, 404);
    assert.equal(result.body.code, 'EMAIL_LOGIN_UNAVAILABLE');
    assert.equal(sent, 0);
  });

  it('rejects a malformed address before any lookup', async () => {
    let looked = 0;
    const result = await requestEmailLoginCode({
      email: 'not-an-email',
      env: ON,
      findUsersByEmail: async () => { looked += 1; return []; },
      sendMail: async () => { throw new Error('should not send'); },
    });
    assert.equal(result.status, 400);
    assert.equal(looked, 0);
  });

  it('accepts an unknown address without sending or creating an account', async () => {
    const box = harness([]);
    const result = await box.send('missing@example.com');
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { status: 'success', data: { accepted: true } });
    assert.deepEqual(box.sent, []);
    const again = await box.send('missing@example.com');
    assert.equal(again.status, 429);
  });

  it('mails one code to an existing mailbox and signs that account in once', async () => {
    const box = harness(user());
    const sent = await box.send('Ada@Example.com');
    assert.equal(sent.status, 200);
    assert.equal(box.sent.length, 1);
    assert.equal(box.sent[0].to, 'ada@example.com');
    assert.match(box.sent[0].code, /^\d{6}$/);

    const wrong = await box.verify('ada@example.com', '000000');
    assert.equal(wrong.status, 401);
    assert.equal(wrong.body.code, 'EMAIL_CODE_INVALID');

    const ok = await box.verify('ada@example.com', '123456');
    assert.equal(ok.status, 200);
    assert.equal(ok.body.data.user.email, 'ada@example.com');
    assert.equal(ok.body.data.user.password, undefined);
    assert.equal(ok.body.data.user.privateKey, undefined);
    assert.equal(ok.body.data.user.xAccessToken, undefined);
    const claims = jwt.verify(ok.body.data.token, process.env.JWT_SECRET);
    assert.equal(claims.id, 'user-1');
    assert.equal(claims.ver, 2);
    assert.equal(claims.amr, 'email_otp');
    assert.equal(JSON.stringify(ok.body).includes('123456'), false);

    const replay = await box.verify('ada@example.com', '123456');
    assert.equal(replay.status, 401);
  });

  it('does not mail an X login or a disabled account', async () => {
    const twitter = harness(user({ web3authVerifier: 'twitter', email: 'ada@example.com' }));
    assert.equal((await twitter.send('ada@example.com')).status, 200);
    assert.deepEqual(twitter.sent, []);

    resetEmailOtpState();
    const disabled = harness(user({ disabledAt: new Date() }));
    assert.equal((await disabled.send('ada@example.com')).status, 200);
    assert.deepEqual(disabled.sent, []);
  });

  it('uses a verified X recovery mailbox ahead of a later legacy match and rechecks its owner', async () => {
    const recovery = { email: 'recovery@example.com', verifiedAt: new Date(NOW) };
    const xUser = user({ web3authVerifier: 'twitter', email: 'twitter|123', loginEmail: recovery });
    const rows = [xUser];
    const box = harness(rows);
    assert.equal((await box.send(recovery.email)).status, 200);
    assert.deepEqual(box.sent, [{ to: recovery.email, code: '123456' }]);
    rows.push(user({ id: 'other', email: 'RECOVERY@example.com' }));
    const result = await box.verify(recovery.email, '123456');
    assert.equal(result.status, 200);
    assert.equal(result.body.data.user.id, xUser.id);
    assert.equal(result.body.data.user.email, 'twitter|123');
    assert.equal('loginEmail' in result.body.data.user, false);

    const later = harness(rows, { now: NOW + RESEND_INTERVAL_MS });
    await later.send(recovery.email);
    xUser.disabledAt = new Date(NOW);
    assert.equal((await later.verify(recovery.email, '123456')).status, 401);
    const stillLater = harness(rows, { now: NOW + 2 * RESEND_INTERVAL_MS });
    await stillLater.send(recovery.email);
    assert.deepEqual(stillLater.sent, []);
  });

  it('waits a minute between codes and stops after the hourly cap', async () => {
    const box = harness(user(), { now: NOW });
    assert.equal((await box.send('ada@example.com')).status, 200);
    const early = await requestEmailLoginCode({
      email: 'ada@example.com',
      now: NOW + 1000,
      env: ON,
      findUsersByEmail: async () => [user()],
      sendMail: async () => { throw new Error('should not send'); },
    });
    assert.equal(early.status, 429);

    const later = await requestEmailLoginCode({
      email: 'ada@example.com',
      now: NOW + RESEND_INTERVAL_MS,
      env: ON,
      findUsersByEmail: async () => [user()],
      sendMail: async () => {},
      randomCode: () => '654321',
    });
    assert.equal(later.status, 200);

    resetEmailOtpState();
    for (let i = 0; i < MAX_SENDS_PER_HOUR; i += 1) {
      const result = await requestEmailLoginCode({
        email: 'ada@example.com',
        now: NOW + i * RESEND_INTERVAL_MS,
        env: ON,
        findUsersByEmail: async () => [user()],
        sendMail: async () => {},
      });
      assert.equal(result.status, 200);
    }
    const capped = await requestEmailLoginCode({
      email: 'ada@example.com',
      now: NOW + MAX_SENDS_PER_HOUR * RESEND_INTERVAL_MS,
      env: ON,
      findUsersByEmail: async () => [user()],
      sendMail: async () => { throw new Error('should not send'); },
    });
    assert.equal(capped.status, 429);
  });

  it('retires a code after five wrong attempts and when it expires', async () => {
    const box = harness(user());
    await box.send('ada@example.com');
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
      assert.equal((await box.verify('ada@example.com', '000000')).status, 401);
    }
    assert.equal((await box.verify('ada@example.com', '123456')).status, 401);

    resetEmailOtpState();
    const fresh = harness(user());
    await fresh.send('ada@example.com');
    const expired = await fresh.verify('ada@example.com', '123456', NOW + CODE_TTL_MS + 1);
    assert.equal(expired.status, 401);
  });

  it('does not keep a code when the mailer fails', async () => {
    const box = harness(user(), { failSend: true });
    const result = await box.send('ada@example.com');
    assert.equal(result.status, 503);
    assert.equal((await box.verify('ada@example.com', '123456')).status, 401);
  });

  it('refuses wallet changes and developer registration on this session', async () => {
    const app = express();
    app.use(express.json());
    app.post('/wallet', (req, _res, next) => {
      req.authClaims = { amr: 'email_otp', ver: 2 };
      next();
    }, rejectEmailOtpSession, (_req, res) => res.json({ ok: true }));
    const blocked = await request(app).post('/wallet');
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.code, 'EMAIL_OTP_SESSION_RESTRICTED');

    const decision = registrationDecision(
      user({ web3authVerifier: 'google', web3authVerifierId: 'ada@example.com' }),
      { ver: 2, amr: 'email_otp' },
      { mode: 'on', open: true, allowedEmails: [], trustedVerifiers: ['google'] },
    );
    assert.deepEqual(decision, { allowed: false, reason: 'session_not_verified' });
  });
});
