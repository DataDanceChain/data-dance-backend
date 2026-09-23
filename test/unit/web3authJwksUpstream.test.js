/**
 * When Web3Auth's key service is unusable, the user and the operator must be told "the identity
 * provider is unavailable" — 503 IDTOKEN_UPSTREAM_UNAVAILABLE — never "your token is invalid".
 *
 * Every way the key set can fail to arrive is covered against a local JWKS server: timeout (no
 * answer, and headers-then-silence), non-200 (500, 404, a redirect, which is not followed), junk
 * (HTML, empty, JSON that is not a key set) and a refused connection. Genuine token problems keep
 * their own codes. Nothing logs in while the key set is unavailable. No network.
 */
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const request = require('supertest');
const jose = require('jose');

const CLIENT_ID = 'test-web3auth-client-id';
const SOCIAL_ISS = 'https://api-auth.web3auth.io';
const EXTERNAL_ISS = 'https://authjs.web3auth.io';
const ALLOWED_VERIFIER = 'web3auth-google-sapphire-devnet';

Object.assign(process.env, {
  NODE_ENV: 'test',
  LOG_LEVEL: 'error',
  JWT_SECRET: 'test-jwt-secret-jwks-upstream',
  JWT_EXPIRES_IN: '1h',
  WEB3AUTH_VERIFY_MODE: 'enforce',
  WEB3AUTH_CLIENT_ID: CLIENT_ID,
  WEB3AUTH_ALLOWED_VERIFIERS: `${ALLOWED_VERIFIER},external-wallet`,
  WEB3AUTH_LEGACY_VERIFIERS: '',
  WEB3AUTH_ALLOW_LEGACY_FALLBACK: 'false',
  WEB3AUTH_JWKS_PIN_MODE: 'off',
  WEB3AUTH_JWKS_PINNED_THUMBPRINTS: '',
});

const { installMockPrisma } = require('../helpers/mockPrisma');
const { listenLoopback } = require('../helpers/loopbackServer');

const prisma = installMockPrisma();

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

const identityService = require('../../src/services/web3authIdentity');
const { web3authLogin } = require('../../src/controllers/web3AuthController');

const { verifyIdToken, Web3AuthIdentityError, _internals } = identityService;

// Short enough to keep the suite fast, long enough that a healthy loopback answer never trips it.
const TEST_TIMEOUT_MS = 300;

// Every read of the user table, so "refused before any lookup" can be asserted.
let userLookups = 0;
for (const op of ['findUnique', 'findFirst', 'findMany']) {
  const original = prisma.user[op];
  prisma.user[op] = async (args) => {
    userLookups += 1;
    return original(args);
  };
}

// ---------------------------------------------------------------------------
// A JWKS server with one path per failure mode
// ---------------------------------------------------------------------------

const keys = {};
let jwksServer;
let baseUrl;
let deadUrl; // nothing listens there: connection refused
let apiServer;

async function makeKey(kid) {
  const { publicKey, privateKey } = await jose.generateKeyPair('ES256', { extractable: true });
  const jwk = { ...(await jose.exportJWK(publicKey)), kid, alg: 'ES256', use: 'sig' };
  return { kid, privateKey, jwk, thumbprint: await jose.calculateJwkThumbprint(jwk, 'sha256') };
}

