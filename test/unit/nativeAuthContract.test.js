/**
 * The closed error-code set of /api/auth/native/* (design §2.2), copied here from the table so a
 * drift in either direction fails. The frontend's errors.ts test asserts the same list.
 */
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const { listenLoopback } = require('../helpers/loopbackServer');

const { NATIVE_ERROR_CODES, TRANSPORT_CODES, NativeAuthError, sendError, sendNativeError, sendSuccess } = require('../../src/controllers/nativeAuth/respond');

const CONTRACT = {
  NATIVE_AUTH_DISABLED: 404, METHOD_DISABLED: 404,
  INVALID_EMAIL: 400, TURNSTILE_FAILED: 400,
  OTP_RESEND_TOO_SOON: 429, OTP_SEND_LIMITED: 429, OTP_SEND_UNAVAILABLE: 503,
  OTP_INVALID: 400, OTP_EXPIRED: 400, OTP_LOCKED: 400,
  IDP_TOKEN_INVALID: 401, IDP_NONCE_INVALID: 401, IDP_UNAVAILABLE: 503,
  X_HANDOFF_INVALID: 400,
  ACCOUNT_LINK_REQUIRED: 409, NEW_ACCOUNTS_CLOSED: 403, ACCOUNT_DISABLED: 403, ORG_NOT_ALLOWED: 403,
  LOGIN_EXPIRED: 400, LOGIN_TOKEN_LIMIT: 429,
  WALLET_PROOF_INVALID: 401, WALLET_NOT_DERIVED: 401, W3A_LOOKUP_UNAVAILABLE: 503,
  WALLET_REBIND_REQUIRED: 409, WALLET_MISMATCH: 409, WALLET_IN_USE: 400, LOGIN_RACE: 409,
  STEP_UP_REQUIRED: 401, STEP_UP_INVALID: 401,
  IDENTITY_ALREADY_LINKED: 409, IDENTITY_LAST_METHOD: 409,
};

describe('native error codes (§2.2)', () => {
  it('the table in respond.js is exactly the contract table', () => {
    assert.deepEqual({ ...NATIVE_ERROR_CODES }, CONTRACT);
    assert.deepEqual({ ...TRANSPORT_CODES }, { RATE_LIMITED: 429 });
  });

  it('the envelope: fail for 4xx, error for 5xx, data only when given', async () => {
    const app = express();
    app.get('/a', (req, res) => sendError(res, 'OTP_INVALID', { data: { attemptsLeft: 2 } }));
    app.get('/b', (req, res) => sendError(res, 'IDP_UNAVAILABLE'));
    app.get('/c', (req, res, next) => sendNativeError(res, next, new NativeAuthError('LOGIN_RACE')));
    app.get('/d', (req, res) => sendSuccess(res, { ok: 1 }, 201));
    const server = await listenLoopback(app);
    after(() => new Promise((resolve) => server.close(resolve)));
    const a = await request(server).get('/a');
    assert.equal(a.status, 400);
    assert.deepEqual(a.body, { status: 'fail', code: 'OTP_INVALID', message: 'OTP_INVALID', data: { attemptsLeft: 2 } });
    const b = await request(server).get('/b');
    assert.equal(b.status, 503);
    assert.equal(b.body.status, 'error');
    assert.equal('data' in b.body, false);
    assert.equal((await request(server).get('/c')).status, 409);
    const d = await request(server).get('/d');
    assert.equal(d.status, 201);
    assert.deepEqual(d.body, { status: 'success', data: { ok: 1 } });
  });
});
