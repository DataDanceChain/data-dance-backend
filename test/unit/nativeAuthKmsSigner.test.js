/**
 * The Aliyun KMS signer (decision 54). KMS is replaced by a mock that behaves like AsymmetricSign
 * with RSA_PKCS1_SHA_256: it receives ONLY the base64 SHA-256 digest and signs it as an
 * RSASSA-PKCS1-v1_5 DigestInfo with a locally generated RSA key, so a token that verifies proves
 * the digest and base64 handling end to end. Covered: tokens verify against the published JWKS
 * with jose and jsonwebtoken, kid = RFC 7638 thumbprint of the KMS public key, retries / timeouts /
 * wrong answers fail closed with no local-key fallback, the boot step (prepareSigner), rotation
 * keys, the JWKS route, logging without key material, the DDC_AUTH_KMS_* boot rules, and the
 * request the official SDK puts on the wire (against a loopback fake KMS).
 *
 * No real Aliyun account, credential or endpoint is used anywhere in this file.
 */
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');
const request = require('supertest');
const jsonwebtoken = require('jsonwebtoken');
const winston = require('winston');
const { listenLoopback } = require('../helpers/loopbackServer');

process.env.LOG_LEVEL = 'info';

const { makeKeyFile, localEnv, keyDir } = require('../helpers/nativeAuthKeys');
const config = require('../../src/services/nativeAuth/config');
const issuer = require('../../src/services/nativeAuth/issuer');
const { getSigner, prepareSigner, resetSignerCache, readyKid } = require('../../src/services/nativeAuth/signer');
const kmsSigner = require('../../src/services/nativeAuth/signer/kmsSigner');
const { createAliyunKmsClient } = require('../../src/services/nativeAuth/signer/aliyunKmsClient');

const { createKmsSigner, publicKeyFromPem, isRetryable, describeError } = kmsSigner;

const KEY_ID = 'key-sgp-test-0000000000000';
const VERSION = '11111111-2222-4333-8444-555555555555';
const NEXT_VERSION = '66666666-7777-4888-9999-000000000000';
const SUBJECT = '00000000-0000-4000-8000-000000000000';
// DER prefix of DigestInfo { sha256, OCTET STRING(32) } (RFC 8017 §9.2 note 1).
const SHA256_DIGEST_INFO = Buffer.from('3031300d060960864801650304020105000420', 'hex');

function rsaKey(bits = 2048) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: bits });
  const jwk = publicKey.export({ format: 'jwk' });
  return { privateKey, publicKey, pem: publicKey.export({ format: 'pem', type: 'spki' }), thumbprint: config.rsaThumbprint(jwk) };
}

const kmsKey = rsaKey();
const nextKmsKey = rsaKey();
const otherKey = rsaKey();
const fileKey = makeKeyFile();