const ROUTES = {
  '/ok': (res) => json(res, 200, { keys: [keys.social.jwk] }),
  '/ext-ok': (res) => json(res, 200, { keys: [keys.external.jwk] }),
  '/other-key': (res) => json(res, 200, { keys: [keys.other.jwk] }),
  '/hang': () => {}, // accepts, never answers
  '/hang-body': (res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"keys":['); // headers and half a body, then silence
  },
  '/500': (res) => json(res, 500, { error: 'internal' }),
  '/404': (res) => json(res, 404, { error: 'not found' }),
  '/302': (res) => {
    res.writeHead(302, { location: '/ok' });
    res.end();
  },
  '/html': (res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><body>Cloudflare: 502 Bad Gateway</body></html>');
  },
  '/empty': (res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('');
  },
  '/not-a-jwks': (res) => json(res, 200, { hello: 'world' }),
  '/private-key': (res) => json(res, 200, { keys: [keys.socialPrivateJwk] }),
  '/flaky': (res) => (flakyUp ? json(res, 200, { keys: [keys.social.jwk] }) : json(res, 500, {})),
};
let flakyUp = true;

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

before(async () => {
  keys.social = await makeKey('social-kid-1');
  keys.external = await makeKey('external-kid-1');
  keys.other = await makeKey('social-kid-1'); // same kid, different key
  keys.socialPrivateJwk = { ...(await jose.exportJWK(keys.social.privateKey)), kid: 'social-kid-1', alg: 'ES256' };

  jwksServer = http.createServer((req, res) => {
    const route = ROUTES[req.url];
    if (!route) return json(res, 404, {});
    return route(res);
  });
  await new Promise((resolve) => jwksServer.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${jwksServer.address().port}`;

  const closed = http.createServer();
  await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve));
  deadUrl = `http://127.0.0.1:${closed.address().port}/jwks`;
  await new Promise((resolve) => closed.close(resolve));

  _internals.setJwksTimeoutMs(TEST_TIMEOUT_MS);

  const app = express();
  app.use(express.json());
  app.post('/api/auth/web3auth-login', web3authLogin);
  apiServer = await listenLoopback(app);
});

after(async () => {
  _internals.setJwksTimeoutMs();
  jwksServer.closeAllConnections(); // the /hang sockets
  await new Promise((resolve) => jwksServer.close(resolve));
  await new Promise((resolve) => apiServer.close(resolve));
});

/** Point the social (and optionally the external) JWKS at a path and "restart". */
function serve(socialPath, { externalPath = '/ext-ok', pinMode = 'off', pins = [] } = {}) {
  process.env.WEB3AUTH_JWKS_URL = socialPath === 'dead' ? deadUrl : `${baseUrl}${socialPath}`;
  process.env.WEB3AUTH_EXTERNAL_JWKS_URL = externalPath === 'dead' ? deadUrl : `${baseUrl}${externalPath}`;
  process.env.WEB3AUTH_JWKS_PIN_MODE = pinMode;
  process.env.WEB3AUTH_JWKS_PINNED_THUMBPRINTS = pins.join(',');
  _internals.resetConfig();
}

const socialClaims = (overrides = {}) => ({
  email: 'alice@example.com',
  email_verified: true,
  aggregateVerifier: ALLOWED_VERIFIER,
  verifierId: 'alice@example.com',
  wallets: [],
  ...overrides,
});

async function mint(claims, { key = keys.social, iss = SOCIAL_ISS, aud = CLIENT_ID, exp = '1h' } = {}) {
  return new jose.SignJWT(claims)
    .setProtectedHeader({ alg: 'ES256', kid: key.kid })
    .setIssuer(iss)
    .setAudience(aud)
    .setIssuedAt()
    .setExpirationTime(exp)
    .sign(key.privateKey);
}

const upstreamLogs = () => logs.filter((l) => l.message === 'idtoken_upstream_unavailable');

async function expectUpstream(promise, reason, jwksUrl) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof Web3AuthIdentityError, `expected IDTOKEN_UPSTREAM_UNAVAILABLE, got ${err && err.stack}`);
    assert.equal(err.code, 'IDTOKEN_UPSTREAM_UNAVAILABLE', `${err.code}: ${err.message}`);
    assert.equal(err.httpStatus, 503);
    assert.equal(err.details.reason, reason);
    assert.doesNotMatch(err.message, /token/i, 'the message must not blame the token');
    return true;
  });
  const lines = upstreamLogs();
  assert.equal(lines.length, 1, JSON.stringify(logs));
  assert.equal(lines[0].level, 'error');
  assert.equal(lines[0].meta.jwksUrl, jwksUrl);
  assert.equal(lines[0].meta.reason, reason);
}

async function expectCode(promise, code) {
  await assert.rejects(promise, (err) => {
    assert.equal(err.code, code, `expected ${code}, got ${err.code}: ${err.message}`);
    assert.equal(err.httpStatus, 401);
    return true;
  });
  assert.equal(upstreamLogs().length, 0, 'a token problem is not an upstream outage');
}

