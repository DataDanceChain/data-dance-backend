/**
 * Hardening G4 — Web3Auth signing-key pinning.
 *
 * The JWKS is fetched over the network when a token is verified, so a valid signature only proves
 * "signed by some key that URL served". The question this file answers: CAN A KEY THE OPERATOR
 * HAS NOT APPROVED VERIFY A LOGIN? Under WEB3AUTH_JWKS_PIN_MODE=enforce it must not — not under a
 * new kid, and not under the kid of the real key (a kid is only a label; the RFC 7638 thumbprint
 * is the key).
 *
 * Everything is local: generated keys, a loopback JWKS server whose answer each test chooses, the
 * login controller over mockPrisma. No network.
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

// Env first: the identity service asserts its config when the module is loaded.
Object.assign(process.env, {
  NODE_ENV: 'test',
  LOG_LEVEL: 'error',
  JWT_SECRET: 'test-jwt-secret-jwks-pin',
  JWT_EXPIRES_IN: '1h',
  WEB3AUTH_VERIFY_MODE: 'enforce',
  WEB3AUTH_CLIENT_ID: CLIENT_ID,
  WEB3AUTH_ALLOWED_VERIFIERS: `${ALLOWED_VERIFIER},external-wallet`,
  WEB3AUTH_LEGACY_VERIFIERS: '',
  WEB3AUTH_ALLOW_LEGACY_FALLBACK: 'false',
  WEB3AUTH_JWKS_PIN_MODE: 'log',
  WEB3AUTH_JWKS_PINNED_THUMBPRINTS: '',
});

const { installMockPrisma } = require('../helpers/mockPrisma');
const { listenLoopback } = require('../helpers/loopbackServer');

const prisma = installMockPrisma();

// Capture every log line the service and the controller write.
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

// ---------------------------------------------------------------------------
// Keys, a JWKS server whose answer each test sets, token minting
// ---------------------------------------------------------------------------

const keys = {};
const served = { social: [], external: [] };
let jwksServer;
let baseUrl;
let apiServer;

async function makeKey(kid) {
  const { publicKey, privateKey } = await jose.generateKeyPair('ES256');
  const jwk = { ...(await jose.exportJWK(publicKey)), kid, alg: 'ES256', use: 'sig' };
  return { kid, privateKey, jwk, thumbprint: await jose.calculateJwkThumbprint(jwk, 'sha256') };
}

before(async () => {
  keys.social = await makeKey('social-kid-1');
  keys.external = await makeKey('external-kid-1');
  keys.next = await makeKey('social-kid-2'); // what Web3Auth rotates to
  // The attacker's key, served UNDER THE REAL KID. Signature checks pass for it.
  keys.attacker = await makeKey('social-kid-1');

  jwksServer = http.createServer((req, res) => {
    const set = req.url === '/jwks' ? served.social : req.url === '/ext-jwks' ? served.external : null;
    if (!set) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ keys: set.map((k) => k.jwk) }));
  });
  await new Promise((resolve) => jwksServer.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${jwksServer.address().port}`;
  process.env.WEB3AUTH_JWKS_URL = `${baseUrl}/jwks`;
  process.env.WEB3AUTH_EXTERNAL_JWKS_URL = `${baseUrl}/ext-jwks`;

  const app = express();
  app.use(express.json());
  app.post('/api/auth/web3auth-login', web3authLogin);
  apiServer = await listenLoopback(app);
});

after(async () => {
  await new Promise((resolve) => jwksServer.close(resolve));
  await new Promise((resolve) => apiServer.close(resolve));
});

/**
 * Sets the pin configuration and what the JWKS endpoints answer, then drops the cached config and
 * the cached remote JWKS — the equivalent of a restart.
 */