/** What KMS does for RSA_PKCS1_SHA_256 with a precomputed digest. */
function signDigest(privateKey, digestB64) {
  const digest = Buffer.from(digestB64, 'base64');
  return crypto.privateEncrypt({ key: privateKey, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.concat([SHA256_DIGEST_INFO, digest])).toString('base64');
}

/**
 * A mock of the aliyunKmsClient interface. `keys` maps "<keyId>/<versionId>" to a key; `behave`
 * can override one call ({ op, attempt } → value | throw). Records every call.
 */
function mockKms({ keys = { [`${KEY_ID}/${VERSION}`]: kmsKey }, behave } = {}) {
  const calls = [];
  const lookup = (keyId, keyVersionId) => {
    const key = keys[`${keyId}/${keyVersionId}`];
    if (!key) throw Object.assign(new Error('The specified Key is not found.'), { code: 'Forbidden.KeyNotFound', statusCode: 404, requestId: 'req-404' });
    return key;
  };
  const run = async (op, params, fallback) => {
    calls.push({ op, ...params });
    const attempt = calls.filter((c) => c.op === op).length;
    if (behave) {
      const out = await behave({ op, attempt, params });
      if (out !== undefined) return out;
    }
    return fallback();
  };
  return {
    calls,
    getPublicKey: (params) => run('GetPublicKey', params, () => ({ keyId: params.keyId, keyVersionId: params.keyVersionId, publicKey: lookup(params.keyId, params.keyVersionId).pem, requestId: 'req-pk' })),
    asymmetricSign: (params) =>
      run('AsymmetricSign', params, () => {
        assert.equal(params.algorithm, 'RSA_PKCS1_SHA_256');
        return { keyId: params.keyId, keyVersionId: params.keyVersionId, value: signDigest(lookup(params.keyId, params.keyVersionId).privateKey, params.digest), requestId: 'req-sign' };
      }),
  };
}

function kmsEnv(overrides = {}) {
  return localEnv(fileKey, {
    DDC_AUTH_ENV: 'test',
    DDC_AUTH_SIGNER: 'kms',
    DDC_AUTH_KMS_KEY_ID: KEY_ID,
    DDC_AUTH_KMS_KEY_VERSION_ID: VERSION,
    DDC_AUTH_JWKS_PINNED: kmsKey.thumbprint,
    // Presence only: DDC_AUTH_KMS_CREDENTIALS=env (the default) needs both names set. Throwaway
    // strings; the mock KMS never reads them.
    ALIBABA_CLOUD_ACCESS_KEY_ID: 'TEST-ONLY-AK-ID',
    ALIBABA_CLOUD_ACCESS_KEY_SECRET: 'test-only-not-a-secret',
    ...overrides,
  });
}

function kmsCfg(overrides) {
  return config.readNativeAuthConfig(kmsEnv(overrides));
}

/** The cached signer for `cfg`, created with the mock client (what the app then uses). */
function installMock(cfg, client = mockKms()) {
  resetSignerCache();
  getSigner(cfg, { kmsClient: client });
  return client;
}

function signerWith(client, options = {}) {
  return createKmsSigner({ keyId: KEY_ID, keyVersionId: VERSION, region: 'ap-southeast-1', timeoutMs: 200, client, wait: async () => {}, ...options });
}

function decode(token) {
  const [h, p, s] = token.split('.');
  return { header: JSON.parse(Buffer.from(h, 'base64url')), payload: JSON.parse(Buffer.from(p, 'base64url')), signingInput: `${h}.${p}`, signature: s };
}

function captureLogs() {
  const lines = [];
  const transport = new winston.transports.Stream({ stream: new (require('stream').Writable)({ write(chunk, enc, cb) { lines.push(String(chunk)); cb(); } }) });
  config.logger.add(transport);
  return { lines, stop: () => config.logger.remove(transport) };
}

beforeEach(() => {
  resetSignerCache();
  issuer.resetJwksCache();
});

describe('KMS signer: tokens verify against the published JWKS', () => {
  it('mints RS256 through KMS; jose verifies it against buildPublicJwks; kid = thumbprint of the KMS key', async () => {
    const jose = await import('jose');
    const cfg = kmsCfg();
    const client = installMock(cfg);
    const minted = await issuer.mintW3aJwt({ subject: SUBJECT, cfg });
    const jwks = issuer.buildPublicJwks(cfg);
    assert.deepEqual(jwks.keys.map((k) => k.kid), [kmsKey.thumbprint]);
    assert.deepEqual(Object.keys(jwks.keys[0]).sort(), ['alg', 'e', 'kid', 'kty', 'n', 'use']);
    const { payload, protectedHeader } = await jose.jwtVerify(minted.idToken, jose.createLocalJWKSet(jwks), {
      issuer: 'ddc-auth-devnet',
      audience: 'ddc-w3a-devnet',
      algorithms: ['RS256'],
    });
    assert.equal(payload.sub, SUBJECT);
    assert.deepEqual(protectedHeader, { alg: 'RS256', typ: 'JWT', kid: kmsKey.thumbprint });
    assert.equal(minted.kid, kmsKey.thumbprint);
    assert.equal(client.calls.filter((c) => c.op === 'GetPublicKey').length, 1, 'public key fetched once');
    assert.equal(client.calls.filter((c) => c.op === 'AsymmetricSign').length, 1);
  });

  it('verifies with the repo JWT library (jsonwebtoken) using the PEM of the published JWK', async () => {
    const cfg = kmsCfg();
    installMock(cfg);
    const { idToken } = await issuer.mintW3aJwt({ subject: SUBJECT, cfg });
    const published = issuer.buildPublicJwks(cfg).keys[0];
    const pem = crypto.createPublicKey({ key: { kty: published.kty, n: published.n, e: published.e }, format: 'jwk' }).export({ format: 'pem', type: 'spki' });
    const claims = jsonwebtoken.verify(idToken, pem, { algorithms: ['RS256'], issuer: 'ddc-auth-devnet', audience: 'ddc-w3a-devnet' });
    assert.equal(claims.user_id, SUBJECT);
  });

  it('sends KMS the standard-base64 SHA-256 of the exact JWS signing input, and base64url-encodes the signature', async () => {
    const client = mockKms();
    const signer = signerWith(client);
    await signer.ready();
    const token = await signer.sign({ alg: 'RS256', typ: 'JWT', kid: kmsKey.thumbprint }, { iss: 'x', n: 'ünïcødé ✓', pad: '>>>???' });
    const { signingInput, signature } = decode(token);
    const sent = client.calls.find((c) => c.op === 'AsymmetricSign');
    assert.equal(sent.digest, crypto.createHash('sha256').update(signingInput, 'ascii').digest('base64'));
    assert.match(sent.digest, /^[A-Za-z0-9+/]{43}=$/, 'standard base64 with padding, 32 bytes');
    assert.equal(sent.keyId, KEY_ID);
    assert.equal(sent.keyVersionId, VERSION);
    assert.match(signature, /^[A-Za-z0-9_-]{342}$/, 'base64url, no padding, 256 bytes');
    assert.ok(crypto.verify('sha256', Buffer.from(signingInput), kmsKey.publicKey, Buffer.from(signature, 'base64url')));
  });

  it('kid is stable: the same key version always yields the same kid; header kid must name it', async () => {
    const a = signerWith(mockKms());
    const b = signerWith(mockKms());
    await Promise.all([a.ready(), b.ready()]);
    assert.equal(a.kid, kmsKey.thumbprint);
    assert.equal(b.kid, a.kid);
    await assert.rejects(a.sign({ alg: 'RS256', kid: otherKey.thumbprint }, {}), /does not name this key/);
    await assert.rejects(a.sign({ alg: 'HS256' }, {}), /RS256 only/);
  });

  it('logs the KMS sign count next to w3a_jwt_issued, and never a digest, signature or key material', async () => {
    const cfg = kmsCfg();
    const client = installMock(cfg);
    const capture = captureLogs();
    try {
      await prepareSigner(cfg);
      const minted = await issuer.issueW3aToken({ subject: SUBJECT, loginRef: '0123456789abcdef', count: 1, cfg });
      const issued = JSON.parse(capture.lines.find((l) => l.includes('native_auth.w3a_jwt_issued')));
      assert.equal(issued.signer, 'kms');
      assert.equal(issued.kmsSignCount, 2, 'self test + this token');
      assert.equal(issued.kid, kmsKey.thumbprint);
      const loaded = JSON.parse(capture.lines.find((l) => l.includes('native_auth.kms_key_loaded')));
      assert.equal(loaded.keyId, KEY_ID);
      assert.equal(loaded.keyVersionId, VERSION);
      const all = capture.lines.join('\n');
      const pub = kmsKey.publicKey.export({ format: 'jwk' });
      for (const call of client.calls.filter((c) => c.op === 'AsymmetricSign')) assert.ok(!all.includes(call.digest), 'digest logged');
      assert.ok(!all.includes(minted.idToken.split('.')[2]), 'signature logged');
      assert.ok(!all.includes(pub.n.slice(0, 40)), 'modulus logged');
      assert.ok(!all.includes('BEGIN PUBLIC KEY'), 'PEM logged');
      assert.ok(!all.includes(SUBJECT), 'sub logged');
    } finally {
      capture.stop();
    }
  });
});

describe('KMS signer: fails closed', () => {
  it('a non-retryable KMS error rejects after one attempt; no token, no fallback to the configured key file', async () => {
    const cfg = kmsCfg(); // DDC_AUTH_SIGNING_KEY_FILE is still set from localEnv: it must not be used
    assert.ok(cfg.signingKeyFile);
    const client = installMock(cfg, mockKms({
      behave: ({ op }) => {
        if (op === 'AsymmetricSign') throw Object.assign(new Error('Forbidden: not authorized'), { code: 'Forbidden.NoPermission', statusCode: 403, requestId: 'req-403' });
        return undefined;
      },
    }));
    const logs = captureLogs();
    try {
      await assert.rejects(issuer.mintW3aJwt({ subject: SUBJECT, cfg }), (err) => {
        // The client sees a generic 503; the KMS details go to the operator log only.
        assert.equal(err.statusCode, 503);
        assert.equal(err.message, 'Sign-in is temporarily unavailable. Please try again shortly.');
        assert.match(err.cause.message, /KMS AsymmetricSign failed after 1 attempt\(s\): Forbidden\.NoPermission — HTTP 403 — requestId req-403/);
        return true;
      });
    } finally {
      logs.stop();
    }
    const logged = logs.lines.join('');
    assert.match(logged, /native_auth\.kms_sign_failed/);
    assert.match(logged, /Forbidden\.NoPermission/);
    assert.equal(client.calls.filter((c) => c.op === 'AsymmetricSign').length, 1);
  });

  it('retries transient failures (5xx, throttling, network) and succeeds within the attempt budget', async () => {
    const failures = [
      Object.assign(new Error('Service unavailable'), { code: 'ServiceUnavailable', statusCode: 503 }),
      Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
    ];
    const client = mockKms({ behave: ({ op, attempt }) => { if (op === 'AsymmetricSign' && attempt <= failures.length) throw failures[attempt - 1]; return undefined; } });
    const signer = signerWith(client);
    const token = await signer.sign({ alg: 'RS256' }, { a: 1 });
    assert.equal(token.split('.').length, 3);
    assert.equal(client.calls.filter((c) => c.op === 'AsymmetricSign').length, 3);
    assert.equal(signer.signCount(), 1);
  });

  it('gives up after MAX_ATTEMPTS transient failures', async () => {
    const client = mockKms({ behave: ({ op }) => { if (op === 'AsymmetricSign') throw Object.assign(new Error('Throttling.User'), { code: 'Throttling.User', statusCode: 429 }); return undefined; } });
    const signer = signerWith(client);
    await assert.rejects(signer.sign({ alg: 'RS256' }, {}), new RegExp(`failed after ${kmsSigner.MAX_ATTEMPTS} attempt`));
    assert.equal(client.calls.filter((c) => c.op === 'AsymmetricSign').length, kmsSigner.MAX_ATTEMPTS);
    assert.equal(signer.signCount(), 0);
  });

  it('times out a hanging KMS call (each attempt), then fails closed', async () => {
    const client = mockKms({ behave: ({ op }) => (op === 'AsymmetricSign' ? new Promise(() => {}) : undefined) });
    const signer = signerWith(client, { timeoutMs: 30 });
    const started = Date.now();
    await assert.rejects(signer.sign({ alg: 'RS256' }, {}), /AsymmetricSign failed after 3 attempt\(s\): KMS AsymmetricSign timed out after 30 ms/);
    assert.ok(Date.now() - started < 2000);
  });

  it('a hanging GetPublicKey times out too, so the boot step cannot hang', async () => {
    const signer = signerWith(mockKms({ behave: ({ op }) => (op === 'GetPublicKey' ? new Promise(() => {}) : undefined) }), { timeoutMs: 30 });
    await assert.rejects(signer.ready(), /GetPublicKey failed after 3 attempt\(s\): KMS GetPublicKey timed out/);
  });

  it('refuses a signature made by another key (it would not verify against the published JWKS)', async () => {
    const client = mockKms({ behave: ({ op, params }) => (op === 'AsymmetricSign' ? { keyVersionId: VERSION, value: signDigest(otherKey.privateKey, params.digest) } : undefined) });
    await assert.rejects(signerWith(client).sign({ alg: 'RS256' }, {}), /does not verify against the published public key/);
  });

  it('refuses a signature over another digest (e.g. a double-hash or base64url mix-up)', async () => {
    const client = mockKms({
      behave: ({ op, params }) => {
        if (op !== 'AsymmetricSign') return undefined;
        const wrong = crypto.createHash('sha256').update(Buffer.from(params.digest, 'base64')).digest('base64');
        return { keyVersionId: VERSION, value: signDigest(kmsKey.privateKey, wrong) };
      },
    });
    await assert.rejects(signerWith(client).sign({ alg: 'RS256' }, {}), /does not verify/);
  });

  it('refuses an answer for another key version, a non-base64 value or a wrong-length signature', async () => {
    const answers = [
      [{ keyVersionId: NEXT_VERSION, value: 'AAAA' }, /answered for another key version/],
      [{ keyVersionId: VERSION, value: 'not base64!' }, /no base64 signature/],
      [{ keyVersionId: VERSION, value: undefined }, /no base64 signature/],
      [{ keyVersionId: VERSION, value: Buffer.alloc(128).toString('base64') }, /wrong length/],
    ];
    for (const [answer, re] of answers) {
      const client = mockKms({ behave: ({ op }) => (op === 'AsymmetricSign' ? answer : undefined) });
      await assert.rejects(signerWith(client).sign({ alg: 'RS256' }, {}), re);
    }
  });

  it('a failed key load is remembered for 30 s (no KMS call per request), then retried', async () => {
    let clock = 1_000_000;
    let fail = true;
    const client = mockKms({ behave: ({ op }) => { if (op === 'GetPublicKey' && fail) throw Object.assign(new Error('denied'), { code: 'Forbidden.RAM', statusCode: 403 }); return undefined; } });
    const signer = signerWith(client, { now: () => clock });
    await assert.rejects(signer.ready(), /Forbidden\.RAM/);
    await assert.rejects(signer.ready(), /Forbidden\.RAM/);
    await assert.rejects(signer.sign({ alg: 'RS256' }, {}), /Forbidden\.RAM/);
    assert.throws(() => signer.kid, /could not be loaded: .*Forbidden\.RAM/);
    assert.equal(client.calls.length, 1, 'one GetPublicKey for three uses inside the window');
    fail = false;
    clock += kmsSigner.LOAD_RETRY_AFTER_MS;
    await signer.ready();
    assert.equal(signer.kid, kmsKey.thumbprint);
    assert.equal(client.calls.length, 2);
  });

  it('concurrent first uses share one GetPublicKey', async () => {
    const client = mockKms();
    const signer = signerWith(client);
    await Promise.all([signer.ready(), signer.ready(), signer.sign({ alg: 'RS256' }, {})]);
    assert.equal(client.calls.filter((c) => c.op === 'GetPublicKey').length, 1);
  });

  it('refuses a KMS public key that is not RSA >= 2048 with e = 65537', () => {
    const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ format: 'pem', type: 'spki' });
    assert.throws(() => publicKeyFromPem(ec, 'k'), /not RSA/);
    const small = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey.export({ format: 'pem', type: 'spki' });
    assert.throws(() => publicKeyFromPem(small, 'k'), /at least 2048 bits/);
    const e3 = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicExponent: 3 }).publicKey.export({ format: 'pem', type: 'spki' });
    assert.throws(() => publicKeyFromPem(e3, 'k'), /exponent must be 65537/);
    assert.throws(() => publicKeyFromPem('', 'k'), /no PEM public key/);
    assert.throws(() => publicKeyFromPem('-----BEGIN PUBLIC KEY-----\nnope\n-----END PUBLIC KEY-----', 'k'), /cannot be parsed/);
    assert.equal(publicKeyFromPem(kmsKey.pem, 'k').thumbprint, kmsKey.thumbprint);
  });

  it('classifies errors: 4xx (but 429) and credential errors are final; 5xx, 429, timeouts and socket errors retry', () => {
    assert.equal(isRetryable({ statusCode: 404, code: 'Forbidden.KeyNotFound' }), false);
    assert.equal(isRetryable({ statusCode: 400, code: 'InvalidParameter' }), false);
    assert.equal(isRetryable({ code: 'InvalidCredentials', message: 'Please set up the credentials correctly.' }), false);
    assert.equal(isRetryable({ statusCode: 429 }), true);
    assert.equal(isRetryable({ statusCode: 502 }), true);
    assert.equal(isRetryable({ code: 'ETIMEDOUT' }), true);
    assert.equal(isRetryable({ message: 'socket hang up' }), true);
    const text = describeError({ code: 'X', message: `bad token ${'A'.repeat(40)} end` });
    assert.ok(!text.includes('A'.repeat(24)), 'long base64 runs are cut from messages');
    const noCreds = new Error('unable to get credentials from any of the providers in the chain: ...');
    assert.equal(kmsSigner.isNoCredentials(noCreds), true);
    assert.equal(isRetryable(noCreds), false, 'missing credentials is configuration, not a transient failure');
    assert.match(describeError(noCreds), /^no Alibaba Cloud credentials found \(DDC_AUTH_KMS_CREDENTIALS=env: set ALIBABA_CLOUD_ACCESS_KEY_ID/);
  });

  it('rebuilds the SDK client after a failure without an HTTP answer (sticky default credential chain), not after a KMS error', async () => {
    const clientModule = require('../../src/services/nativeAuth/signer/aliyunKmsClient');
    const original = clientModule.createAliyunKmsClient;
    const built = [];
    const script = [
      () => { throw Object.assign(new Error('connect ETIMEDOUT 100.100.100.200:80'), { code: 'ETIMEDOUT' }); },
      () => { throw Object.assign(new Error('Throttling'), { code: 'Throttling', statusCode: 503 }); },
      null, // success
    ];
    clientModule.createAliyunKmsClient = (options) => {
      built.push(options);
      const mock = mockKms();
      return {
        getPublicKey: (params) => {
          const step = script.shift();
          if (step) step();
          return mock.getPublicKey(params);
        },
        asymmetricSign: mock.asymmetricSign,
      };
    };
    try {
      const signer = createKmsSigner({ keyId: KEY_ID, keyVersionId: VERSION, region: 'ap-southeast-1', timeoutMs: 200, wait: async () => {} });
      await signer.ready();
      assert.equal(signer.kid, kmsKey.thumbprint);
      assert.equal(built.length, 2, 'one rebuild after the network failure, none after the HTTP 503');
      assert.deepEqual(built[0], { region: 'ap-southeast-1', endpoint: '', caFile: '', timeoutMs: 200, credentials: 'env' });
    } finally {
      clientModule.createAliyunKmsClient = original;
    }
  });
});

