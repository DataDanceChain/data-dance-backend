/**
 * The DDC issuer (design §2.4, §3.2, F1/F11/F13): the Web3Auth custom JWT's exact header and
 * claims, the signer interface (file signer for local/test only, KMS stub refusing to start),
 * the published JWKS (pinned keys only, public members only), and logging without `sub` or the
 * token.
 */
const { describe, it, beforeEach, afterEach } = require('node:test');
const fs = require('fs');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const express = require('express');
const request = require('supertest');
const { listenLoopback } = require('../helpers/loopbackServer');
const winston = require('winston');

process.env.LOG_LEVEL = 'info';

const { makeKeyFile, makeJwksFile, localEnv } = require('../helpers/nativeAuthKeys');
const config = require('../../src/services/nativeAuth/config');
const issuer = require('../../src/services/nativeAuth/issuer');
const { createSigner, getSigner, resetSignerCache } = require('../../src/services/nativeAuth/signer');
const { createKmsSigner } = require('../../src/services/nativeAuth/signer/kmsSigner');

const key = makeKeyFile();
const next = makeKeyFile();
const SUBJECT = '00000000-0000-4000-8000-000000000000';

function cfgFor(overrides = {}) {
  return config.readNativeAuthConfig(localEnv(key, overrides));
}

function decode(token) {
  const [h, p, s] = token.split('.');
  return { header: JSON.parse(Buffer.from(h, 'base64url')), payload: JSON.parse(Buffer.from(p, 'base64url')), signingInput: `${h}.${p}`, signature: Buffer.from(s, 'base64url') };
}

function verifies(token, publicJwk) {
  const { signingInput, signature } = decode(token);
  return crypto.verify('sha256', Buffer.from(signingInput), crypto.createPublicKey({ key: publicJwk, format: 'jwk' }), signature);
}

/** Capture what the nativeAuth logger emits (after redaction), without touching stdout. */
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

/** Pretend `thumbprint` is a leaked key for one call (the committed key's private half is not ours to use). */
function withLeakedThumbprint(thumbprint, fn) {
  const set = config.leakedKeys().thumbprints;
  set.add(thumbprint);
  try {
    return fn();
  } finally {
    set.delete(thumbprint);
  }
}