function assertTokenNotLogged(token) {
  const dump = JSON.stringify(logs);
  for (const segment of token.split('.')) assert.equal(dump.includes(segment), false, 'a token segment was logged');
}

beforeEach(() => {
  logs.length = 0;
  userLookups = 0;
  prisma.reset();
  serve('/ok');
});

// ---------------------------------------------------------------------------
// The key set cannot be obtained → 503, whatever the token looks like
// ---------------------------------------------------------------------------

describe('JWKS unusable → IDTOKEN_UPSTREAM_UNAVAILABLE (503)', () => {
  it('timeout: the JWKS never answers (jose JWKSTimeout)', async () => {
    serve('/hang');
    const token = await mint(socialClaims());
    await expectUpstream(verifyIdToken(token), 'timeout', `${baseUrl}/hang`);
    assertTokenNotLogged(token);
  });

  it('timeout: headers arrive, then the body stalls', async () => {
    serve('/hang-body');
    await expectUpstream(verifyIdToken(await mint(socialClaims())), 'timeout', `${baseUrl}/hang-body`);
  });

  for (const [path, status] of [['/500', 500], ['/404', 404], ['/302', 302]]) {
    it(`non-200: HTTP ${status}${status === 302 ? ' (redirects are not followed)' : ''}`, async () => {
      serve(path);
      const token = await mint(socialClaims());
      await expectUpstream(verifyIdToken(token), 'http_status', `${baseUrl}${path}`);
      assert.equal(upstreamLogs()[0].meta.upstreamStatus, status);
      assertTokenNotLogged(token);
    });
  }

  it('junk: an HTML error page with 200', async () => {
    serve('/html');
    await expectUpstream(verifyIdToken(await mint(socialClaims())), 'invalid_json', `${baseUrl}/html`);
  });

  it('junk: an empty 200 body', async () => {
    serve('/empty');
    await expectUpstream(verifyIdToken(await mint(socialClaims())), 'invalid_json', `${baseUrl}/empty`);
  });

  it('junk: JSON that is not a key set (jose JWKSInvalid)', async () => {
    serve('/not-a-jwks');
    await expectUpstream(verifyIdToken(await mint(socialClaims())), 'invalid_jwks', `${baseUrl}/not-a-jwks`);
  });

  it('junk: a key set that publishes a private key (jose JWKSInvalid)', async () => {
    serve('/private-key');
    await expectUpstream(verifyIdToken(await mint(socialClaims())), 'invalid_jwks', `${baseUrl}/private-key`);
  });

  it('connection refused (was an untyped error → 500 before)', async () => {
    serve('dead');
    await expectUpstream(verifyIdToken(await mint(socialClaims())), 'network', deadUrl);
  });

  it('applies to the external-wallet JWKS as well', async () => {
    serve('/ok', { externalPath: '/500' });
    const token = await mint(
      { wallets: [{ address: '0x00000000000000000000000000000000000000a1', type: 'ethereum' }] },
      { key: keys.external, iss: EXTERNAL_ISS }
    );
    await expectUpstream(verifyIdToken(token), 'http_status', `${baseUrl}/500`);
  });

  it('holds in every pin mode — the pin check never runs without a key', async () => {
    for (const pinMode of ['off', 'log', 'enforce']) {
      logs.length = 0;
      serve('/500', { pinMode, pins: [keys.social.thumbprint] });
      await expectUpstream(verifyIdToken(await mint(socialClaims())), 'http_status', `${baseUrl}/500`);
      assert.equal(logs.some((l) => l.message === 'jwks_key_not_pinned'), false, pinMode);
    }
  });

  it('a key set fetched successfully is reused (jose cache, 10 min): a shorter outage does not stop logins', async () => {
    flakyUp = true;
    serve('/flaky');
    const token = await mint(socialClaims());
    await verifyIdToken(token);
    flakyUp = false;
    try {
      assert.equal((await verifyIdToken(token)).kind, 'social', 'served from the cached key set');
      assert.equal(upstreamLogs().length, 0);
      // A restart drops the cache: now the outage is visible.
      _internals.resetConfig();
      await expectUpstream(verifyIdToken(token), 'http_status', `${baseUrl}/flaky`);
    } finally {
      flakyUp = true;
    }
  });

  it('is not remembered: the next login after the outage fetches again and succeeds, no restart', async () => {
    flakyUp = false;
    serve('/flaky');
    const token = await mint(socialClaims());
    try {
      await expectUpstream(verifyIdToken(token), 'http_status', `${baseUrl}/flaky`);
      flakyUp = true; // only the upstream recovers — same process, same key-set object, no reset
      assert.equal((await verifyIdToken(token)).kind, 'social');
    } finally {
      flakyUp = true;
    }
  });
});