describe('prepareSigner (boot step) and rotation keys', () => {
  it('src/server.js runs it before listening and exits non-zero when it fails', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/server.js'), 'utf8');
    const prepareAt = src.indexOf('await prepareSigner()');
    const listenAt = src.indexOf('app.listen(');
    assert.ok(prepareAt > -1 && listenAt > prepareAt, 'prepareSigner() must be awaited before app.listen()');
    assert.match(src.slice(prepareAt, listenAt), /catch \(err\) \{[\s\S]*refusing to start[\s\S]*process\.exit\(1\)/);
  });

  it('fetches, checks the pin and signs + verifies one throwaway token', async () => {
    const cfg = kmsCfg();
    const client = installMock(cfg);
    const result = await prepareSigner(cfg);
    assert.deepEqual(result, { kid: kmsKey.thumbprint, extraKids: [], keyId: KEY_ID, keyVersionId: VERSION, region: 'ap-southeast-1', endpoint: 'kms.ap-southeast-1.aliyuncs.com', credentials: 'env' });
    assert.equal(client.calls.filter((c) => c.op === 'AsymmetricSign').length, 1);
    assert.equal(readyKid(cfg), kmsKey.thumbprint);
    assert.equal(config.summarize(cfg).kid, kmsKey.thumbprint);
  });

  it('refuses a KMS key that is not in DDC_AUTH_JWKS_PINNED (and signs nothing)', async () => {
    const cfg = kmsCfg({ DDC_AUTH_JWKS_PINNED: otherKey.thumbprint });
    const client = installMock(cfg);
    await assert.rejects(prepareSigner(cfg), /The KMS signing key \(thumbprint [A-Za-z0-9_-]{43}\) is not listed in DDC_AUTH_JWKS_PINNED/);
    assert.equal(client.calls.filter((c) => c.op === 'AsymmetricSign').length, 0);
    await assert.rejects(issuer.mintW3aJwt({ subject: SUBJECT, cfg }), /not listed in DDC_AUTH_JWKS_PINNED/);
  });

  it('refuses the leaked auth-key-1 thumbprint even when pinned', async () => {
    const cfg = kmsCfg();
    installMock(cfg);
    const set = config.leakedKeys().thumbprints;
    set.add(kmsKey.thumbprint);
    try {
      await assert.rejects(prepareSigner(cfg), /publicly leaked key auth-key-1/);
    } finally {
      set.delete(kmsKey.thumbprint);
    }
  });

  it('fails the boot step when KMS cannot be reached or denies GetPublicKey', async () => {
    const cfg = kmsCfg();
    installMock(cfg, mockKms({ keys: {} }));
    await assert.rejects(prepareSigner(cfg), /KMS GetPublicKey failed after 1 attempt\(s\): Forbidden\.KeyNotFound — HTTP 404/);
  });

  it('publishes pinned DDC_AUTH_KMS_EXTRA_KEYS (next / previous versions) and never signs with them', async () => {
    const jose = await import('jose');
    const cfg = kmsCfg({ DDC_AUTH_KMS_EXTRA_KEYS: `${KEY_ID}/${NEXT_VERSION}`, DDC_AUTH_JWKS_PINNED: `${kmsKey.thumbprint},${nextKmsKey.thumbprint}` });
    const client = installMock(cfg, mockKms({ keys: { [`${KEY_ID}/${VERSION}`]: kmsKey, [`${KEY_ID}/${NEXT_VERSION}`]: nextKmsKey } }));
    const result = await prepareSigner(cfg);
    assert.deepEqual(result.extraKids, [nextKmsKey.thumbprint]);
    const jwks = issuer.buildPublicJwks(cfg);
    assert.deepEqual(jwks.keys.map((k) => k.kid), [kmsKey.thumbprint, nextKmsKey.thumbprint]);
    const { idToken } = await issuer.mintW3aJwt({ subject: SUBJECT, cfg });
    const { protectedHeader } = await jose.jwtVerify(idToken, jose.createLocalJWKSet(jwks), { algorithms: ['RS256'] });
    assert.equal(protectedHeader.kid, kmsKey.thumbprint);
    assert.ok(client.calls.filter((c) => c.op === 'AsymmetricSign').every((c) => c.keyVersionId === VERSION));
  });

  it('refuses an unpinned rotation key at boot and at JWKS time', async () => {
    const cfg = kmsCfg({ DDC_AUTH_KMS_EXTRA_KEYS: `${KEY_ID}/${NEXT_VERSION}` });
    installMock(cfg, mockKms({ keys: { [`${KEY_ID}/${VERSION}`]: kmsKey, [`${KEY_ID}/${NEXT_VERSION}`]: nextKmsKey } }));
    await assert.rejects(prepareSigner(cfg), new RegExp(`DDC_AUTH_KMS_EXTRA_KEYS key ${KEY_ID}/${NEXT_VERSION} \\(thumbprint [A-Za-z0-9_-]{43}\\) is not listed`));
    assert.throws(() => issuer.buildPublicJwks(cfg), /DDC_AUTH_KMS_EXTRA_KEYS key .* is not listed/);
  });
});

