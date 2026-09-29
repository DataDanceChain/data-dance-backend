/**
 * Google and Apple sign-in for native login (design §2.5, §3.4, F4, F17, F22, D8, D12): token
 * verification (signature, iss, aud/azp per platform, exp, sub), the single-use nonce bound to its
 * purpose, the e-mail grade that decides auto-linking, the fixed rejection enum, provider outages,
 * and the three routes (POST /nonce, /google, /apple) with the hand-off to identify.createLoginAttempt.
 *
 * No network: Google's and Apple's keys are throwaway RSA keys generated here; their JWKS is served
 * either as a local key set or through a stubbed fetch / a loopback HTTP server. The live check
 * against the real Google and Apple JWKS endpoints runs only with DDC_TEST_IDP_LIVE=1.
 */
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const jose = require('jose');

const { makeKeyFile, localEnv } = require('../helpers/nativeAuthKeys');

const key = makeKeyFile();
const WEB_ID = 'web-123.apps.googleusercontent.com';
const IOS_ID = 'ios-456.apps.googleusercontent.com';
const ANDROID_ID = 'android-789.apps.googleusercontent.com';
const BUNDLE_ID = 'co.datadance.app';
const SERVICES_ID = 'ai.datadance.web.signin';
const LEGACY_EMAIL = 'web3auth-auth0-email-passwordless-sapphire-devnet';
const BASE_ENV = localEnv(key, {
  DDC_AUTH_METHODS: 'google,apple',
  DDC_AUTH_NEW_ACCOUNTS: 'open',
  DDC_AUTH_GOOGLE_CLIENT_IDS: `${WEB_ID},${IOS_ID}`,
  DDC_AUTH_GOOGLE_AZP_IDS: `${WEB_ID},${IOS_ID},${ANDROID_ID}`,
  DDC_AUTH_APPLE_AUDIENCES: `${BUNDLE_ID},${SERVICES_ID}`,
  DDC_AUTH_LEGACY_EMAIL_VERIFIERS: LEGACY_EMAIL,
});
Object.assign(process.env, BASE_ENV, { NODE_ENV: 'test', LOG_LEVEL: 'error', WEB3AUTH_VERIFY_MODE: 'off' });

const { installMockPrisma } = require('../helpers/mockPrisma');

const prisma = installMockPrisma({ enforceUnique: true });
// protect (authMiddleware) constructs its own PrismaClient: hand it the same in-memory store.
require.cache[require.resolve('@prisma/client')].exports = {
  ...require.cache[require.resolve('@prisma/client')].exports,
  PrismaClient: function PrismaClient() {
    return prisma;
  },
};

// Capture every log line with its meta as the services pass it (before redaction): the services
// must not even hand a token, a subject or an address to the logger.
const logs = [];
const realLogger = require('../../src/utils/logger');
require.cache[require.resolve('../../src/utils/logger')].exports = {
  ...realLogger,
  createLogger: (name) => {
    const push = (level) => (message, meta) => logs.push({ level, name, message, meta });
    return { info: push('info'), warn: push('warn'), error: push('error'), debug: () => {}, http: () => {}, add: () => {}, remove: () => {} };
  },
};

const config = require('../../src/services/nativeAuth/config');
const flowState = require('../../src/services/nativeAuth/flowState');
const accounts = require('../../src/services/nativeAuth/accounts');
const idpErrors = require('../../src/services/nativeAuth/idpErrors');
const idpGoogle = require('../../src/services/nativeAuth/idpGoogle');
const idpApple = require('../../src/services/nativeAuth/idpApple');
const { NATIVE_ERROR_CODES } = require('../../src/controllers/nativeAuth/respond');
const { createIdpController } = require('../../src/controllers/nativeAuth/idpController');
const { listenLoopback } = require('../helpers/loopbackServer');

let envOverrides = {};
const cfg = () => config.readNativeAuthConfig({ ...BASE_ENV, ...envOverrides });