// ---------------------------------------------------------------------------
// Genuine token problems keep their codes (key set fetched fine)
// ---------------------------------------------------------------------------

describe('a readable key set: token problems keep their own 401 codes', () => {
  it('bad signature: same kid, key not in the set', async () => {
    serve('/other-key');
    await expectCode(verifyIdToken(await mint(socialClaims())), 'IDTOKEN_SIGNATURE');
  });

  it('no matching key in a successfully fetched set', async () => {
    serve('/ok');
    const stranger = await makeKey('stranger-kid');
    await expectCode(verifyIdToken(await mint(socialClaims(), { key: stranger })), 'IDTOKEN_SIGNATURE');
  });

  it('wrong issuer, wrong audience, expired', async () => {
    await expectCode(verifyIdToken(await mint(socialClaims(), { iss: 'https://evil.example' })), 'IDTOKEN_ISSUER');
    await expectCode(verifyIdToken(await mint(socialClaims(), { aud: 'another-project' })), 'IDTOKEN_AUDIENCE');
    const expired = await mint(socialClaims(), { exp: Math.floor(Date.now() / 1000) - 3600 });
    await expectCode(verifyIdToken(expired), 'IDTOKEN_EXPIRED');
  });

  it('G4: an unpinned key under enforce is still IDTOKEN_KEY_NOT_PINNED', async () => {
    serve('/ok', { pinMode: 'enforce', pins: [keys.external.thumbprint] });
    await expectCode(verifyIdToken(await mint(socialClaims())), 'IDTOKEN_KEY_NOT_PINNED');
  });

  it('a malformed token is still IDTOKEN_INVALID, before any fetch', async () => {
    serve('dead');
    await assert.rejects(verifyIdToken('not.a.jwt'), (err) => err.code === 'IDTOKEN_INVALID');
    assert.equal(upstreamLogs().length, 0);
  });
});

// ---------------------------------------------------------------------------
// POST /api/auth/web3auth-login
// ---------------------------------------------------------------------------

describe('POST /api/auth/web3auth-login while the key set is unavailable', () => {
  const post = (body) => request(apiServer).post('/api/auth/web3auth-login').send(body);

  for (const [label, path] of [['500', '/500'], ['junk', '/html'], ['connection refused', 'dead'], ['timeout', '/hang']]) {
    it(`${label}: 503 IDTOKEN_UPSTREAM_UNAVAILABLE in the IDTOKEN_* shape, no lookup, no session`, async () => {
      serve(path);
      const res = await post({ idToken: await mint(socialClaims()) });
      assert.equal(res.status, 503, JSON.stringify(res.body));
      assert.deepEqual(res.body, {
        status: 'fail',
        code: 'IDTOKEN_UPSTREAM_UNAVAILABLE',
        message: 'The identity provider (Web3Auth) is temporarily unavailable. Please try again shortly.',
      });
      assert.equal(res.body.data, undefined, 'no session');
      assert.equal(userLookups, 0, 'nothing is looked up without a verified token');
      assert.equal(logs.some((l) => l.message === 'web3auth_login'), false);
      assert.equal(logs.some((l) => l.message === 'Web3Auth login error'), false, 'not the generic 500 path');
      assert.equal(upstreamLogs()[0].level, 'error');
    });
  }

  it('the same shape as a 401 token rejection', async () => {
    serve('/500');
    const outage = await post({ idToken: await mint(socialClaims()) });
    serve('/other-key');
    const rejected = await post({ idToken: await mint(socialClaims()) });
    assert.equal(rejected.status, 401);
    assert.deepEqual(Object.keys(outage.body).sort(), Object.keys(rejected.body).sort());
  });
});