describe('mintW3aJwt', () => {
  it('mints RS256 with kid = RFC 7638 thumbprint and exactly the contract claims', async () => {
    const now = Date.UTC(2026, 8, 30, 9, 0, 0, 500);
    const minted = await issuer.mintW3aJwt({ subject: SUBJECT, cfg: cfgFor(), now });
    const { header, payload } = decode(minted.idToken);
    assert.deepEqual(header, { alg: 'RS256', typ: 'JWT', kid: key.thumbprint });
    const iat = Math.floor(now / 1000) - 2;
    assert.deepEqual(Object.keys(payload).sort(), ['aud', 'exp', 'iat', 'iss', 'jti', 'sub', 'user_id']);
    assert.equal(payload.iss, 'ddc-auth-devnet');
    assert.equal(payload.aud, 'ddc-w3a-devnet');
    assert.equal(payload.sub, SUBJECT);
    assert.equal(payload.user_id, SUBJECT);
    assert.equal(payload.iat, iat, 'iat = now - 2');
    assert.equal(payload.exp, iat + 60, 'exp = iat + 60');
    assert.match(payload.jti, /^[0-9a-f-]{36}$/);
    assert.equal(minted.jti, payload.jti);
    assert.equal(minted.kid, key.thumbprint);
    assert.equal(minted.expiresAt, new Date((iat + 60) * 1000).toISOString());
    assert.ok(verifies(minted.idToken, key.publicJwk), 'signature verifies with the published public key');
    assert.ok(!('nbf' in payload) && !('email' in payload));
  });

  it('verifies with jose against the published JWKS (what the Web3Auth nodes do)', async () => {
    const jose = await import('jose');
    const cfg = cfgFor();
    const { idToken } = await issuer.mintW3aJwt({ subject: SUBJECT, cfg });
    const jwks = jose.createLocalJWKSet(issuer.buildPublicJwks(cfg));
    const { payload, protectedHeader } = await jose.jwtVerify(idToken, jwks, { issuer: 'ddc-auth-devnet', audience: 'ddc-w3a-devnet', algorithms: ['RS256'] });
    assert.equal(payload.sub, SUBJECT);
    assert.equal(protectedHeader.kid, key.thumbprint);
  });

  it('honours a shorter TTL and gives each token its own jti', async () => {
    const cfg = cfgFor({ DDC_AUTH_JWT_TTL_SEC: '45' });
    const a = await issuer.mintW3aJwt({ subject: SUBJECT, cfg });
    const b = await issuer.mintW3aJwt({ subject: SUBJECT, cfg });
    assert.equal(decode(a.idToken).payload.exp - decode(a.idToken).payload.iat, 45);
    assert.notEqual(a.jti, b.jti);
  });

  it('refuses while disabled, without a subject, or with an unpinned key', async () => {
    await assert.rejects(issuer.mintW3aJwt({ subject: SUBJECT, cfg: cfgFor({ DDC_AUTH_ENABLED: 'false' }) }), /disabled/);
    await assert.rejects(issuer.mintW3aJwt({ subject: '', cfg: cfgFor() }), /w3aSubject is required/);
    await assert.rejects(issuer.mintW3aJwt({ subject: SUBJECT, cfg: cfgFor({ DDC_AUTH_JWKS_PINNED: next.thumbprint }) }), /not listed in DDC_AUTH_JWKS_PINNED/);
  });

  it('refuses the leaked key by thumbprint at mint, even when pinned and the boot check was bypassed', async () => {
    await withLeakedThumbprint(key.thumbprint, () =>
      assert.rejects(issuer.mintW3aJwt({ subject: SUBJECT, cfg: cfgFor() }), /publicly leaked key auth-key-1/));
    // and by the auth-key-1 kid inside the file
    const byKid = makeKeyFile({ kid: 'auth-key-1' });
    await assert.rejects(issuer.mintW3aJwt({ subject: SUBJECT, cfg: config.readNativeAuthConfig(localEnv(byKid)) }), /leaked key auth-key-1/);
  });

  it('refuses at mint a key file that is group/other readable, lacks alg, or whose public half does not match', async () => {
    const loose = makeKeyFile({ mode: 0o640 });
    await assert.rejects(issuer.mintW3aJwt({ subject: SUBJECT, cfg: config.readNativeAuthConfig(localEnv(loose)) }), /owner only/);
    const noAlg = makeKeyFile({ alg: null });
    await assert.rejects(issuer.mintW3aJwt({ subject: SUBJECT, cfg: config.readNativeAuthConfig(localEnv(noAlg)) }), /alg must be RS256/);
    const donor = makeKeyFile();
    const swapped = makeKeyFile({ extra: { n: donor.publicJwk.n } });
    await assert.rejects(
      issuer.mintW3aJwt({ subject: SUBJECT, cfg: config.readNativeAuthConfig(localEnv(swapped, { DDC_AUTH_JWKS_PINNED: donor.thumbprint })) }),
      /cannot be loaded|do not match the private key/,
    );
  });

  it('issueW3aToken logs loginRef, kid, jti, exp, count — never sub, never the token', async () => {
    const capture = captureLogs();
    try {
      const minted = await issuer.issueW3aToken({ subject: SUBJECT, loginRef: '0123456789abcdef', count: 2, cfg: cfgFor() });
      const line = capture.lines.find((l) => l.includes('native_auth.w3a_jwt_issued'));
      assert.ok(line, 'w3a_jwt_issued was not logged');
      const entry = JSON.parse(line);
      assert.equal(entry.loginRef, '0123456789abcdef');
      assert.equal(entry.kid, key.thumbprint);
      assert.equal(entry.jti, minted.jti);
      assert.equal(entry.exp, minted.exp);
      assert.equal(entry.count, 2);
      assert.ok(!line.includes(SUBJECT), 'sub leaked into the log');
      assert.ok(!line.includes(minted.idToken.split('.')[1]), 'token leaked into the log');
    } finally {
      capture.stop();
    }
  });
});