function configure({ pinMode = 'log', pins = [], social = [keys.social], external = [keys.external] } = {}) {
  process.env.WEB3AUTH_JWKS_PIN_MODE = pinMode;
  process.env.WEB3AUTH_JWKS_PINNED_THUMBPRINTS = pins.map((k) => (typeof k === 'string' ? k : k.thumbprint)).join(',');
  served.social = social;
  served.external = external;
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

async function mint(claims, { key = keys.social, iss = SOCIAL_ISS, kid, exp = '1h' } = {}) {
  return new jose.SignJWT(claims)
    .setProtectedHeader({ alg: 'ES256', kid: kid || key.kid })
    .setIssuer(iss)
    .setAudience(CLIENT_ID)
    .setIssuedAt()
    .setExpirationTime(exp)
    .sign(key.privateKey);
}

const mintExternal = (key = keys.external) =>
  mint({ wallets: [{ address: '0x00000000000000000000000000000000000000a1', type: 'ethereum' }] }, { key, iss: EXTERNAL_ISS });

async function expectCode(promise, code) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof Web3AuthIdentityError, `expected ${code}, got ${err && err.stack}`);
    assert.equal(err.code, code, `expected ${code}, got ${err.code}: ${err.message}`);
    assert.equal(err.httpStatus, 401);
    return true;
  });
}

const pinLogs = () => logs.filter((l) => l.message === 'jwks_key_not_pinned');

/** The token — or any of its three segments — must never reach a log line. */
function assertTokenNotLogged(token) {
  const dump = JSON.stringify(logs);
  for (const segment of token.split('.')) assert.equal(dump.includes(segment), false, 'a token segment was logged');
}

beforeEach(() => {
  logs.length = 0;
  prisma.reset();
  configure();
});

// ---------------------------------------------------------------------------
// log
// ---------------------------------------------------------------------------

describe('WEB3AUTH_JWKS_PIN_MODE=log', () => {
  it('warns jwks_key_not_pinned with kid, thumbprint and JWKS URL — and still accepts the token', async () => {
    configure({ pinMode: 'log', pins: [keys.external] });
    const token = await mint(socialClaims());
    const { kind, payload } = await verifyIdToken(token);
    assert.equal(kind, 'social');
    assert.equal(payload.verifierId, 'alice@example.com');

    const [line, ...rest] = pinLogs();
    assert.ok(line, 'an unpinned key must be reported in log mode');
    assert.equal(rest.length, 0);
    assert.equal(line.level, 'warn');
    assert.equal(line.meta.kid, 'social-kid-1');
    assert.equal(line.meta.thumbprint, keys.social.thumbprint);
    assert.equal(line.meta.jwksUrl, `${baseUrl}/jwks`);
    assert.equal(line.meta.outcome, 'accepted_log_mode');
    assertTokenNotLogged(token);
  });

  it('warns for every token while the pin list is still empty (the rollout default)', async () => {
    configure({ pinMode: 'log', pins: [] });
    await verifyIdToken(await mint(socialClaims()));
    await verifyIdToken(await mintExternal());
    assert.deepEqual(
      pinLogs().map((l) => [l.meta.thumbprint, l.meta.jwksUrl]),
      [
        [keys.social.thumbprint, `${baseUrl}/jwks`],
        [keys.external.thumbprint, `${baseUrl}/ext-jwks`],
      ]
    );
  });

  it('is silent for a pinned key', async () => {
    configure({ pinMode: 'log', pins: [keys.social] });
    await verifyIdToken(await mint(socialClaims()));
    assert.equal(pinLogs().length, 0);
  });
});

// ---------------------------------------------------------------------------
// enforce
// ---------------------------------------------------------------------------