// ---------------------------------------------------------------------------------------------
// Throwaway provider keys and token factories
// ---------------------------------------------------------------------------------------------
const providerKeys = {};
async function makeProviderKey(kid) {
  const { publicKey, privateKey } = await jose.generateKeyPair('RS256', { extractable: true });
  const jwk = { ...(await jose.exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' };
  return { kid, privateKey, jwk };
}

const T0 = new Date('2026-09-30T09:00:00.000Z');
const sec = (date) => Math.floor(date.getTime() / 1000);
const plus = (s, from = T0) => new Date(from.getTime() + s * 1000);

async function sign(payload, { signer = providerKeys.google, kid = signer.kid, alg = 'RS256', iat = sec(T0), expIn = 3600 } = {}) {
  const claims = { iat, exp: iat + expIn, ...payload };
  for (const [k, v] of Object.entries(claims)) if (v === undefined) delete claims[k];
  return new jose.SignJWT(claims).setProtectedHeader({ alg, kid, typ: 'JWT' }).sign(signer.privateKey);
}

function googleClaims(nonceSha256, extra = {}) {
  return {
    iss: 'https://accounts.google.com',
    aud: WEB_ID,
    azp: WEB_ID,
    sub: '109876543210987654321',
    email: 'Ada.Lovelace@Gmail.com',
    email_verified: true,
    name: 'Ada Lovelace',
    picture: 'https://lh3.googleusercontent.com/a/photo',
    nonce: nonceSha256,
    ...extra,
  };
}

function appleClaims(nonceSha256, extra = {}) {
  return {
    iss: 'https://appleid.apple.com',
    aud: BUNDLE_ID,
    sub: '001234.0123456789abcdef0123456789abcdef.0123',
    email: 'ada@gmail.com',
    email_verified: 'true',
    is_private_email: 'false',
    nonce: nonceSha256,
    nonce_supported: true,
    ...extra,
  };
}

let googleSet;
let appleSet;

before(async () => {
  providerKeys.google = await makeProviderKey('google-kid-1');
  providerKeys.googleOther = await makeProviderKey('google-kid-2');
  providerKeys.apple = await makeProviderKey('apple-kid-1');
  providerKeys.stranger = await makeProviderKey('google-kid-1'); // same kid, wrong key
  googleSet = jose.createLocalJWKSet({ keys: [providerKeys.google.jwk, providerKeys.googleOther.jwk] });
  appleSet = jose.createLocalJWKSet({ keys: [providerKeys.apple.jwk] });
});

beforeEach(() => {
  prisma.reset();
  logs.length = 0;
  envOverrides = {};
  idpErrors.resetRemoteJwks();
});

/** A live nonce for `purpose`, issued at T0 (or `at`). */
const issueNonce = (purpose, at = T0) => flowState.issueIdpNonce({ purpose, cfg: cfg(), db: prisma, now: at });

const verifyGoogle = (credential, nonce, args = {}) => idpGoogle.verifyGoogleCredential({ credential, nonce, cfg: cfg(), keySet: googleSet, db: prisma, now: plus(10), ...args });
const verifyApple = (identityToken, nonce, args = {}) => idpApple.verifyAppleIdentityToken({ identityToken, nonce, cfg: cfg(), keySet: appleSet, db: prisma, now: plus(10), ...args });

async function rejects(promise, code, reason) {
  await assert.rejects(promise, (err) => {
    assert.equal(err.name, 'NativeAuthError', `expected a NativeAuthError, got ${err.name}: ${err.message}`);
    assert.equal(err.code, code, `expected ${code}, got ${err.code} (${JSON.stringify(err.data)})`);
    assert.equal(err.status, NATIVE_ERROR_CODES[code]);
    if (code === 'IDP_TOKEN_INVALID') assert.deepEqual(err.data, { reason });
    else assert.equal(err.data, undefined);
    return true;
  });
  if (reason && code !== 'IDP_UNAVAILABLE') {
    const line = logs.find((l) => l.message === 'native_auth.idp_rejected');
    assert.ok(line, 'idp_rejected is logged');
    assert.equal(line.meta.reason, reason);
  }
}

const liveNonces = () => prisma.authFlowState.rows.filter((r) => r.kind === 'idp_nonce' && !r.consumedAt).length;
const gradeOf = (identity) => accounts.linkGrade(accounts.normalizeIdentity(identity));

// =============================================================================================
describe('Google ID token (§3.4)', () => {
  it('a valid web token → identity for identify; the nonce is consumed (single use)', async () => {
    const n = await issueNonce('google');
    const token = await sign(googleClaims(n.nonceSha256));
    const identity = await verifyGoogle(token, n.nonce);
    assert.deepEqual(identity, {
      provider: 'google',
      subject: '109876543210987654321',
      email: 'ada.lovelace@gmail.com',
      emailVerified: true,
      profile: { name: 'Ada Lovelace', avatar: 'https://lh3.googleusercontent.com/a/photo' },
    });
    assert.equal(liveNonces(), 0);
    await rejects(verifyGoogle(token, n.nonce), 'IDP_NONCE_INVALID', 'nonce');
  });

  it('accepts both issuer spellings and every legitimate (aud, azp) pair per platform', async () => {
    const pairs = [
      ['web (GIS)', WEB_ID, WEB_ID],
      ['iOS', IOS_ID, IOS_ID],
      ['iOS with the web id as server client', WEB_ID, IOS_ID],
      ['Android (serverClientId = web id)', WEB_ID, ANDROID_ID],
    ];
    for (const iss of ['accounts.google.com', 'https://accounts.google.com']) {
      for (const [label, aud, azp] of pairs) {
        const n = await issueNonce('google');
        const identity = await verifyGoogle(await sign(googleClaims(n.nonceSha256, { iss, aud, azp })), n.nonce);
        assert.equal(identity.subject, '109876543210987654321', `${label} / ${iss}`);
      }
    }
  });

  it('aud: only our client ids, as a single audience', async () => {
    for (const aud of ['someone-else.apps.googleusercontent.com', ANDROID_ID, [WEB_ID, 'other'], undefined]) {
      logs.length = 0;
      const n = await issueNonce('google');
      await rejects(verifyGoogle(await sign(googleClaims(n.nonceSha256, { aud })), n.nonce), 'IDP_TOKEN_INVALID', 'audience');
    }
  });

  it('azp: must be ours (F22) and consistent with aud — aud ≠ azp only when aud is the web id', async () => {
    for (const [aud, azp] of [[WEB_ID, 'someone-else'], [WEB_ID, undefined], [IOS_ID, ANDROID_ID], [IOS_ID, WEB_ID]]) {
      logs.length = 0;
      const n = await issueNonce('google');
      await rejects(verifyGoogle(await sign(googleClaims(n.nonceSha256, { aud, azp })), n.nonce), 'IDP_TOKEN_INVALID', 'azp');
    }
  });

  it('iss: anything else is refused', async () => {
    for (const iss of ['https://accounts.google.com/', 'https://evil.example', undefined]) {
      logs.length = 0;
      const n = await issueNonce('google');
      await rejects(verifyGoogle(await sign(googleClaims(n.nonceSha256, { iss })), n.nonce), 'IDP_TOKEN_INVALID', 'issuer');
    }
  });

  it('exp: 60 s tolerance, then expired; a token issued in the future is refused too', async () => {
    const n1 = await issueNonce('google');
    const token = await sign(googleClaims(n1.nonceSha256), { expIn: 5 });
    assert.ok(await verifyGoogle(token, n1.nonce, { now: plus(60) }));
    const n2 = await issueNonce('google');
    await rejects(verifyGoogle(await sign(googleClaims(n2.nonceSha256), { expIn: 5 }), n2.nonce, { now: plus(70) }), 'IDP_TOKEN_INVALID', 'expired');
    logs.length = 0;
    const n3 = await issueNonce('google');
    await rejects(verifyGoogle(await sign(googleClaims(n3.nonceSha256, { nbf: sec(plus(600)) })), n3.nonce), 'IDP_TOKEN_INVALID', 'expired');
    logs.length = 0;
    const n4 = await issueNonce('google');
    await rejects(verifyGoogle(await sign(googleClaims(n4.nonceSha256, { exp: undefined })), n4.nonce), 'IDP_TOKEN_INVALID', 'malformed');
    logs.length = 0;
    const n5 = await issueNonce('google');
    await rejects(verifyGoogle(await sign(googleClaims(n5.nonceSha256, { exp: 'tomorrow' })), n5.nonce), 'IDP_TOKEN_INVALID', 'malformed');
  });

  it('signature: wrong key under a known kid, an unknown kid, a non-RS256 alg → signature', async () => {
    const cases = [
      () => sign(googleClaims('x'.repeat(64)), { signer: providerKeys.stranger }),
      () => sign(googleClaims('x'.repeat(64)), { kid: 'unknown-kid' }),
      () => sign(googleClaims('x'.repeat(64)), { signer: providerKeys.apple, kid: 'google-kid-1' }),
      async () => new jose.SignJWT(googleClaims('x'.repeat(64))).setProtectedHeader({ alg: 'HS256', kid: 'google-kid-1' }).setIssuedAt().setExpirationTime('1h').sign(new Uint8Array(32)),
    ];
    for (const make of cases) {
      logs.length = 0;
      const n = await issueNonce('google');
      await rejects(verifyGoogle(await make(), n.nonce), 'IDP_TOKEN_INVALID', 'signature');
      assert.equal(liveNonces() > 0, true);
    }
  });

  it('malformed input never reaches the key set', async () => {
    let lookedUp = 0;
    const spySet = async (...args) => {
      lookedUp += 1;
      return googleSet(...args);
    };
    const unsigned = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from('{"sub":"1"}').toString('base64url')}.`;
    for (const credential of [undefined, null, 42, {}, '', 'not-a-jwt', 'a.b', unsigned, `${'a'.repeat(5000)}.${'b'.repeat(5000)}.c`, 'a.b.c d']) {
      logs.length = 0;
      await rejects(verifyGoogle(credential, 'n', { keySet: spySet }), 'IDP_TOKEN_INVALID', 'malformed');
    }
    assert.equal(lookedUp, 0);
    // Correctly signed by Google's key, but the payload is not a JSON claim set → malformed.
    logs.length = 0;
    const notJson = await new jose.CompactSign(new TextEncoder().encode('not json')).setProtectedHeader({ alg: 'RS256', kid: 'google-kid-1' }).sign(providerKeys.google.privateKey);
    await rejects(verifyGoogle(notJson, 'n'), 'IDP_TOKEN_INVALID', 'malformed');
    // A forged signature on an otherwise plausible token → signature.
    logs.length = 0;
    await rejects(verifyGoogle('eyJhbGciOiJSUzI1NiIsImtpZCI6Imdvb2dsZS1raWQtMSJ9.bm90IGpzb24.c2ln', 'n'), 'IDP_TOKEN_INVALID', 'signature');
  });

  it('sub is required and bounded', async () => {
    for (const sub of [undefined, '', 'x'.repeat(256), 12345]) {
      logs.length = 0;
      const n = await issueNonce('google');
      await rejects(verifyGoogle(await sign(googleClaims(n.nonceSha256, { sub })), n.nonce), 'IDP_TOKEN_INVALID', 'malformed');
    }
  });
});

// =============================================================================================
describe('IdP nonce (§2.5)', () => {
  it('POST /nonce shape: raw 32-byte b64url nonce, its sha256 hex, 300 s', async () => {
    const n = await issueNonce('google');
    assert.match(n.nonce, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(n.nonceSha256, crypto.createHash('sha256').update(n.nonce).digest('hex'));
    assert.equal(n.expiresInSec, 300);
    const row = prisma.authFlowState.rows[0];
    assert.equal(row.kind, 'idp_nonce');
    assert.equal(JSON.stringify(row).includes(n.nonce), false, 'the raw nonce is never stored');
  });

  it('required: a token without a nonce claim, or a missing/garbled raw nonce → IDP_NONCE_INVALID', async () => {
    const n = await issueNonce('google');
    await rejects(verifyGoogle(await sign(googleClaims(undefined)), n.nonce), 'IDP_NONCE_INVALID', 'nonce');
    for (const raw of [undefined, '', 'short', n.nonce.toUpperCase(), `${n.nonce}x`]) {
      logs.length = 0;
      await rejects(verifyGoogle(await sign(googleClaims(n.nonceSha256)), raw), 'IDP_NONCE_INVALID', 'nonce');
    }
    // None of the failures spent the nonce: the right pair still works once.
    assert.ok(await verifyGoogle(await sign(googleClaims(n.nonceSha256)), n.nonce));
  });

  it('the token must carry sha256(raw), not the raw value itself', async () => {
    const n = await issueNonce('google');
    await rejects(verifyGoogle(await sign(googleClaims(n.nonce)), n.nonce), 'IDP_NONCE_INVALID', 'nonce');
  });

  it('a wrong raw nonce (another live one) is refused and spends neither', async () => {
    const a = await issueNonce('google');
    const b = await issueNonce('google');
    await rejects(verifyGoogle(await sign(googleClaims(a.nonceSha256)), b.nonce), 'IDP_NONCE_INVALID', 'nonce');
    assert.equal(liveNonces(), 2);
  });

  it('bound to its purpose: an Apple nonce never satisfies Google and vice versa', async () => {
    const a = await issueNonce('apple');
    await rejects(verifyGoogle(await sign(googleClaims(a.nonceSha256)), a.nonce), 'IDP_NONCE_INVALID', 'nonce');
    logs.length = 0;
    const g = await issueNonce('google');
    await rejects(verifyApple(await sign(appleClaims(g.nonceSha256), { signer: providerKeys.apple }), g.nonce), 'IDP_NONCE_INVALID', 'nonce');
    assert.equal(liveNonces(), 2);
  });

  it('expires after 5 minutes', async () => {
    const n = await issueNonce('google');
    const token = await sign(googleClaims(n.nonceSha256), { iat: sec(plus(290)) });
    await rejects(verifyGoogle(token, n.nonce, { now: plus(301) }), 'IDP_NONCE_INVALID', 'nonce');
  });

  it('a rejected token never spends the nonce (verification comes first)', async () => {
    const n = await issueNonce('google');
    await rejects(verifyGoogle(await sign(googleClaims(n.nonceSha256, { aud: 'other' })), n.nonce), 'IDP_TOKEN_INVALID', 'audience');
    assert.equal(liveNonces(), 1);
  });

  it('two concurrent submissions of one token+nonce: exactly one succeeds', async () => {
    const n = await issueNonce('google');
    const token = await sign(googleClaims(n.nonceSha256));
    const results = await Promise.allSettled([verifyGoogle(token, n.nonce), verifyGoogle(token, n.nonce), verifyGoogle(token, n.nonce)]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    for (const r of results.filter((x) => x.status === 'rejected')) assert.equal(r.reason.code, 'IDP_NONCE_INVALID');
  });
});

// =============================================================================================
describe('Google e-mail grade (F4, D8): strong only for a verified @gmail.com or an hd account', () => {
  const cases = [
    ['verified @gmail.com', { email: 'ada@gmail.com', email_verified: true }, 'strong'],
    ['verified @gmail.com, mixed case', { email: 'Ada@GMAIL.com', email_verified: true }, 'strong'],
    ['unverified @gmail.com', { email: 'ada@gmail.com', email_verified: false }, 'weak'],
    ['email_verified as the string "true" (Google sends booleans)', { email: 'ada@gmail.com', email_verified: 'true' }, 'weak'],
    ['verified non-Gmail consumer account, no hd', { email: 'ada@example.org', email_verified: true }, 'weak'],
    ['verified Workspace account (hd)', { email: 'ada@example.org', email_verified: true, hd: 'example.org' }, 'strong'],
    ['Workspace account, unverified', { email: 'ada@example.org', email_verified: false, hd: 'example.org' }, 'weak'],
    ['look-alike gmail domain', { email: 'ada@gmail.com.evil.example', email_verified: true }, 'weak'],
    ['googlemail.com is not gmail.com', { email: 'ada@googlemail.com', email_verified: true }, 'weak'],
    ['no e-mail at all', { email: undefined, email_verified: undefined }, 'none'],
  ];
  for (const [label, claims, grade] of cases) {
    it(`${label} → ${grade}`, async () => {
      const n = await issueNonce('google');
      const identity = await verifyGoogle(await sign(googleClaims(n.nonceSha256, claims)), n.nonce);
      assert.equal(gradeOf(identity), grade);
      assert.equal(identity.emailVerified, claims.email_verified === true);
      if (claims.hd) assert.equal(identity.hd, claims.hd);
      else assert.equal('hd' in identity, false);
    });
  }

  it('display data: an http picture is dropped, the name is kept', async () => {
    const n = await issueNonce('google');
    const identity = await verifyGoogle(await sign(googleClaims(n.nonceSha256, { picture: 'http://insecure.example/p.png' })), n.nonce);
    assert.deepEqual(identity.profile, { name: 'Ada Lovelace' });
  });
});

// =============================================================================================
describe('Apple identity token (§3.4, D12)', () => {
  it('iOS (bundle id) and web (Services ID) audiences; sub is the identity', async () => {
    for (const aud of [BUNDLE_ID, SERVICES_ID]) {
      const n = await issueNonce('apple');
      const identity = await verifyApple(await sign(appleClaims(n.nonceSha256, { aud }), { signer: providerKeys.apple }), n.nonce, { user: { firstName: ' Ada ', lastName: 'Lovelace' } });
      assert.deepEqual(identity, {
        provider: 'apple',
        subject: '001234.0123456789abcdef0123456789abcdef.0123',
        email: 'ada@gmail.com',
        emailVerified: true,
        isPrivateRelay: false,
        profile: { name: 'Ada Lovelace' },
      });
    }
    assert.equal(liveNonces(), 0);
  });

  it('refuses another audience, another issuer, an expired token (60 s tolerance), a Google-signed token', async () => {
    const cases = [
      [{ aud: 'com.someone.else' }, {}, 'audience'],
      [{ aud: WEB_ID }, {}, 'audience'],
      [{ iss: 'https://accounts.google.com' }, {}, 'issuer'],
      [{}, { expIn: 5, now: plus(70) }, 'expired'],
      [{}, { signer: providerKeys.google, kid: 'apple-kid-1' }, 'signature'],
      [{ sub: '' }, {}, 'malformed'],
    ];
    for (const [claims, opts, reason] of cases) {
      logs.length = 0;
      const n = await issueNonce('apple');
      const { now, ...signOpts } = opts;
      const token = await sign(appleClaims(n.nonceSha256, claims), { signer: providerKeys.apple, ...signOpts });
      await rejects(verifyApple(token, n.nonce, now ? { now } : {}), 'IDP_TOKEN_INVALID', reason);
    }
    const n = await issueNonce('apple');
    assert.ok(await verifyApple(await sign(appleClaims(n.nonceSha256), { signer: providerKeys.apple, expIn: 5 }), n.nonce, { now: plus(60) }));
  });

  it('email_verified true or "true"; anything else is unverified', async () => {
    for (const [value, expected] of [[true, true], ['true', true], [false, false], ['false', false], [undefined, false], ['TRUE', false], [1, false]]) {
      const n = await issueNonce('apple');
      const identity = await verifyApple(await sign(appleClaims(n.nonceSha256, { email_verified: value }), { signer: providerKeys.apple }), n.nonce);
      assert.equal(identity.emailVerified, expected, `email_verified=${JSON.stringify(value)}`);
    }
  });

  it('private relay from is_private_email (true / "true") or the relay domain', async () => {
    const cases = [
      [{ is_private_email: true, email: 'x1@privaterelay.appleid.com' }, true],
      [{ is_private_email: 'true', email: 'abc@example.org' }, true],
      [{ is_private_email: undefined, email: 'Abc@PrivateRelay.AppleID.com' }, true],
      [{ is_private_email: 'false', email: 'ada@example.org' }, false],
      [{ is_private_email: undefined, email: undefined }, false],
    ];
    for (const [claims, relay] of cases) {
      const n = await issueNonce('apple');
      const identity = await verifyApple(await sign(appleClaims(n.nonceSha256, claims), { signer: providerKeys.apple }), n.nonce);
      assert.equal(identity.isPrivateRelay, relay, JSON.stringify(claims));
    }
  });

  it('never a link source: every Apple identity grades weak or none, even a verified @gmail.com', async () => {
    for (const claims of [{}, { email: 'ada@example.org' }, { email: 'x@privaterelay.appleid.com', is_private_email: 'true' }, { email_verified: 'false' }]) {
      const n = await issueNonce('apple');
      const identity = await verifyApple(await sign(appleClaims(n.nonceSha256, claims), { signer: providerKeys.apple }), n.nonce);
      assert.notEqual(gradeOf(identity), 'strong');
    }
  });

  it('the name comes only from the client payload, is display-only and bounded; junk is ignored', async () => {
    assert.equal(idpApple.displayName({ firstName: 'Ada', lastName: '' }), 'Ada');
    assert.equal(idpApple.displayName({ firstName: 'A'.repeat(80), lastName: 'B' }), `${'A'.repeat(50)} B`);
    for (const junk of [undefined, null, 'Ada Lovelace', ['Ada'], { firstName: 1, lastName: {} }]) assert.equal(idpApple.displayName(junk), '');
    const n = await issueNonce('apple');
    const identity = await verifyApple(await sign(appleClaims(n.nonceSha256, { name: 'Signed Name' }), { signer: providerKeys.apple }), n.nonce, { user: 'not an object' });
    assert.deepEqual(identity.profile, {});
  });
});

// =============================================================================================
describe('provider key set unavailable → IDP_UNAVAILABLE (never blamed on the token)', () => {
  let server;
  let mode = 'ok';
  let jwksBody;
  before(async () => {
    jwksBody = JSON.stringify({ keys: [providerKeys.google.jwk] });
    server = http.createServer((req, res) => {
      if (mode === 'ok') return res.writeHead(200, { 'content-type': 'application/json' }).end(jwksBody);
      if (mode === '500') return res.writeHead(500).end('oops');
      if (mode === 'redirect') return res.writeHead(302, { location: 'http://127.0.0.1:1/' }).end();
      if (mode === 'html') return res.writeHead(200, { 'content-type': 'text/html' }).end('<html>');
      if (mode === 'notjwks') return res.writeHead(200, { 'content-type': 'application/json' }).end('{"keys":"nope"}');
      return undefined; // 'hang': never answer
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });
  after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  const url = () => `http://127.0.0.1:${server.address().port}/certs`;

  it('the remote key set works when the provider answers', async () => {
    mode = 'ok';
    const n = await issueNonce('google');
    const identity = await verifyGoogle(await sign(googleClaims(n.nonceSha256)), n.nonce, { keySet: idpErrors.remoteJwks(url(), { timeoutMs: 1000 }) });
    assert.equal(identity.provider, 'google');
  });

  for (const [m, reason] of [['500', 'http_status'], ['redirect', 'network'], ['html', 'invalid_json'], ['notjwks', 'invalid_jwks'], ['hang', 'timeout'], ['refused', 'network']]) {
    it(`${m} → 503 IDP_UNAVAILABLE (idp_unavailable reason ${reason}), nonce not spent`, async () => {
      mode = m;
      idpErrors.resetRemoteJwks();
      const target = m === 'refused' ? 'http://127.0.0.1:9/certs' : url();
      const n = await issueNonce('google');
      await rejects(verifyGoogle(await sign(googleClaims(n.nonceSha256)), n.nonce, { keySet: idpErrors.remoteJwks(target, { timeoutMs: 300 }) }), 'IDP_UNAVAILABLE');
      const line = logs.find((l) => l.message === 'native_auth.idp_unavailable');
      assert.equal(line.level, 'error');
      assert.deepEqual(line.meta, { provider: 'google', reason });
      assert.equal(liveNonces(), 1);
    });
  }

  it('an unexpected (non-jose) failure is an outage, not a token verdict', async () => {
    const n = await issueNonce('google');
    const broken = async () => {
      throw new TypeError('boom');
    };
    await rejects(verifyGoogle(await sign(googleClaims(n.nonceSha256)), n.nonce, { keySet: broken }), 'IDP_UNAVAILABLE');
  });
});

describe('error enum and logs (F17)', () => {
  it('reasons are exactly the design enum; classification never reads library messages', () => {
    assert.deepEqual([...idpErrors.IDP_REASONS], ['expired', 'audience', 'issuer', 'signature', 'nonce', 'malformed', 'azp']);
    const e = new jose.errors.JWTClaimValidationFailed('eyJhbGciOi... payload {"email":"a@b"}', {}, 'aud', 'check_failed');
    assert.equal(idpErrors.classifyJoseError(e).reason, 'audience');
    assert.equal(idpErrors.classifyJoseError(new jose.errors.JWTClaimValidationFailed('x', {}, 'hd')).reason, 'malformed');
  });

  it('no token, subject, e-mail, nonce or library message is ever logged or returned', async () => {
    const n = await issueNonce('google');
    const good = await sign(googleClaims(n.nonceSha256));
    const bad = await sign(googleClaims(n.nonceSha256, { aud: 'someone-else' }));
    const errors = [];
    for (const [t, raw] of [[bad, n.nonce], [good, 'wrong'], [good, n.nonce], [good, n.nonce]]) {
      try {
        await verifyGoogle(t, raw);
      } catch (err) {
        errors.push(err);
      }
    }
    const text = JSON.stringify(logs) + JSON.stringify(errors.map((e) => ({ code: e.code, message: e.message, data: e.data })));
    for (const secret of [good, bad, good.split('.')[1], '109876543210987654321', 'lovelace', n.nonce, n.nonceSha256, 'someone-else', 'unexpected "aud"']) {
      assert.equal(text.toLowerCase().includes(secret.toLowerCase()), false, `leaked: ${secret.slice(0, 12)}…`);
    }
    for (const line of logs) assert.deepEqual(Object.keys(line.meta).sort(), ['provider', 'reason']);
  });
});

// =============================================================================================
describe('controller', () => {
  function fakeRes() {
    const res = { statusCode: 200, body: null };
    res.status = (s) => {
      res.statusCode = s;
      return res;
    };
    res.json = (b) => {
      res.body = b;
      return res;
    };
    return res;
  }
  const req = (body, overrides = {}) => ({ body, ip: '203.0.113.7', nativeAuthConfig: config.readNativeAuthConfig({ ...BASE_ENV, ...overrides }) });
  const fail = (e) => {
    throw e;
  };

  it('link authenticates BEFORE the token is verified or the nonce spent', async () => {
    let verified = 0;
    const controller = createIdpController({
      google: { ...idpGoogle, verifyGoogleCredential: async () => { verified += 1; return {}; } },
      apple: { ...idpApple, verifyAppleIdentityToken: async () => { verified += 1; return {}; } },
      authenticate: (rq, rs) => rs.status(401).json({ status: 'fail', message: 'Authentication required. Please login first.' }),
      identify: () => ({ createLoginAttempt: async () => ({}) }),
    });
    for (const handler of [controller.google, controller.apple]) {
      const res = fakeRes();
      await handler(req({ credential: 'x', identityToken: 'x', nonce: 'n', intent: 'link' }), res, fail);
      assert.equal(res.statusCode, 401);
    }
    assert.equal(verified, 0);
  });

  it('hand-off to identify.createLoginAttempt exactly as BE6 exposes it; link passes the bearer user, login never', async () => {
    const calls = [];
    const googleIdentity = { provider: 'google', subject: 'g1', email: 'a@gmail.com', emailVerified: true, profile: {} };
    const appleIdentity = { provider: 'apple', subject: 'a1', email: null, emailVerified: false, isPrivateRelay: false, profile: {} };
    const seen = [];
    const controller = createIdpController({
      google: { ...idpGoogle, verifyGoogleCredential: async (args) => { seen.push(args); return googleIdentity; } },
      apple: { ...idpApple, verifyAppleIdentityToken: async (args) => { seen.push(args); return appleIdentity; } },
      authenticate: (rq, rs, next) => {
        rq.user = { id: 'user-1' };
        return next();
      },
      identify: () => ({ createLoginAttempt: async (args) => { calls.push(args); return { loginId: 'l' }; } }),
    });
    const r1 = req({ credential: 'tok', nonce: 'raw', intent: 'link' });
    const res1 = fakeRes();
    await controller.google(r1, res1, fail);
    assert.deepEqual(res1.body, { status: 'success', data: { loginId: 'l' } });
    assert.deepEqual(calls[0], { identity: googleIdentity, intent: 'link', method: 'google', req: r1, bearerUser: { id: 'user-1' } });
    assert.equal(seen[0].credential, 'tok');
    assert.equal(seen[0].nonce, 'raw');

    const r2 = req({ identityToken: 'tok2', nonce: 'raw2', user: { firstName: 'A' }, intent: 'bogus' });
    await controller.apple(r2, fakeRes(), fail);
    assert.deepEqual(calls[1], { identity: appleIdentity, intent: 'login', method: 'apple', req: r2, bearerUser: undefined });
    assert.deepEqual([seen[1].identityToken, seen[1].nonce, seen[1].user], ['tok2', 'raw2', { firstName: 'A' }]);
  });

  it('client ids / audiences empty → METHOD_DISABLED before anything else runs (nonce too)', async () => {
    const controller = createIdpController({
      google: { ...idpGoogle, verifyGoogleCredential: async () => fail(new Error('must not run')) },
      apple: { ...idpApple, verifyAppleIdentityToken: async () => fail(new Error('must not run')) },
      flow: { issueIdpNonce: async () => fail(new Error('must not run')) },
      authenticate: () => fail(new Error('must not run')),
    });
    const noGoogle = { DDC_AUTH_GOOGLE_CLIENT_IDS: '' };
    const noAzp = { DDC_AUTH_GOOGLE_AZP_IDS: '' };
    const noApple = { DDC_AUTH_APPLE_AUDIENCES: '' };
    for (const [handler, body, overrides] of [
      [controller.google, { intent: 'link' }, noGoogle],
      [controller.google, {}, noAzp],
      [controller.apple, { intent: 'link' }, noApple],
      [controller.nonce, { purpose: 'google' }, noGoogle],
      [controller.nonce, { purpose: 'apple' }, noApple],
      [controller.nonce, { purpose: 'apple' }, { DDC_AUTH_METHODS: 'google' }],
      [controller.nonce, { purpose: 'x' }, {}],
      [controller.nonce, { purpose: 'toString' }, {}],
      [controller.nonce, {}, {}],
    ]) {
      const res = fakeRes();
      await handler(req(body, overrides), res, fail);
      assert.equal(res.statusCode, 404, JSON.stringify(body));
      assert.equal(res.body.code, 'METHOD_DISABLED');
    }
  });
});

// =============================================================================================
describe('routes (flag on, real router, real identify)', () => {
  let server;
  let realFetch;
  const fetched = [];
  before(async () => {
    realFetch = globalThis.fetch;
    // Google's and Apple's JWKS endpoints, answered locally; anything else is a test bug.
    globalThis.fetch = async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      fetched.push(url);
      if (url === idpGoogle.GOOGLE_JWKS_URL) return new Response(JSON.stringify({ keys: [providerKeys.google.jwk] }), { status: 200 });
      if (url === idpApple.APPLE_JWKS_URL) return new Response(JSON.stringify({ keys: [providerKeys.apple.jwk] }), { status: 200 });
      throw new Error(`unexpected fetch ${url} ${init && init.method}`);
    };
    const router = require('../../src/routes/nativeAuthRoutes');
    const app = express();
    app.set('trust proxy', 1);
    app.use(express.json());
    app.use('/api/auth/native', router);
    server = await listenLoopback(app);
  });
  after(() => {
    globalThis.fetch = realFetch;
    return new Promise((resolve) => server.close(resolve));
  });
  const saved = {};
  beforeEach(() => {
    require('../../src/middlewares/rateLimitMiddleware').clearRateLimitStore();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
      delete saved[k];
    }
  });
  function setEnv(vars) {
    for (const [k, v] of Object.entries(vars)) {
      if (!(k in saved)) saved[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  const post = (p, body, ip = '203.0.113.9') => request(server).post(`/api/auth/native${p}`).set('X-Forwarded-For', ip).send(body);

  async function googleLogin(claims = {}, body = {}) {
    const n = await post('/nonce', { purpose: 'google' });
    assert.equal(n.status, 200, JSON.stringify(n.body));
    const credential = await sign(googleClaims(n.body.data.nonceSha256, claims), { iat: Math.floor(Date.now() / 1000) });
    return { res: await post('/google', { credential, nonce: n.body.data.nonce, ...body }), credential, nonce: n.body.data.nonce };
  }

  function addUser(fields) {
    const row = {
      id: crypto.randomUUID(),
      email: 'someone@example.com',
      name: null,
      avatar: null,
      walletAddress: null,
      authType: 'web3auth',
      userType: 'regular',
      isOrganization: false,
      disabledAt: null,
      xid: null,
      xUsername: null,
      web3authVerifier: null,
      web3authVerifierId: null,
      referralCode: `C${crypto.randomBytes(4).toString('hex')}`,
      legacyReferralCode: null,
      password: null,
      privateKey: null,
      ...fields,
    };
    prisma.user.rows.push(row);
    return row;
  }

  it('POST /nonce → {nonce, nonceSha256, expiresInSec:300}, no-store, nativeIdp limiter', async () => {
    const res = await post('/nonce', { purpose: 'apple' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(res.headers['x-ratelimit-limit'], '30');
    assert.deepEqual(Object.keys(res.body.data).sort(), ['expiresInSec', 'nonce', 'nonceSha256']);
    assert.equal(res.body.data.expiresInSec, 300);
    const bad = await post('/nonce', { purpose: 'x' });
    assert.equal(bad.status, 404);
    assert.equal(bad.body.code, 'METHOD_DISABLED');
  });

  it('Google → Identified from the real identify (JWT minted for the opaque subject); replay → 401 IDP_NONCE_INVALID', async () => {
    const { res, credential, nonce } = await googleLogin();
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.headers['cache-control'], 'no-store');
    const data = res.body.data;
    assert.deepEqual(Object.keys(data).sort(), ['account', 'expiresAt', 'loginId', 'loginSecret', 'walletProof', 'web3auth']);
    assert.deepEqual(data.account, { status: 'new', hasWallet: false, linkedBy: 'new' });
    assert.equal(data.web3auth.verifier, 'ddc-jwt-devnet');
    const attempt = prisma.authLoginAttempt.rows.find((r) => r.id === data.loginId);
    assert.equal(attempt.method, 'google');
    assert.equal(attempt.provider, 'google');
    assert.equal(attempt.subject, '109876543210987654321');
    assert.equal(attempt.email, 'ada.lovelace@gmail.com');
    assert.equal(attempt.emailLinkGrade, 'strong');
    assert.ok(fetched.includes(idpGoogle.GOOGLE_JWKS_URL));

    const replay = await post('/google', { credential, nonce });
    assert.equal(replay.status, 401);
    assert.deepEqual(replay.body, { status: 'fail', code: 'IDP_NONCE_INVALID', message: 'This sign-in request has expired. Please try again.' });
  });

  it('a bad token → 401 IDP_TOKEN_INVALID with data.reason from the enum', async () => {
    const { res } = await googleLogin({ azp: 'someone-else' });
    assert.equal(res.status, 401);
    assert.deepEqual(res.body, { status: 'fail', code: 'IDP_TOKEN_INVALID', message: 'The sign-in could not be verified.', data: { reason: 'azp' } });
    const garbage = await post('/google', { credential: 'nope', nonce: 'x' });
    assert.deepEqual(garbage.body.data, { reason: 'malformed' });
  });

  it('F4: a strong Gmail identity auto-links to the legacy e-mail account; Apple with the same verified address never does', async () => {
    const legacy = addUser({ email: 'ada@gmail.com', web3authVerifier: LEGACY_EMAIL, web3authVerifierId: 'ada@gmail.com' });
    const g = await googleLogin({ email: 'ada@gmail.com' });
    assert.equal(g.res.status, 200, JSON.stringify(g.res.body));
    assert.deepEqual(g.res.body.data.account, { status: 'existing', hasWallet: false, linkedBy: 'legacy_email' });
    assert.equal(prisma.authLoginAttempt.rows.find((r) => r.id === g.res.body.data.loginId).userId, legacy.id);

    const weak = await googleLogin({ email: 'ada@gmail.com', email_verified: false, sub: 'g-other' });
    assert.equal(weak.res.body.data.account.status, 'new', 'an unverified Google address never links');

    const n = await post('/nonce', { purpose: 'apple' });
    const identityToken = await sign(appleClaims(n.body.data.nonceSha256, { email: 'ada@gmail.com', email_verified: true }), { signer: providerKeys.apple, iat: Math.floor(Date.now() / 1000) });
    const a = await post('/apple', { identityToken, nonce: n.body.data.nonce, user: { firstName: 'Ada', lastName: 'L' } });
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.equal(a.body.data.account.status, 'new');
    const attempt = prisma.authLoginAttempt.rows.find((r) => r.id === a.body.data.loginId);
    assert.equal(attempt.userId, null);
    assert.equal(attempt.emailLinkGrade, 'weak');
    assert.equal(attempt.provider, 'apple');
    assert.deepEqual(attempt.profile, { name: 'Ada L' });
    assert.ok(fetched.includes(idpApple.APPLE_JWKS_URL));
  });

  it('intent link: no bearer → 401 and the nonce is not spent; with a session → link attempt, nothing minted', async () => {
    const n = await post('/nonce', { purpose: 'google' });
    const credential = await sign(googleClaims(n.body.data.nonceSha256), { iat: Math.floor(Date.now() / 1000) });
    const anon = await post('/google', { credential, nonce: n.body.data.nonce, intent: 'link' });
    assert.equal(anon.status, 401);
    assert.equal(prisma.authFlowState.rows.filter((r) => r.consumedAt).length, 0);

    const user = addUser({ email: 'owner@example.com' });
    const bearer = jwt.sign({ id: user.id }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const linked = await request(server)
      .post('/api/auth/native/google')
      .set('X-Forwarded-For', '203.0.113.9')
      .set('Authorization', `Bearer ${bearer}`)
      .send({ credential, nonce: n.body.data.nonce, intent: 'link' });
    assert.equal(linked.status, 200, JSON.stringify(linked.body));
    assert.deepEqual(Object.keys(linked.body.data).sort(), ['account', 'expiresAt', 'loginId', 'loginSecret']);
    const attempt = prisma.authLoginAttempt.rows.find((r) => r.id === linked.body.data.loginId);
    assert.equal(attempt.intent, 'link');
    assert.equal(attempt.userId, user.id);
  });

  it('identify refusals pass through in the envelope (NEW_ACCOUNTS_CLOSED)', async () => {
    setEnv({ DDC_AUTH_NEW_ACCOUNTS: 'closed' });
    const { res } = await googleLogin({ sub: 'brand-new' });
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'NEW_ACCOUNTS_CLOSED');
  });

  it('methods are switched per DDC_AUTH_METHODS and per configured ids', async () => {
    setEnv({ DDC_AUTH_METHODS: 'google' });
    for (const [p, body] of [['/apple', {}], ['/nonce', { purpose: 'apple' }]]) {
      const res = await post(p, body);
      assert.equal(res.status, 404);
      assert.equal(res.body.code, 'METHOD_DISABLED');
    }
    setEnv({ DDC_AUTH_METHODS: 'google,apple', DDC_AUTH_GOOGLE_CLIENT_IDS: '' });
    for (const [p, body] of [['/google', { credential: 'x' }], ['/nonce', { purpose: 'google' }]]) {
      const res = await post(p, body);
      assert.equal(res.status, 404);
      assert.equal(res.body.code, 'METHOD_DISABLED');
    }
  });

  it('flag off: /nonce, /google and /apple answer 404 NATIVE_AUTH_DISABLED and write nothing', async () => {
    setEnv({ DDC_AUTH_ENABLED: undefined });
    for (const [p, body] of [['/nonce', { purpose: 'google' }], ['/google', { credential: 'x', nonce: 'y' }], ['/apple', { identityToken: 'x', nonce: 'y' }]]) {
      const res = await post(p, body);
      assert.equal(res.status, 404);
      assert.equal(res.body.code, 'NATIVE_AUTH_DISABLED');
    }
    assert.equal(prisma.authFlowState.rows.length, 0);
    assert.equal(prisma.authLoginAttempt.rows.length, 0);
  });
});

// =============================================================================================
describe('live provider key sets (opt-in)', () => {
  const live = process.env.DDC_TEST_IDP_LIVE === '1';
  it('Google and Apple JWKS are reachable and hold RS256 keys (DDC_TEST_IDP_LIVE=1)', { skip: !live && 'set DDC_TEST_IDP_LIVE=1 to fetch the real Google and Apple key sets' }, async () => {
    for (const url of [idpGoogle.GOOGLE_JWKS_URL, idpApple.APPLE_JWKS_URL]) {
      const res = await idpErrors.fetchJwks(url, { signal: AbortSignal.timeout(5000) });
      const { keys } = await res.json();
      assert.ok(Array.isArray(keys) && keys.length > 0, url);
      assert.ok(keys.every((k) => k.kty === 'RSA' && !('d' in k)), url);
    }
    // A token signed by us under a real kid must fail as a signature problem, not an outage.
    const real = await (await idpErrors.fetchJwks(idpGoogle.GOOGLE_JWKS_URL, { signal: AbortSignal.timeout(5000) })).json();
    const n = await issueNonce('google');
    const forged = await sign(googleClaims(n.nonceSha256), { kid: real.keys[0].kid, iat: Math.floor(Date.now() / 1000) });
    await rejects(idpGoogle.verifyGoogleCredential({ credential: forged, nonce: n.nonce, cfg: cfg(), db: prisma }), 'IDP_TOKEN_INVALID', 'signature');
  });
});