describe('GET /.well-known/ddc-auth/jwks.json with the KMS signer', () => {
  const saved = {};
  const servers = [];
  const setEnv = (vars) => {
    for (const [k, v] of Object.entries(vars)) {
      if (!(k in saved)) saved[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
      delete saved[k];
    }
    await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
  });
  async function app() {
    const a = express();
    a.get('/.well-known/ddc-auth/jwks.json', issuer.jwksHandler);
    a.use((req, res) => res.status(404).send('fell through'));
    const server = await listenLoopback(a);
    servers.push(server);
    return server;
  }

  it('loads the KMS public key on first request (native login off) and serves it', async () => {
    const env = { ...kmsEnv({ DDC_AUTH_ENABLED: 'false' }), DDC_AUTH_JWKS_EXTRA_FILE: undefined };
    setEnv(env);
    const client = installMock(config.readNativeAuthConfig(process.env));
    const res = await request(await app()).get('/.well-known/ddc-auth/jwks.json');
    assert.equal(res.status, 200);
    assert.equal(res.headers['cache-control'], 'public, max-age=300');
    assert.deepEqual(res.body.keys.map((k) => k.kid), [kmsKey.thumbprint]);
    assert.equal(client.calls.filter((c) => c.op === 'AsymmetricSign').length, 0, 'serving the JWKS never signs');
  });

  it('falls through while KMS is down, without a KMS call per request, and serves once the key loads', async () => {
    setEnv({ ...kmsEnv(), DDC_AUTH_JWKS_EXTRA_FILE: undefined });
    let down = true;
    const client = installMock(config.readNativeAuthConfig(process.env), mockKms({ behave: ({ op }) => { if (op === 'GetPublicKey' && down) throw Object.assign(new Error('unavailable'), { code: 'Forbidden.RAM', statusCode: 403 }); return undefined; } }));
    const server = await app();
    for (let i = 0; i < 3; i += 1) {
      const res = await request(server).get('/.well-known/ddc-auth/jwks.json');
      assert.equal(res.status, 404);
    }
    assert.equal(client.calls.length, 1, 'failure remembered by the signer');
    // A fresh signer (e.g. after the 30 s window) loads and serves; the refusal was not cached.
    down = false;
    installMock(config.readNativeAuthConfig(process.env), client);
    const res = await request(server).get('/.well-known/ddc-auth/jwks.json');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.keys.map((k) => k.kid), [kmsKey.thumbprint]);
  });
});