describe('WEB3AUTH_JWKS_PIN_MODE=enforce', () => {
  it('rejects an unpinned but otherwise valid key: 401 IDTOKEN_KEY_NOT_PINNED, logged at error level', async () => {
    const token = await mint(socialClaims());
    // The token itself is fine: with pinning off it verifies.
    configure({ pinMode: 'off', pins: [keys.external] });
    await verifyIdToken(token);

    configure({ pinMode: 'enforce', pins: [keys.external] });
    await expectCode(verifyIdToken(token), 'IDTOKEN_KEY_NOT_PINNED');
    const [line] = pinLogs();
    assert.equal(line.level, 'error');
    assert.equal(line.meta.kid, 'social-kid-1');
    assert.equal(line.meta.thumbprint, keys.social.thumbprint);
    assert.equal(line.meta.jwksUrl, `${baseUrl}/jwks`);
    assert.equal(line.meta.outcome, 'refused');
    assertTokenNotLogged(token);
  });

  it('accepts a pinned key — one list covers the social and the external-wallet JWKS', async () => {
    configure({ pinMode: 'enforce', pins: [keys.social, keys.external] });
    assert.equal((await verifyIdToken(await mint(socialClaims()))).kind, 'social');
    assert.equal((await verifyIdToken(await mintExternal())).kind, 'external');
    assert.equal(pinLogs().length, 0);
  });

  it('checks the external-wallet JWKS as well', async () => {
    configure({ pinMode: 'enforce', pins: [keys.social] });
    await expectCode(verifyIdToken(await mintExternal()), 'IDTOKEN_KEY_NOT_PINNED');
    assert.equal(pinLogs()[0].meta.jwksUrl, `${baseUrl}/ext-jwks`);
    assert.equal(pinLogs()[0].meta.thumbprint, keys.external.thumbprint);
  });

  it('rejects the kid-reuse attack: the JWKS serves a different key under the pinned kid', async () => {
    // Whoever controls the JWKS response swaps the key behind `social-kid-1` for their own.
    const forged = await mint(socialClaims({ verifierId: 'victim@example.com' }), { key: keys.attacker });
    assert.equal(jose.decodeProtectedHeader(forged).kid, keys.social.kid, 'same kid as the pinned key');

    // Without pinning the forgery is a valid login — this is the hole.
    configure({ pinMode: 'off', pins: [keys.social], social: [keys.attacker] });
    assert.equal((await verifyIdToken(forged)).payload.verifierId, 'victim@example.com');

    configure({ pinMode: 'enforce', pins: [keys.social], social: [keys.attacker] });
    await expectCode(verifyIdToken(forged), 'IDTOKEN_KEY_NOT_PINNED');
    const [line] = pinLogs();
    assert.equal(line.meta.kid, 'social-kid-1', 'the kid is the pinned key’s label …');
    assert.equal(line.meta.thumbprint, keys.attacker.thumbprint, '… the thumbprint is the attacker’s key');
    assert.notEqual(line.meta.thumbprint, keys.social.thumbprint);
  });

  it('rotation: a new key is refused with a log line naming it; pinning it and restarting accepts it', async () => {
    // Web3Auth starts signing with a new key and publishes it next to the old one.
    configure({ pinMode: 'enforce', pins: [keys.social], social: [keys.social, keys.next] });
    const afterRotation = await mint(socialClaims(), { key: keys.next });
    await expectCode(verifyIdToken(afterRotation), 'IDTOKEN_KEY_NOT_PINNED');
    assert.equal(pinLogs()[0].meta.thumbprint, keys.next.thumbprint, 'the operator reads the new pin off this line');
    assert.equal(pinLogs()[0].meta.kid, 'social-kid-2');

    // Operator verifies the key, adds the pin, restarts.
    configure({ pinMode: 'enforce', pins: [keys.social, keys.next], social: [keys.social, keys.next] });
    await verifyIdToken(afterRotation);
    await verifyIdToken(await mint(socialClaims())); // the current key still works (current + next pinned)
  });

  it('runs only after full verification: every other failure keeps its own code', async () => {
    configure({ pinMode: 'enforce', pins: [keys.social], social: [keys.social, keys.next] });
    const stranger = await makeKey('stranger-kid');
    // Not in the JWKS at all → still a signature failure.
    await expectCode(verifyIdToken(await mint(socialClaims(), { key: stranger })), 'IDTOKEN_SIGNATURE');
    // Served but unpinned AND expired → expired: the pin check never sees a token that failed.
    const expired = await mint(socialClaims(), { key: keys.next, exp: Math.floor(Date.now() / 1000) - 3600 });
    await expectCode(verifyIdToken(expired), 'IDTOKEN_EXPIRED');
    assert.equal(pinLogs().length, 0);
  });

  it('keeps failing closed with a non-identity error (→ 5xx) when the JWKS is unreachable', async () => {
    const closed = http.createServer();
    await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const deadUrl = `http://127.0.0.1:${closed.address().port}/jwks`;
    await new Promise((resolve) => closed.close(resolve));

    const saved = process.env.WEB3AUTH_JWKS_URL;
    try {
      for (const pinMode of ['off', 'log', 'enforce']) {
        process.env.WEB3AUTH_JWKS_URL = deadUrl;
        configure({ pinMode, pins: [keys.social] });
        await assert.rejects(verifyIdToken(await mint(socialClaims())), (err) => {
          assert.equal(err instanceof Web3AuthIdentityError, false, `${pinMode}: ${err.code}`);
          return true;
        });
      }
    } finally {
      process.env.WEB3AUTH_JWKS_URL = saved;
    }
  });
});

