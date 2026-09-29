/**
 * Log redaction for native login (design §3.7, §3.13, F3/F17): the new secret-bearing keys are
 * masked in meta objects and URLs, JWT-shaped strings are masked anywhere in free text, and
 * legacy log fields that share a key name (Web3Auth connection names under `verifier`) stay
 * readable.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

process.env.LOG_LEVEL = 'error';

const { redactObject, redactString, redactUrl, SENSITIVE_QUERY_KEYS, SENSITIVE_META_KEYS } = require('../../src/utils/logger');

const NEW_KEYS = ['loginId', 'loginSecret', 'handoff', 'verifier', 'nonce', 'credential', 'identityToken', 'signature', 'turnstileToken', 'idToken', 'code'];
const LONG = 'Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZg';
const JWT = 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIwMDAwMDAwMC0wMDAwIn0.c2lnbmF0dXJlLWJ5dGVz';

describe('native login redaction', () => {
  it('lists every key of the contract in both key sets', () => {
    for (const key of NEW_KEYS) {
      assert.ok(SENSITIVE_QUERY_KEYS.includes(key), `${key} missing from SENSITIVE_QUERY_KEYS`);
      assert.ok(SENSITIVE_META_KEYS.includes(key), `${key} missing from SENSITIVE_META_KEYS`);
    }
  });

  it('masks each key in meta objects, nested ones included', () => {
    for (const key of NEW_KEYS) {
      const out = redactObject({ [key]: LONG, nested: { [key]: LONG } });
      assert.ok(!JSON.stringify(out).includes(LONG), `${key} leaked: ${JSON.stringify(out)}`);
    }
  });

  it('hides a loginSecret entirely, not even a prefix', () => {
    assert.equal(redactObject({ loginSecret: LONG }).loginSecret, '[redacted]');
  });

  it('masks each key in URLs', () => {
    for (const key of NEW_KEYS) {
      const out = redactUrl(`/api/auth/native/x/callback?${key}=${LONG}&keep=1`);
      assert.ok(!out.includes(LONG), `${key} leaked: ${out}`);
      assert.ok(out.includes('keep=1'));
    }
  });

  it('masks a JWT anywhere in free text, keeping only a 4-char prefix', () => {
    const out = redactString(`google-auth-library: Wrong recipient, payload audience != requiredAudience; token ${JWT} rejected`);
    assert.ok(!out.includes(JWT.split('.')[1]), out);
    assert.match(out, /token eyJh…\(len=\d+\) rejected/);
    const err = redactObject({ error: new Error(`bad token ${JWT}`) });
    assert.ok(!JSON.stringify(err).includes(JWT.split('.')[1]));
    assert.equal(redactString('no token here, eyJ alone is fine'), 'no token here, eyJ alone is fine');
    assert.equal(redactString(redactString(JWT)), redactString(JWT), 'idempotent');
  });

  it('masks a JWT glued to a word (no word boundary before eyJ)', () => {
    for (const prefix of ['Bearer_', 'x_', 'token-', 'id=']) {
      const out = redactString(`${prefix}${JWT} end`);
      assert.ok(!out.includes(JWT.split('.')[1]), `${prefix}: ${out}`);
    }
    // eyJ in the middle of an alphanumeric run is not the start of a token (keeps ordinary text).
    assert.equal(redactString('abceyJhbGciOiJSUz.eyJzdWIiOiIw'), 'abceyJhbGciOiJSUz.eyJzdWIiOiIw');
  });

  it('masks w3aSubject and loginSecretHash in meta objects (F11 defence in depth)', () => {
    const subject = '3f2c9a4e-8b1d-4c7a-9e21-6a0b5d4c3e2f';
    const out = redactObject({ w3aSubject: subject, row: { loginSecretHash: LONG, W3ASUBJECT: subject } });
    assert.ok(!JSON.stringify(out).includes(subject));
    assert.ok(!JSON.stringify(out).includes(LONG));
    assert.ok(SENSITIVE_META_KEYS.includes('w3aSubject') && SENSITIVE_META_KEYS.includes('loginSecretHash'));
  });

  it('keeps Web3Auth connection names under `verifier` readable, masks PKCE verifiers', () => {
    assert.equal(redactObject({ verifier: 'web3auth-google-sapphire-devnet' }).verifier, 'web3auth-google-sapphire-devnet');
    assert.equal(redactObject({ verifier: 'external-wallet' }).verifier, 'external-wallet');
    const pkce = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    assert.notEqual(redactObject({ verifier: pkce }).verifier, pkce);
  });

  it('keeps error codes under `code` readable, masks an OTP code fully or by prefix', () => {
    assert.equal(redactObject({ code: 'OTP_INVALID' }).code, 'OTP_INVALID');
    assert.equal(redactObject({ code: '042917' }).code, '[redacted]');
  });
});