describe('DDC_AUTH_KMS_* boot rules', () => {
  const problems = (overrides) => config.nativeAuthProblems(kmsCfg(overrides), kmsEnv(overrides));

  it('defaults: region ap-southeast-1, standard endpoint, 3 s timeout; a complete test config passes the boot gate', () => {
    const cfg = kmsCfg();
    assert.equal(cfg.kms.region, 'ap-southeast-1');
    assert.equal(cfg.kms.endpoint, '');
    assert.equal(cfg.kms.timeoutMs, 3000);
    assert.deepEqual(problems(), []);
    assert.equal(config.assertNativeAuthConfig(kmsEnv()).signer, 'kms');
  });

  it('requires the key id and the key version, and refuses aliases', () => {
    assert.ok(problems({ DDC_AUTH_KMS_KEY_ID: '' }).some((p) => /DDC_AUTH_KMS_KEY_ID is required with DDC_AUTH_SIGNER=kms/.test(p)));
    assert.ok(problems({ DDC_AUTH_KMS_KEY_VERSION_ID: '' }).some((p) => /DDC_AUTH_KMS_KEY_VERSION_ID is required/.test(p)));
    assert.ok(problems({ DDC_AUTH_KMS_KEY_ID: 'alias/ddc-auth' }).some((p) => /not an alias/.test(p)));
    assert.ok(problems({ DDC_AUTH_KMS_KEY_ID: 'acs:kms:ap-southeast-1:123:alias/ddc' }).some((p) => /not an alias/.test(p)));
    assert.ok(problems({ DDC_AUTH_KMS_KEY_VERSION_ID: 'v 1' }).some((p) => /must be a KMS key version id/.test(p)));
    assert.deepEqual(problems({ DDC_AUTH_KMS_KEY_ID: 'acs:kms:ap-southeast-1:1234567890:key/key-sgp000' }), [], 'a key ARN is fine');
  });

  it('accepts only KMS hosts for the region (standard, VPC or dedicated instance gateway)', () => {
    for (const ok of ['kms.ap-southeast-1.aliyuncs.com', 'kms-vpc.ap-southeast-1.aliyuncs.com', 'kst-sgp64abcd.cryptoservice.kms.aliyuncs.com', 'KMS.ap-southeast-1.aliyuncs.com']) {
      assert.deepEqual(problems({ DDC_AUTH_KMS_ENDPOINT: ok }), [], ok);
    }
    for (const bad of [
      'https://kms.ap-southeast-1.aliyuncs.com',
      'kms.ap-southeast-1.aliyuncs.com:443',
      'kms.example.com',
      'aliyuncs.com.evil.example',
      'kms.aliyuncs.com/x',
      // Other Alibaba Cloud hosts, some with user-chosen names, must not receive signed requests.
      'my-bucket.oss-ap-southeast-1.aliyuncs.com',
      'kms.ap-southeast-1.aliyuncs.com.oss-ap-southeast-1.aliyuncs.com',
      'sts.ap-southeast-1.aliyuncs.com',
      'kms.cn-hangzhou.aliyuncs.com', // another region than DDC_AUTH_KMS_REGION
      'kst-x.cryptoservice.kms.aliyuncs.com.evil.example',
      'evil.cryptoservice.kms.aliyuncs.com',
    ]) {
      assert.ok(problems({ DDC_AUTH_KMS_ENDPOINT: bad }).some((p) => /DDC_AUTH_KMS_ENDPOINT must be a bare KMS host name/.test(p)), bad);
    }
  });

  it('checks region, timeout, CA bundle and rotation entries', () => {
    assert.ok(problems({ DDC_AUTH_KMS_REGION: 'singapore' }).some((p) => /DDC_AUTH_KMS_REGION/.test(p)));
    assert.ok(problems({ DDC_AUTH_KMS_TIMEOUT_MS: 'soon' }).some((p) => /DDC_AUTH_KMS_TIMEOUT_MS/.test(p)));
    assert.equal(kmsCfg({ DDC_AUTH_KMS_TIMEOUT_MS: '60000' }).kms.timeoutMs, 10000, 'clamped');
    assert.equal(kmsCfg({ DDC_AUTH_KMS_TIMEOUT_MS: '10' }).kms.timeoutMs, 500, 'clamped');
    const ca = path.join(keyDir, `ca-${process.pid}.pem`);
    fs.writeFileSync(ca, '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n');
    assert.ok(problems({ DDC_AUTH_KMS_CA_FILE: ca }).some((p) => /only used with a dedicated KMS instance endpoint/.test(p)));
    assert.deepEqual(problems({ DDC_AUTH_KMS_CA_FILE: ca, DDC_AUTH_KMS_ENDPOINT: 'kst-sgp64abcd.cryptoservice.kms.aliyuncs.com' }), []);
    assert.ok(problems({ DDC_AUTH_KMS_CA_FILE: path.join(keyDir, 'missing.pem'), DDC_AUTH_KMS_ENDPOINT: 'kst-sgp64abcd.cryptoservice.kms.aliyuncs.com' }).some((p) => /cannot be read/.test(p)));
    assert.ok(problems({ DDC_AUTH_KMS_EXTRA_KEYS: 'just-a-key-id' }).some((p) => /entry #1 must be <keyId>\/<keyVersionId>/.test(p)));
    assert.ok(problems({ DDC_AUTH_KMS_EXTRA_KEYS: `${KEY_ID}/${VERSION}` }).some((p) => /repeats a key version/.test(p)));
    assert.deepEqual(problems({ DDC_AUTH_KMS_EXTRA_KEYS: `acs:kms:ap-southeast-1:123:key/${KEY_ID}/${NEXT_VERSION}` }), []);
    assert.deepEqual(config.parseKmsKeyRef(`acs:kms:ap-southeast-1:123:key/${KEY_ID}/${NEXT_VERSION}`), { keyId: `acs:kms:ap-southeast-1:123:key/${KEY_ID}`, keyVersionId: NEXT_VERSION });
  });

  it('DDC_AUTH_KMS_CREDENTIALS: env (default) needs the access key names; chain (instance RAM role) is production-only', () => {
    assert.equal(kmsCfg().kms.credentials, 'env');
    for (const missing of ['ALIBABA_CLOUD_ACCESS_KEY_ID', 'ALIBABA_CLOUD_ACCESS_KEY_SECRET']) {
      assert.ok(problems({ [missing]: '' }).some((p) => /DDC_AUTH_KMS_CREDENTIALS=env needs ALIBABA_CLOUD_ACCESS_KEY_ID and ALIBABA_CLOUD_ACCESS_KEY_SECRET/.test(p)), missing);
    }
    // The shared-server rule: a test stack can never fall through to the ECS instance role.
    for (const env of ['test', 'local']) {
      const found = problems({ DDC_AUTH_ENV: env, DDC_AUTH_KMS_CREDENTIALS: 'chain' });
      assert.ok(found.some((p) => /DDC_AUTH_KMS_CREDENTIALS=chain is allowed only with DDC_AUTH_ENV=prod/.test(p)), env);
    }
    const prodChain = config.readNativeAuthConfig(kmsEnv({ DDC_AUTH_ENV: 'prod', DDC_AUTH_KMS_CREDENTIALS: 'chain', ALIBABA_CLOUD_ACCESS_KEY_ID: '', ALIBABA_CLOUD_ACCESS_KEY_SECRET: '' }));
    assert.equal(config.kmsCredentialsProblem(prodChain), '');
    assert.ok(problems({ DDC_AUTH_KMS_CREDENTIALS: 'imds' }).some((p) => /DDC_AUTH_KMS_CREDENTIALS must be one of env \| chain/.test(p)));
    // Names only in messages and summaries, never values.
    const all = problems({ ALIBABA_CLOUD_ACCESS_KEY_SECRET: '' }).join(' ');
    assert.ok(!all.includes('TEST-ONLY-AK-ID'));
    assert.ok(!JSON.stringify(kmsCfg()).includes('test-only-not-a-secret'));
    assert.match(config.summaryLine(config.summarize(kmsCfg())), / kmsCredentials=env$/);
  });

  it('the signer itself refuses chain outside production (the JWKS route can create it with native login off)', () => {
    assert.throws(() => getSigner(kmsCfg({ DDC_AUTH_KMS_CREDENTIALS: 'chain' }), { kmsClient: mockKms() }), /chain is allowed only with DDC_AUTH_ENV=prod/);
    assert.throws(() => getSigner(kmsCfg({ DDC_AUTH_KMS_CREDENTIALS: 'imds' }), { kmsClient: mockKms() }), /must be one of env \| chain/);
    assert.equal(getSigner(kmsCfg({ DDC_AUTH_ENV: 'prod', DDC_AUTH_KMS_CREDENTIALS: 'chain' }), { kmsClient: mockKms() }).kind, 'kms');
  });

  it('the money path still demands KMS for native login (production rules)', () => {
    assert.ok(config.productionProblems(kmsCfg({ DDC_AUTH_SIGNER: 'file' })).some((p) => /production requires DDC_AUTH_SIGNER=kms/.test(p)));
    assert.ok(!config.productionProblems(kmsCfg()).some((p) => /DDC_AUTH_SIGNER/.test(p)));
  });
});

describe('the official SDK on the wire (loopback fake KMS, throwaway access key)', () => {
  it('sends AsymmetricSign / GetPublicKey with KeyId, KeyVersionId, Algorithm and the base64 digest, signed ACS3-HMAC-SHA256', async () => {
    const jose = await import('jose');
    const seen = [];
    const fake = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const q = Object.fromEntries(url.searchParams);
      const action = req.headers['x-acs-action'];
      seen.push({ action, method: req.method, query: q, version: req.headers['x-acs-version'], authorization: String(req.headers.authorization || '') });
      req.resume();
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        if (q.KeyId !== KEY_ID || q.KeyVersionId !== VERSION) {
          res.statusCode = 404;
          return res.end(JSON.stringify({ RequestId: 'fake-404', Code: 'Forbidden.KeyNotFound', Message: 'The specified Key is not found.' }));
        }
        if (action === 'GetPublicKey') return res.end(JSON.stringify({ RequestId: 'fake-pk', KeyId: KEY_ID, KeyVersionId: VERSION, PublicKey: kmsKey.pem }));
        if (action === 'AsymmetricSign') return res.end(JSON.stringify({ RequestId: 'fake-sign', KeyId: KEY_ID, KeyVersionId: VERSION, Value: signDigest(kmsKey.privateKey, q.Digest) }));
        res.statusCode = 400;
        return res.end(JSON.stringify({ RequestId: 'fake-400', Code: 'InvalidAction', Message: 'unknown action' }));
      });
    });
    await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve));
    try {
      const Credential = require('@alicloud/credentials').default;
      const { Config } = require('@alicloud/credentials');
      const credential = new Credential(new Config({ type: 'access_key', accessKeyId: 'TEST-ONLY-AK-ID', accessKeySecret: 'test-only-not-a-secret' }));
      const client = createAliyunKmsClient({ region: 'ap-southeast-1', endpoint: `127.0.0.1:${fake.address().port}`, timeoutMs: 2000, protocol: 'http', credential });
      const signer = createKmsSigner({ keyId: KEY_ID, keyVersionId: VERSION, region: 'ap-southeast-1', timeoutMs: 2000, client });
      await signer.ready();
      const token = await signer.sign({ alg: 'RS256', typ: 'JWT' }, { iss: 'ddc-auth-devnet', aud: 'ddc-w3a-devnet', sub: SUBJECT });
      const jwks = { keys: [{ ...signer.publicJwk(), kid: signer.kid, alg: 'RS256', use: 'sig' }] };
      const { payload } = await jose.jwtVerify(token, jose.createLocalJWKSet(jwks), { algorithms: ['RS256'] });
      assert.equal(payload.sub, SUBJECT);

      const [pk, sign] = seen;
      assert.equal(pk.action, 'GetPublicKey');
      assert.equal(sign.action, 'AsymmetricSign');
      for (const call of seen) {
        assert.equal(call.method, 'POST');
        assert.equal(call.version, '2016-01-20');
        assert.match(call.authorization, /^ACS3-HMAC-SHA256 Credential=TEST-ONLY-AK-ID,/);
        assert.ok(!call.authorization.includes('test-only-not-a-secret'), 'the secret is never sent');
      }
      assert.equal(sign.query.Algorithm, 'RSA_PKCS1_SHA_256');
      assert.equal(sign.query.Digest, crypto.createHash('sha256').update(token.split('.').slice(0, 2).join('.')).digest('base64'));

      // An SDK error (HTTP 404 + KMS error code) becomes a final, secret-free failure.
      const wrong = createKmsSigner({ keyId: 'key-other', keyVersionId: VERSION, region: 'ap-southeast-1', timeoutMs: 2000, client });
      await assert.rejects(wrong.ready(), /KMS GetPublicKey failed after 1 attempt\(s\): Forbidden\.KeyNotFound — HTTP 404 — requestId fake-404/);
    } finally {
      await new Promise((resolve) => fake.close(resolve));
    }
  });
});