describe('WEB3AUTH_JWKS_PIN_MODE=off', () => {
  it('does not look at the key at all', async () => {
    configure({ pinMode: 'off', pins: [] });
    await verifyIdToken(await mint(socialClaims()));
    assert.equal(pinLogs().length, 0);
  });
});

// ---------------------------------------------------------------------------
// POST /api/auth/web3auth-login — same 401 path and body shape as the other IDTOKEN_* codes
// ---------------------------------------------------------------------------

describe('POST /api/auth/web3auth-login with pinning', () => {
  const linkedRow = () => ({
    id: 'alice-1',
    email: 'alice@example.com',
    name: 'Alice',
    avatar: null,
    xid: null,
    walletAddress: null,
    authType: 'web3auth',
    userType: 'regular',
    isOrganization: false,
    web3authVerifier: ALLOWED_VERIFIER,
    web3authVerifierId: 'alice@example.com',
    web3authLinkedAt: new Date(),
    disabledAt: null,
    referralCode: 'ALICE1',
  });
  const post = (body) => request(apiServer).post('/api/auth/web3auth-login').send(body);

  it('enforce: 401 IDTOKEN_KEY_NOT_PINNED in the same shape as IDTOKEN_SIGNATURE, no session', async () => {
    prisma.user.rows.push(linkedRow());
    configure({ pinMode: 'enforce', pins: [keys.external] });

    const unpinned = await post({ idToken: await mint(socialClaims()) });
    assert.equal(unpinned.status, 401);
    assert.deepEqual(unpinned.body, {
      status: 'fail',
      code: 'IDTOKEN_KEY_NOT_PINNED',
      message: 'ID token was signed with a key DataDance has not approved',
    });

    const badSignature = await post({ idToken: await mint(socialClaims(), { key: await makeKey('x') }) });
    assert.equal(badSignature.status, 401);
    assert.deepEqual(Object.keys(unpinned.body).sort(), Object.keys(badSignature.body).sort());

    const rejected = logs.filter((l) => l.message === 'idtoken_rejected').map((l) => l.meta.code);
    assert.deepEqual(rejected, ['IDTOKEN_KEY_NOT_PINNED', 'IDTOKEN_SIGNATURE']);
    assert.equal(logs.some((l) => l.message === 'web3auth_login'), false, 'no session was minted');
  });

  it('enforce: a pinned key logs the user in', async () => {
    prisma.user.rows.push(linkedRow());
    configure({ pinMode: 'enforce', pins: [keys.social] });
    const res = await post({ idToken: await mint(socialClaims()) });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.user.id, 'alice-1');
  });

  it('log: an unpinned key still logs the user in, with the warning', async () => {
    prisma.user.rows.push(linkedRow());
    configure({ pinMode: 'log', pins: [] });
    const res = await post({ idToken: await mint(socialClaims()) });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(pinLogs()[0].meta.thumbprint, keys.social.thumbprint);
  });
});

// ---------------------------------------------------------------------------
// Boot (web3authIdentity.assertBootConfig)
// ---------------------------------------------------------------------------