describe('signers', () => {
  it('file signer exposes only public members and refuses a foreign kid or another alg', async () => {
    const signer = createSigner(cfgFor());
    assert.equal(signer.kind, 'file');
    assert.equal(signer.kid, key.thumbprint);
    assert.deepEqual(Object.keys(signer.publicJwk()).sort(), ['e', 'kty', 'n']);
    await assert.rejects(signer.sign({ alg: 'HS256' }, {}), /RS256 only/);
    await assert.rejects(signer.sign({ alg: 'RS256', kid: next.thumbprint }, {}), /does not name this key/);
  });

  it('the file signer is refused outside local/test even if boot were bypassed', () => {
    assert.throws(() => createSigner(cfgFor({ DDC_AUTH_ENV: 'prod' })), /local\|test/);
    assert.throws(() => createSigner(cfgFor({ DDC_AUTH_ENV: '' })), /local\|test/);
  });

  it('the KMS signer is an interface stub that refuses to start', () => {
    assert.throws(() => createKmsSigner({ kmsKeyId: 'k' }), /not implemented in v1/);
    assert.throws(() => createSigner(cfgFor({ DDC_AUTH_SIGNER: 'kms', DDC_AUTH_KMS_KEY_ID: 'k' })), /not implemented in v1/);
  });

  it('getSigner caches per configuration', () => {
    const a = getSigner(cfgFor());
    assert.equal(getSigner(cfgFor()), a);
    const other = makeKeyFile();
    const b = getSigner(config.readNativeAuthConfig(localEnv(other)));
    assert.notEqual(b, a);
    assert.equal(b.kid, other.thumbprint);
  });
});