describe('DDC_AUTH_KMS_CREDENTIALS=env on the wire (shared server: never the instance RAM role)', () => {
  it('signs requests with the access key from the environment, and without one fails at once without asking the metadata service', async () => {
    const seen = [];
    const fake = http.createServer((req, res) => {
      seen.push({ action: req.headers['x-acs-action'], authorization: String(req.headers.authorization || '') });
      req.resume();
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ RequestId: 'fake-pk', KeyId: KEY_ID, KeyVersionId: VERSION, PublicKey: kmsKey.pem }));
      });
    });
    await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve));
    const names = ['ALIBABA_CLOUD_ACCESS_KEY_ID', 'ALIBABA_CLOUD_ACCESS_KEY_SECRET', 'ALIBABA_CLOUD_SECURITY_TOKEN'];
    const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
    // Any use of the ECS instance RAM role provider (the metadata service) is recorded and refused.
    const { ECSRAMRoleCredentialsProvider } = require('@alicloud/credentials');
    const originalEcs = ECSRAMRoleCredentialsProvider.prototype.getCredentials;
    let imdsCalls = 0;
    ECSRAMRoleCredentialsProvider.prototype.getCredentials = async function refused() {
      imdsCalls += 1;
      throw new Error('test: the instance metadata service must not be used');
    };
    const options = { region: 'ap-southeast-1', endpoint: `127.0.0.1:${fake.address().port}`, timeoutMs: 2000, protocol: 'http', credentials: 'env' };
    try {
      process.env.ALIBABA_CLOUD_ACCESS_KEY_ID = 'TEST-ONLY-ENV-AK-ID';
      process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET = 'test-only-env-not-a-secret';
      delete process.env.ALIBABA_CLOUD_SECURITY_TOKEN;
      const res = await createAliyunKmsClient(options).getPublicKey({ keyId: KEY_ID, keyVersionId: VERSION });
      assert.equal(res.publicKey, kmsKey.pem);
      assert.equal(seen.length, 1);
      assert.match(seen[0].authorization, /^ACS3-HMAC-SHA256 Credential=TEST-ONLY-ENV-AK-ID,/);
      assert.ok(!seen[0].authorization.includes('test-only-env-not-a-secret'));

      delete process.env.ALIBABA_CLOUD_ACCESS_KEY_ID;
      delete process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET;
      const signer = createKmsSigner({ keyId: KEY_ID, keyVersionId: VERSION, region: 'ap-southeast-1', timeoutMs: 2000, credentials: 'env', wait: async () => {} });
      const started = Date.now();
      await assert.rejects(signer.ready(), (err) => {
        assert.match(err.message, /GetPublicKey failed after 1 attempt\(s\): no Alibaba Cloud credentials found \(DDC_AUTH_KMS_CREDENTIALS=env/);
        return true;
      });
      assert.ok(Date.now() - started < 1000, 'no retries, no metadata-service timeouts');
      assert.equal(seen.length, 1, 'nothing was sent to KMS');
      assert.equal(imdsCalls, 0, 'env mode never consulted the instance metadata service');
      assert.throws(() => require('../../src/services/nativeAuth/signer/aliyunKmsClient').buildCredential('imds'), /DDC_AUTH_KMS_CREDENTIALS must be env or chain/);
    } finally {
      ECSRAMRoleCredentialsProvider.prototype.getCredentials = originalEcs;
      for (const n of names) {
        if (saved[n] === undefined) delete process.env[n];
        else process.env[n] = saved[n];
      }
      await new Promise((resolve) => fake.close(resolve));
    }
  });
});