describe('boot: WEB3AUTH_JWKS_PIN_MODE / WEB3AUTH_JWKS_PINNED_THUMBPRINTS', () => {
  const env = (overrides = {}) => ({
    NODE_ENV: 'production',
    WEB3AUTH_VERIFY_MODE: 'enforce',
    WEB3AUTH_CLIENT_ID: CLIENT_ID,
    WEB3AUTH_ALLOWED_VERIFIERS: ALLOWED_VERIFIER,
    ...overrides,
  });
  const GOOD = 'NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs'; // RFC 7638 §3.1

  it('defaults to log with an empty list', () => {
    const cfg = _internals.assertBootConfig(env());
    assert.equal(cfg.pinMode, 'log');
    assert.deepEqual(cfg.pinnedThumbprints, []);
  });

  it('refuses an unknown mode', () => {
    assert.throws(() => _internals.assertBootConfig(env({ WEB3AUTH_JWKS_PIN_MODE: 'strict' })), /WEB3AUTH_JWKS_PIN_MODE must be one of off\|log\|enforce/);
  });

  it('refuses enforce with an empty pin list', () => {
    assert.throws(
      () => _internals.assertBootConfig(env({ WEB3AUTH_JWKS_PIN_MODE: 'enforce' })),
      /WEB3AUTH_JWKS_PINNED_THUMBPRINTS is required when WEB3AUTH_JWKS_PIN_MODE=enforce/
    );
    assert.equal(
      _internals.assertBootConfig(env({ WEB3AUTH_JWKS_PIN_MODE: 'enforce', WEB3AUTH_JWKS_PINNED_THUMBPRINTS: GOOD })).pinMode,
      'enforce'
    );
  });

  it('refuses a malformed pin by position, without echoing it', () => {
    const bad = [
      `${GOOD}=`, // padded
      GOOD.slice(1), // 42 chars
      GOOD.replace('-', '+'), // base64, not base64url
      'kid-2026-01', // a kid is not a pin
    ];
    for (const value of bad) {
      assert.throws(
        () => _internals.assertBootConfig(env({ WEB3AUTH_JWKS_PINNED_THUMBPRINTS: `${GOOD},${value}` })),
        (err) => {
          assert.match(err.message, /entry #2 is not an RFC 7638 SHA-256 JWK thumbprint/);
          assert.equal(err.message.includes(value), false, 'the rejected value is not echoed');
          return true;
        },
        value
      );
    }
  });
});

// ---------------------------------------------------------------------------
// scripts/web3authJwksThumbprints.js — where the operator reads the pins from
// ---------------------------------------------------------------------------

describe('scripts/web3authJwksThumbprints.js', () => {
  const path = require('node:path');
  const { execFile } = require('node:child_process');
  const script = require('../../scripts/web3authJwksThumbprints');
  const SCRIPT_PATH = path.join(__dirname, '../../scripts/web3authJwksThumbprints.js');

  // RFC 7638 §3.1 example key and its published SHA-256 thumbprint.
  const RFC7638_JWK = {
    kty: 'RSA',
    n:
      '0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAtVT86zwu1RK7aPFFxuhDR1L6tSoc_BJECP' +
      'ebWKRXjBZCiFV4n3oknjhMstn64tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6Cf0h4QyQ5v-65YGjQR0_FDW2QvzqY' +
      '368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvRL5hajrn1n91CbOpbISD08qNLyrdkt-bFTWhAI4vMQFh6WeZu0f' +
      'M4lFd2NcRwr3XPksINHaQ-G_xBniIqbw0Ls1jF44-csFCur-kEgU8awapJzKnqDKgw',
    e: 'AQAB',
    alg: 'RS256',
    kid: '2011-04-29',
  };
  const RFC7638_THUMBPRINT = 'NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs';

  let fixtureServer;
  let fixtureUrl;
  const fixtures = {};

  before(async () => {
    fixtures['/social'] = { keys: [RFC7638_JWK, keys.social.jwk] };
    fixtures['/ext'] = { keys: [keys.external.jwk] };
    fixtureServer = http.createServer((req, res) => {
      if (req.url === '/redirect') {
        res.writeHead(302, { location: '/social' });
        return res.end();
      }
      const body = fixtures[req.url];
      if (!body) {
        res.writeHead(404);
        return res.end();
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
    await new Promise((resolve) => fixtureServer.listen(0, '127.0.0.1', resolve));
    fixtureUrl = `http://127.0.0.1:${fixtureServer.address().port}`;
  });

  after(async () => {
    await new Promise((resolve) => fixtureServer.close(resolve));
  });

  function runScriptProcess(env) {
    return new Promise((resolve) => {
      execFile(process.execPath, [SCRIPT_PATH], { env: { PATH: process.env.PATH, ...env }, timeout: 20000 }, (error, stdout, stderr) =>
        resolve({ code: error ? error.code : 0, stdout, stderr })
      );
    });
  }

  async function runInProcess(env) {
    const out = [];
    const err = [];
    const code = await script.run({ env, out: (l) => out.push(l), err: (l) => err.push(l) });
    return { code, out, err };
  }

  it('falls back to the same JWKS URLs as the server', () => {
    assert.deepEqual(script.DEFAULT_JWKS_URLS, {
      WEB3AUTH_JWKS_URL: _internals.DEFAULTS.WEB3AUTH_JWKS_URL,
      WEB3AUTH_EXTERNAL_JWKS_URL: _internals.DEFAULTS.WEB3AUTH_EXTERNAL_JWKS_URL,
    });
    assert.deepEqual(
      script.jwksUrls({ WEB3AUTH_JWKS_URL: ' ', WEB3AUTH_EXTERNAL_JWKS_URL: 'https://x.example/jwks' }).map((u) => u.url),
      [_internals.DEFAULTS.WEB3AUTH_JWKS_URL, 'https://x.example/jwks']
    );
  });

  it('prints kid, alg, RFC 7638 thumbprint and source URL for every key of both sets (fixture JWKS)', async () => {
    const { code, stdout, stderr } = await runScriptProcess({
      WEB3AUTH_JWKS_URL: `${fixtureUrl}/social`,
      WEB3AUTH_EXTERNAL_JWKS_URL: `${fixtureUrl}/ext`,
    });
    assert.equal(code, 0, stderr);
    const lines = stdout.trim().split('\n');
    assert.deepEqual(lines.slice(0, 3), [
      `kid=2011-04-29 alg=RS256 thumbprint=${RFC7638_THUMBPRINT} jwks=${fixtureUrl}/social`,
      `kid=social-kid-1 alg=ES256 thumbprint=${keys.social.thumbprint} jwks=${fixtureUrl}/social`,
      `kid=external-kid-1 alg=ES256 thumbprint=${keys.external.thumbprint} jwks=${fixtureUrl}/ext`,
    ]);
    assert.equal(
      lines[lines.length - 1],
      `# WEB3AUTH_JWKS_PINNED_THUMBPRINTS=${RFC7638_THUMBPRINT},${keys.social.thumbprint},${keys.external.thumbprint}`
    );
  });

  it('prints exactly the thumbprint the server checks: its output, pinned, passes enforce', async () => {
    configure({ pinMode: 'enforce', pins: [keys.external] });
    const { code, out } = await runInProcess({
      WEB3AUTH_JWKS_URL: `${baseUrl}/jwks`,
      WEB3AUTH_EXTERNAL_JWKS_URL: `${baseUrl}/ext-jwks`,
    });
    assert.equal(code, 0);
    const pins = out.filter((l) => l.startsWith('kid=')).map((l) => /thumbprint=(\S+)/.exec(l)[1]);
    assert.equal(pins.length, 2);

    process.env.WEB3AUTH_JWKS_PINNED_THUMBPRINTS = pins.join(',');
    _internals.resetConfig();
    await verifyIdToken(await mint(socialClaims()));
    await verifyIdToken(await mintExternal());
    assert.equal(pinLogs().length, 0);
  });

  it('reports an unreadable JWKS on stderr with exit 1 and still prints the other set', async () => {
    const { code, out, err } = await runInProcess({
      WEB3AUTH_JWKS_URL: `${fixtureUrl}/missing`,
      WEB3AUTH_EXTERNAL_JWKS_URL: `${fixtureUrl}/ext`,
    });
    assert.equal(code, 1);
    assert.match(err[0], /WEB3AUTH_JWKS_URL: could not read .*\/missing: HTTP 404/);
    assert.equal(out.filter((l) => l.startsWith('kid=')).length, 1);
  });

  it('does not follow redirects (neither does the server)', async () => {
    const { code, err } = await runInProcess({
      WEB3AUTH_JWKS_URL: `${fixtureUrl}/redirect`,
      WEB3AUTH_EXTERNAL_JWKS_URL: `${fixtureUrl}/ext`,
    });
    assert.equal(code, 1);
    assert.match(err[0], /HTTP 302/);
  });
});