describe('published JWKS', () => {
  it('contains the active key and pinned extra keys, public members kty,n,e,kid,alg,use only', () => {
    const extraFile = makeJwksFile([next.publicJwk, key.publicJwk]);
    const jwks = issuer.buildPublicJwks(cfgFor({ DDC_AUTH_JWKS_EXTRA_FILE: extraFile, DDC_AUTH_JWKS_PINNED: `${key.thumbprint},${next.thumbprint}` }));
    assert.deepEqual(jwks.keys.map((k) => k.kid), [key.thumbprint, next.thumbprint], 'deduplicated, active first');
    for (const k of jwks.keys) {
      assert.deepEqual(Object.keys(k).sort(), ['alg', 'e', 'kid', 'kty', 'n', 'use']);
      assert.equal(k.alg, 'RS256');
      assert.equal(k.use, 'sig');
      assert.equal(config.rsaThumbprint(k), k.kid, 'kid is the thumbprint of the published members');
    }
  });

  it('is null with no key configured, and refuses an unpinned extra key or prod extra file', () => {
    assert.equal(issuer.buildPublicJwks(config.readNativeAuthConfig({})), null);
    const extraFile = makeJwksFile([next.publicJwk]);
    assert.throws(() => issuer.buildPublicJwks(cfgFor({ DDC_AUTH_JWKS_EXTRA_FILE: extraFile })), /not listed in DDC_AUTH_JWKS_PINNED/);
    assert.throws(() => issuer.buildPublicJwks(cfgFor({ DDC_AUTH_ENV: 'prod', DDC_AUTH_JWKS_EXTRA_FILE: extraFile })), /refused in production/);
  });

  it('never publishes the leaked auth-key-1, even if pinned', () => {
    const leaked = makeKeyFile({ kid: 'auth-key-1' });
    assert.throws(() => issuer.buildPublicJwks(config.readNativeAuthConfig(localEnv(leaked))), /leaked key auth-key-1/);
    withLeakedThumbprint(key.thumbprint, () =>
      assert.throws(() => issuer.buildPublicJwks(cfgFor()), /leaked key auth-key-1/));
    const extraFile = makeJwksFile([next.publicJwk]);
    withLeakedThumbprint(next.thumbprint, () =>
      assert.throws(() => issuer.buildPublicJwks(cfgFor({ DDC_AUTH_JWKS_EXTRA_FILE: extraFile, DDC_AUTH_JWKS_PINNED: `${key.thumbprint},${next.thumbprint}` })), /leaked key auth-key-1/));
  });

  it('publishes a file key only with DDC_AUTH_ENV=local|test, whatever the master switch says', () => {
    for (const env of [undefined, '', 'prod', 'staging']) {
      for (const enabled of ['true', 'false', undefined]) {
        assert.throws(
          () => issuer.buildPublicJwks(cfgFor({ DDC_AUTH_ENV: env, DDC_AUTH_ENABLED: enabled })),
          /published only with DDC_AUTH_ENV=local\|test/,
          `env=${env} enabled=${enabled}`,
        );
      }
    }
    assert.equal(issuer.buildPublicJwks(cfgFor({ DDC_AUTH_ENV: 'test', DDC_AUTH_ENABLED: 'false' })).keys.length, 1);
  });

  it('refuses a group/other-readable key file at JWKS time too', () => {
    const loose = makeKeyFile({ mode: 0o644 });
    assert.throws(() => issuer.buildPublicJwks(config.readNativeAuthConfig(localEnv(loose))), /owner only/);
  });

  describe('GET /.well-known/ddc-auth/jwks.json handler', () => {
    const saved = {};
    const setEnv = (vars) => {
      for (const [k, v] of Object.entries(vars)) {
        if (!(k in saved)) saved[k] = process.env[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    };
    afterEach(() => {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
        delete saved[k];
      }
    });

    const servers = [];
    afterEach(async () => {
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

    it('falls through when no key is configured (the default)', async () => {
      setEnv({ DDC_AUTH_ENABLED: undefined, DDC_AUTH_SIGNING_KEY_FILE: undefined, DDC_AUTH_JWKS_EXTRA_FILE: undefined, DDC_AUTH_KMS_KEY_ID: undefined });
      const res = await request(await app()).get('/.well-known/ddc-auth/jwks.json');
      assert.equal(res.status, 404);
      assert.equal(res.text, 'fell through');
    });

    it('serves the pinned key with the flag OFF once a key is configured, cacheable for 5 minutes', async () => {
      setEnv({ ...localEnv(key), DDC_AUTH_ENABLED: 'false' });
      const res = await request(await app()).get('/.well-known/ddc-auth/jwks.json');
      assert.equal(res.status, 200);
      assert.equal(res.headers['cache-control'], 'public, max-age=300');
      assert.deepEqual(res.body.keys.map((k) => k.kid), [key.thumbprint]);
      assert.ok(!JSON.stringify(res.body).includes('"d"'));
    });

    it('falls through (and logs, without key material) when the configured key is refused', async () => {
      setEnv({ ...localEnv(key), DDC_AUTH_JWKS_PINNED: next.thumbprint });
      const capture = captureLogs();
      try {
        const res = await request(await app()).get('/.well-known/ddc-auth/jwks.json');
        assert.equal(res.status, 404);
        assert.ok(capture.lines.some((l) => l.includes('native_auth.jwks_refused')));
        assert.ok(!capture.lines.join('').includes(key.publicJwk.n.slice(0, 32)));
      } finally {
        capture.stop();
      }
    });

    it('caches the published set and the refusal per configuration, re-checking after JWKS_RECHECK_MS', () => {
      const cfg = cfgFor();
      const t0 = 1_000_000;
      const first = issuer.cachedPublicJwks(cfg, t0);
      assert.deepEqual(first.jwks.keys.map((k) => k.kid), [key.thumbprint]);
      // Within the window the cached answer stands even if the file changes (no re-read per request).
      const loose = makeKeyFile();
      const looseCfg = config.readNativeAuthConfig(localEnv(loose));
      assert.ok(issuer.cachedPublicJwks(looseCfg, t0).jwks);
      fs.chmodSync(loose.file, 0o644);
      assert.ok(issuer.cachedPublicJwks(looseCfg, t0 + 1000).jwks, 'served from the cache');
      resetSignerCache();
      const later = issuer.cachedPublicJwks(looseCfg, t0 + issuer.JWKS_RECHECK_MS + 1000);
      assert.match(later.problem, /owner only/);
      assert.equal(issuer.cachedPublicJwks(looseCfg, t0 + issuer.JWKS_RECHECK_MS + 2000), later, 'refusal cached');
      // A different configuration is never answered from another's cache entry.
      assert.deepEqual(issuer.cachedPublicJwks(cfg, t0 + issuer.JWKS_RECHECK_MS + 2000).jwks.keys.map((k) => k.kid), [key.thumbprint]);
    });

    it('does not publish a file key when DDC_AUTH_ENV is not local|test', async () => {
      setEnv({ ...localEnv(key), DDC_AUTH_ENV: undefined, DDC_AUTH_ENABLED: undefined });
      const res = await request(await app()).get('/.well-known/ddc-auth/jwks.json');
      assert.equal(res.status, 404);
    });
  });
});