describe('scripts/nativeAuthKmsCheck.js (operator check, mocked KMS)', () => {
  const check = require('../../scripts/nativeAuthKmsCheck');
  const run = async (argv, env, client = mockKms()) => {
    const out = [];
    const err = [];
    const { code, report } = await check.main(argv, { env, client, out: (l) => out.push(l), err: (l) => err.push(l) });
    return { code, report, text: [...out, ...err].join('\n'), client };
  };

  it('signs a sample through KMS, verifies it, and prints only identifiers (no token, digest or signature)', async () => {
    const { code, text, client } = await run([], kmsEnv());
    assert.equal(code, 0, text);
    assert.match(text, new RegExp(`OK   GetPublicKey: RSA-2048, kid ${kmsKey.thumbprint}`));
    assert.match(text, /OK   AsymmetricSign/);
    assert.match(text, /OK   verify \(KMS key set\)/);
    assert.match(text, /RESULT: OK/);
    const sign = client.calls.find((c) => c.op === 'AsymmetricSign');
    assert.ok(!text.includes(sign.digest), 'digest printed');
    assert.ok(!/eyJ[A-Za-z0-9_-]{10,}\./.test(text), 'token printed');
  });

  it('tells the operator what to pin when DDC_AUTH_JWKS_PINNED is empty', async () => {
    const { code, text } = await run([], kmsEnv({ DDC_AUTH_JWKS_PINNED: '' }));
    assert.equal(code, 1);
    assert.match(text, new RegExp(`set DDC_AUTH_JWKS_PINNED=${kmsKey.thumbprint}`));
  });

  it('checks the published JWKS and verifies the sample against it; a different published key fails', async () => {
    const good = path.join(keyDir, `published-ok-${process.pid}.json`);
    const pub = kmsKey.publicKey.export({ format: 'jwk' });
    fs.writeFileSync(good, JSON.stringify({ keys: [{ kty: 'RSA', n: pub.n, e: pub.e, kid: kmsKey.thumbprint, alg: 'RS256', use: 'sig' }] }));
    const ok = await run([`--jwks=${good}`], kmsEnv());
    assert.equal(ok.code, 0, ok.text);
    assert.match(ok.text, /OK   verify \(published JWKS\)/);

    const bad = path.join(keyDir, `published-bad-${process.pid}.json`);
    const other = otherKey.publicKey.export({ format: 'jwk' });
    fs.writeFileSync(bad, JSON.stringify({ keys: [{ kty: 'RSA', n: other.n, e: other.e, kid: otherKey.thumbprint, alg: 'RS256', use: 'sig' }] }));
    const failed = await run([`--jwks=${bad}`], kmsEnv());
    assert.equal(failed.code, 1);
    assert.match(failed.text, /FAIL published JWKS: .*not in the pinned list|FAIL published JWKS/);
    assert.match(failed.text, /FAIL verify \(published JWKS\)/);
  });

  it('exits 2 on configuration or KMS errors', async () => {
    assert.equal((await run([], kmsEnv({ DDC_AUTH_KMS_KEY_VERSION_ID: '' }))).code, 2);
    const denied = await run([], kmsEnv(), mockKms({ keys: {} }));
    assert.equal(denied.code, 2);
    assert.match(denied.text, /FAIL GetPublicKey: .*Forbidden\.KeyNotFound/);
    assert.equal((await run(['--bogus'], kmsEnv())).code, 2);
  });
});
