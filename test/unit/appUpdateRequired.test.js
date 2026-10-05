/**
 * POST /api/auth/web3auth-login: old App builds after the network switch (426 APP_UPDATE_REQUIRED).
 *
 * The store Apps built for the devnet Web3Auth project send a devnet idToken (iOS 2.0.2,
 * Android 1.0.2) or none at all (iOS 2.0.1). After the cut those logins are refused, with
 * IDTOKEN_AUDIENCE and IDTOKEN_REQUIRED respectively, and the Apps show "sign in again" or a
 * technical message. WEB3AUTH_RETIRED_CLIENT_IDS and LOGIN_MISSING_IDTOKEN_MEANS_OLD_APP turn exactly
 * those two refusals into "please update the App".
 *
 * The question this file answers: does the refusal reach the user as "please update" WITHOUT the
 * change ever touching a login that is not already refused? No session, no database call, nothing
 * from the token in the log, every other answer unchanged.
 *
 * Local JWKS + `jose` as in web3authLogin.test.js; no database (test/helpers/mockPrisma).
 */
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const express = require('express');
const request = require('supertest');
const jose = require('jose');
const jwt = require('jsonwebtoken');
const { Wallet } = require('ethers');

const MAINNET_ID = 'mainnet-client-id-under-test';
const RETIRED_ID = 'retired-devnet-client-id-under-test';
const SOCIAL_ISS = 'https://api-auth.web3auth.io';
const EXTERNAL_ISS = 'https://authjs.web3auth.io';
const VERIFIER = 'web3auth-google-sapphire-mainnet';
const DEVNET_VERIFIER = 'web3auth-google-sapphire-devnet';
const IOS_URL = 'https://apps.apple.com/app/id1000000001';
const ANDROID_URL = 'https://downloads.example.test/datadance-9.9.9.apk';

// Env first: the identity service asserts its config when the module is loaded. These are the
// values at the cut (enforce, no legacy fallback); configure() below changes them per test.
Object.assign(process.env, {
  NODE_ENV: 'test',
  LOG_LEVEL: 'error',
  JWT_SECRET: 'test-jwt-secret-app-update-required',
  JWT_EXPIRES_IN: '1h',
  WEB3AUTH_VERIFY_MODE: 'enforce',
  WEB3AUTH_CLIENT_ID: MAINNET_ID,
  WEB3AUTH_ALLOWED_VERIFIERS: `${VERIFIER},external-wallet`,
  WEB3AUTH_LEGACY_VERIFIERS: '',
  WEB3AUTH_ALLOW_LEGACY_FALLBACK: 'false',
  WEB3AUTH_RETIRED_CLIENT_IDS: '',
  LOGIN_MISSING_IDTOKEN_MEANS_OLD_APP: 'off',
});

const { installMockPrisma } = require('../helpers/mockPrisma');

const prisma = installMockPrisma();

// Every call into the database, by model and operation: "no DB call" is asserted on this list.
const dbCalls = [];
for (const [name, model] of Object.entries(prisma)) {
  if (!model || typeof model !== 'object' || !Array.isArray(model.rows)) continue;
  for (const [op, fn] of Object.entries(model)) {
    if (typeof fn !== 'function') continue;
    model[op] = async (...args) => {
      dbCalls.push(`${name}.${op}`);
      return fn(...args);
    };
  }
}
for (const op of ['$transaction', '$executeRaw']) {
  const fn = prisma[op].bind(prisma);
  prisma[op] = async (...args) => {
    dbCalls.push(op);
    return fn(...args);
  };
}

// A new user's invite code is allocated with $queryRaw, which the mock cannot run; the creation
// path is otherwise the real one. Replaced before the controller takes it at load.
const referralUtils = require('../../src/utils/referralUtils');
referralUtils.generateUniqueReferralCode = async () => 'NEW001';

// Every session minted. The controller takes generateToken when it is loaded, so wrap it first.
const jwtUtils = require('../../src/utils/jwtUtils');
const realGenerateToken = jwtUtils.generateToken;
let sessionsIssued = 0;
jwtUtils.generateToken = (...args) => {
  sessionsIssued += 1;
  return realGenerateToken(...args);
};

// Every log line, so "nothing from the token is logged" can be asserted.
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
const versionPolicy = require('../../src/constants/appVersionPolicy');
const { web3authLogin } = require('../../src/controllers/web3AuthController');

const app = express();
app.use(express.json());
app.post('/api/auth/web3auth-login', web3authLogin);

// ---------------------------------------------------------------------------
// Local JWKS + token minting
// ---------------------------------------------------------------------------

const keys = {};
let server;

async function makeKey(kid) {
  const { publicKey, privateKey } = await jose.generateKeyPair('ES256');
  const jwk = await jose.exportJWK(publicKey);
  return { kid, privateKey, jwk: { ...jwk, kid, alg: 'ES256', use: 'sig' } };
}

before(async () => {
  keys.social = await makeKey('social-kid-1');
  keys.external = await makeKey('external-kid-1');
  keys.rogue = await makeKey('rogue-kid'); // never served
  server = http.createServer((req, res) => {
    const served = { '/jwks': keys.social, '/jwks-external': keys.external }[req.url];
    if (!served) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ keys: [served.jwk] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  process.env.WEB3AUTH_JWKS_URL = `${base}/jwks`;
  process.env.WEB3AUTH_EXTERNAL_JWKS_URL = `${base}/jwks-external`;
  identityService._internals.resetConfig();
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

const nowSec = () => Math.floor(Date.now() / 1000);

async function mint(claims, { key = keys.social, iss = SOCIAL_ISS, aud = MAINNET_ID, iat = nowSec(), exp = nowSec() + 3600 } = {}) {
  return new jose.SignJWT(claims)
    .setProtectedHeader({ alg: 'ES256', kid: key.kid })
    .setIssuer(iss)
    .setAudience(aud)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(key.privateKey);
}

/** What an old devnet build's Google login carries (the connection name is devnet's too). */
const devnetClaims = (overrides = {}) => ({
  email: 'ada@example.com',
  name: 'Ada',
  aggregateVerifier: DEVNET_VERIFIER,
  verifierId: 'ada@example.com',
  wallets: [],
  ...overrides,
});

/** A current (mainnet) Google login. */
const mainnetClaims = (overrides = {}) => ({
  email: 'ada@example.com',
  email_verified: true,
  name: 'Ada',
  aggregateVerifier: VERIFIER,
  verifierId: 'ada@example.com',
  wallets: [],
  ...overrides,
});

/** Signed by the served key with the right issuer, but issued to the retired (devnet) project. */
const retiredToken = (overrides = {}, opts = {}) => mint(devnetClaims(overrides), { aud: RETIRED_ID, ...opts });

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

const ADA_WALLET = '0xAbC0000000000000000000000000000000000001';

/** Ada's account, already linked to the mainnet Google connection. */
const adaRow = () => ({
  id: 'ada-1',
  email: 'ada@example.com',
  name: 'Ada',
  avatar: null,
  xid: '123456',
  xUsername: 'ada',
  walletAddress: null,
  authType: 'web3auth',
  userType: 'regular',
  isOrganization: false,
  web3authVerifier: VERIFIER,
  web3authVerifierId: 'ada@example.com',
  web3authLinkedAt: new Date('2026-10-01T00:00:00Z'),
  disabledAt: null,
  referralCode: 'ADA001',
});

function configure({
  mode = 'enforce',
  fallback = false,
  retired = RETIRED_ID,
  missingMeansOldApp = 'on',
  links = { APP_STORE_URL_IOS: IOS_URL, APP_DOWNLOAD_URL_ANDROID: ANDROID_URL },
} = {}) {
  process.env.WEB3AUTH_VERIFY_MODE = mode;
  process.env.WEB3AUTH_ALLOW_LEGACY_FALLBACK = fallback ? 'true' : 'false';
  process.env.WEB3AUTH_RETIRED_CLIENT_IDS = retired;
  process.env.LOGIN_MISSING_IDTOKEN_MEANS_OLD_APP = missingMeansOldApp;
  identityService._internals.resetConfig();
  // The update links are the ones GET /api/app/version-policy serves (validated once, at boot).
  versionPolicy.initVersionPolicy({ env: links, log: { warn: () => {} } });
}

const SWITCHES_OFF = { retired: '', missingMeansOldApp: 'off' };

const post = (body) => request(app).post('/api/auth/web3auth-login').send(body);
const logged = (message) => logs.filter((l) => l.message === message);

/** Old store Apps send `message` straight to the screen; these words send them to /complete-profile instead. */
const COMPLETE_PROFILE_TRIGGERS = ['不完整', 'incomplete', '邮箱是必需的', 'email is required', 'Email and wallet address are required', 'new user registration'];

/** The 426 itself: shape, words, links, and nothing that could be a session. */
function assertAppUpdateRequired(res, { ios = IOS_URL, android = ANDROID_URL } = {}) {
  assert.equal(res.status, 426, JSON.stringify(res.body));
  assert.deepEqual(Object.keys(res.body).sort(), ['code', 'message', 'status', 'success', 'update']);
  assert.equal(res.body.status, 'fail');
  assert.equal(res.body.success, false);
  assert.equal(res.body.code, 'APP_UPDATE_REQUIRED');
  assert.deepEqual(res.body.update, { ios, android });
  const { message } = res.body;
  assert.match(message, /[一-鿿]/, 'the message has a Chinese part');
  assert.ok(message.includes('這個版本的 DataDance 已停止支援。請安裝最新版本，繼續使用你的帳戶。'), message);
  assert.doesNotMatch(message, /[请这个账续装户]/, 'the Chinese half is Traditional (zh-TW), as in the Apps');
  assert.ok(message.includes('This App version is no longer supported. Please update to the latest version.'), message);
  for (const word of COMPLETE_PROFILE_TRIGGERS) {
    assert.ok(!message.includes(word), `"${word}" would send an old App to /complete-profile instead of showing the message`);
  }
}

/** Refused before the database, and nothing minted. */
function assertNothingTouched(res) {
  assert.equal(res.body?.data, undefined, `a session was minted: ${JSON.stringify(res.body)}`);
  assert.equal(sessionsIssued, 0, 'generateToken ran');
  assert.deepEqual(dbCalls, [], 'the database was called');
  assert.equal(logged('legacy_login').length, 0, 'the legacy path ran');
}

/** No log line carries anything from the token (the token, its audience or its claims). */
function assertTokenNotLogged(...secrets) {
  const text = JSON.stringify(logs);
  for (const secret of secrets) assert.ok(!text.includes(secret), `logged: ${secret.slice(0, 24)}…`);
}

beforeEach(() => {
  prisma.reset();
  prisma.user.rows.push(adaRow());
  logs.length = 0;
  dbCalls.length = 0;
  sessionsIssued = 0;
  configure();
});

// ---------------------------------------------------------------------------
// (a) a token issued to a retired Web3Auth project
// ---------------------------------------------------------------------------

describe('a token for a retired client id (iOS 2.0.2 / Android 1.0.2 after the cut)', () => {
  for (const mode of ['enforce', 'log']) {
    it(`${mode}: 426 APP_UPDATE_REQUIRED, no session, no DB call, nothing from the token logged`, async () => {
      configure({ mode });
      const token = await retiredToken();
      const res = await post({
        idToken: token,
        walletAddress: ADA_WALLET,
        userInfo: { email: 'ada@example.com', name: 'Ada' },
        xid: '123456',
        loginType: 'web3auth',
      });
      assertAppUpdateRequired(res);
      assertNothingTouched(res);
      const [entry] = logged('idtoken_rejected');
      assert.deepEqual(entry.meta, { code: 'APP_UPDATE_REQUIRED', replaced: 'IDTOKEN_AUDIENCE', mode, outcome: 'refused' });
      assert.equal(logs.length, 1, JSON.stringify(logs));
      assertTokenNotLogged(token, RETIRED_ID, 'ada@example.com', DEVNET_VERIFIER, token.split('.')[1]);
      assert.equal(prisma.user.rows[0].web3authVerifier, VERIFIER, 'the account is untouched');
    });
  }

  it('also when the old token has expired (the audience is checked before the expiry)', async () => {
    const token = await retiredToken({}, { iat: nowSec() - 7200, exp: nowSec() - 3600 });
    const res = await post({ idToken: token });
    assertAppUpdateRequired(res);
    assertNothingTouched(res);
  });

  it('also for an external-wallet token of the retired project, and for an `aud` list naming it', async () => {
    const holder = Wallet.createRandom();
    const external = await mint(
      { wallets: [{ address: holder.address, type: 'ethereum' }] },
      { key: keys.external, iss: EXTERNAL_ISS, aud: RETIRED_ID }
    );
    assertAppUpdateRequired(await post({ idToken: external, walletAddress: holder.address }));

    const listed = await retiredToken({}, { aud: ['some-other-project', RETIRED_ID] });
    assertAppUpdateRequired(await post({ idToken: listed }));
    assertNothingTouched({ body: {} });
  });

  it('matches the csv entries exactly (whitespace around entries ignored, no prefix match)', async () => {
    configure({ retired: ` other-retired-id , ${RETIRED_ID} ` });
    assertAppUpdateRequired(await post({ idToken: await retiredToken() }));

    const prefix = await retiredToken({}, { aud: RETIRED_ID.slice(0, -1) });
    const res = await post({ idToken: prefix });
    assert.equal(res.status, 401);
    assert.equal(res.body.code, 'IDTOKEN_AUDIENCE');
  });

  it('keeps 401 IDTOKEN_AUDIENCE for a wrong audience that is not retired', async () => {
    const token = await mint(devnetClaims(), { aud: 'some-other-project' });
    const res = await post({ idToken: token });
    assert.equal(res.status, 401);
    assert.deepEqual(res.body, {
      status: 'fail',
      code: 'IDTOKEN_AUDIENCE',
      message: 'ID token audience does not match this project',
    });
    assertNothingTouched(res);
    assert.equal(logged('idtoken_rejected')[0].meta.code, 'IDTOKEN_AUDIENCE');
  });

  it('keeps 401 IDTOKEN_AUDIENCE for the retired project while WEB3AUTH_RETIRED_CLIENT_IDS is empty (the default)', async () => {
    configure({ retired: '' });
    const res = await post({ idToken: await retiredToken() });
    assert.equal(res.status, 401);
    assert.equal(res.body.code, 'IDTOKEN_AUDIENCE');
    assertNothingTouched(res);
  });

  it('never answers 426 for a retired audience that fails an earlier check (forged signature, unknown issuer)', async () => {
    const forged = await retiredToken({}, { key: keys.rogue });
    const a = await post({ idToken: forged });
    assert.equal(a.status, 401);
    assert.equal(a.body.code, 'IDTOKEN_SIGNATURE');

    const otherIssuer = await retiredToken({}, { iss: 'https://evil.example' });
    const b = await post({ idToken: otherIssuer });
    assert.equal(b.status, 401);
    assert.equal(b.body.code, 'IDTOKEN_ISSUER');
    assertNothingTouched(b);
  });
});

// ---------------------------------------------------------------------------
// (b) no idToken at all (iOS 2.0.1)
// ---------------------------------------------------------------------------

describe('a login with no idToken (iOS 2.0.1 after the cut)', () => {
  const body201 = {
    userInfo: { email: 'ada@example.com', name: 'Ada' },
    walletAddress: ADA_WALLET,
    loginType: 'web3auth',
  };

  for (const mode of ['enforce', 'log']) {
    it(`${mode}, LOGIN_MISSING_IDTOKEN_MEANS_OLD_APP=on: 426, no session, no DB call`, async () => {
      configure({ mode });
      const res = await post(body201);
      assertAppUpdateRequired(res);
      assertNothingTouched(res);
      assert.deepEqual(logged('idtoken_rejected')[0].meta, {
        code: 'APP_UPDATE_REQUIRED',
        replaced: 'IDTOKEN_REQUIRED',
        mode,
        outcome: 'refused',
      });
      assertTokenNotLogged('ada@example.com', ADA_WALLET);
    });
  }

  it('an empty, blank or non-string idToken counts as missing', async () => {
    for (const idToken of ['', '   ', 42, null, { aud: RETIRED_ID }]) {
      assertAppUpdateRequired(await post({ ...body201, idToken }));
    }
    assertNothingTouched({ body: {} });
  });

  it('LOGIN_MISSING_IDTOKEN_MEANS_OLD_APP=off (the default) keeps 400 IDTOKEN_REQUIRED, byte for byte', async () => {
    configure({ missingMeansOldApp: 'off' });
    const res = await post(body201);
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, {
      status: 'fail',
      code: 'IDTOKEN_REQUIRED',
      message: 'A Web3Auth ID token is required to log in',
    });
    assertNothingTouched(res);
    assert.equal(logged('idtoken_rejected')[0].meta.code, 'IDTOKEN_REQUIRED');
  });

  it('never refuses a login the server accepts today: log + legacy fallback, and verify mode off', async () => {
    configure({ mode: 'log', fallback: true });
    const legacy = await post(body201);
    assert.equal(legacy.status, 200, JSON.stringify(legacy.body));
    assert.equal(legacy.body.data.user.id, 'ada-1');
    assert.equal(logged('legacy_login')[0].meta.reason, 'legacy_fallback_allowed');

    configure({ mode: 'off' });
    const off = await post(body201);
    assert.equal(off.status, 200, JSON.stringify(off.body));
    assert.equal(logged('legacy_login').at(-1).meta.reason, 'verify_mode_off');
  });
});

// ---------------------------------------------------------------------------
// Everything else is unchanged
// ---------------------------------------------------------------------------

describe('with both switches on, every other login answers exactly as before', () => {
  /** Run the same request with the switches off and on; return both responses. */
  async function bothWays(makeBody) {
    configure(SWITCHES_OFF);
    prisma.reset();
    prisma.user.rows.push(adaRow());
    const off = await post(await makeBody());
    configure();
    prisma.reset();
    prisma.user.rows.push(adaRow());
    const on = await post(await makeBody());
    return { off, on };
  }

  it('a valid mainnet token logs its holder in (200, ver 2 session), the same with and without the switches', async () => {
    const { off, on } = await bothWays(async () => ({ idToken: await mint(mainnetClaims()) }));
    for (const res of [off, on]) {
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.status, 'success');
      assert.equal(res.body.data.user.id, 'ada-1');
      assert.equal(jwt.decode(res.body.data.token).ver, 2);
    }
    assert.deepEqual(Object.keys(on.body.data).sort(), Object.keys(off.body.data).sort());
    assert.equal(logged('idtoken_rejected').length, 0);
  });

  it('a valid token whose `aud` list also names a retired id is still a valid token', async () => {
    const res = await post({ idToken: await mint(mainnetClaims(), { aud: [MAINNET_ID, RETIRED_ID] }) });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.user.id, 'ada-1');
  });

  it('a new mainnet user is still created (201)', async () => {
    const newcomer = () => mint(mainnetClaims({ email: 'new@example.com', verifierId: 'new@example.com', name: 'New' }));
    const { off, on } = await bothWays(async () => ({ idToken: await newcomer() }));
    for (const res of [off, on]) {
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.data.user.email, 'new@example.com');
    }
  });

  const refusals = {
    'IDTOKEN_SIGNATURE (forged)': () => mint(mainnetClaims(), { key: keys.rogue }),
    'IDTOKEN_ISSUER': () => mint(mainnetClaims(), { iss: 'https://evil.example' }),
    'IDTOKEN_EXPIRED': () => mint(mainnetClaims(), { iat: nowSec() - 7200, exp: nowSec() - 3600 }),
    'IDTOKEN_INVALID (malformed)': async () => 'not.a.jwt',
    'IDTOKEN_VERIFIER_NOT_ALLOWED': () => mint(mainnetClaims({ aggregateVerifier: 'connection-nobody-chose' })),
    'IDENTITY_CONFLICT': () => mint(mainnetClaims({ verifierId: 'someone-else|1' })),
  };
  for (const [name, makeToken] of Object.entries(refusals)) {
    it(`${name}: same status and body`, async () => {
      const { off, on } = await bothWays(async () => ({ idToken: await makeToken() }));
      assert.notEqual(on.status, 426);
      assert.ok(on.status >= 400, JSON.stringify(on.body));
      assert.equal(on.status, off.status);
      assert.deepEqual(on.body, off.body);
    });
  }

  it('WALLET_NOT_IN_TOKEN: same status and body', async () => {
    const { off, on } = await bothWays(async () => ({ idToken: await mint(mainnetClaims()), walletAddress: ADA_WALLET }));
    assert.equal(on.status, 401);
    assert.equal(on.body.code, 'WALLET_NOT_IN_TOKEN');
    assert.deepEqual(on.body, off.body);
  });

  // The 426 replaces IDTOKEN_AUDIENCE and nothing else. A token can name a retired id and still pass
  // the audience check (an `aud` list that also holds the active id); whatever refuses it later keeps
  // its own answer, IDENTITY_CONFLICT included, which comes after the account lookup.
  const alsoRetired = { aud: [MAINNET_ID, RETIRED_ID] };
  const laterRefusals = {
    IDTOKEN_VERIFIER_NOT_ALLOWED: [401, () => mint(mainnetClaims({ aggregateVerifier: 'connection-nobody-chose' }), alsoRetired)],
    IDTOKEN_EXPIRED: [401, () => mint(mainnetClaims(), { ...alsoRetired, iat: nowSec() - 7200, exp: nowSec() - 3600 })],
    IDENTITY_CONFLICT: [409, () => mint(mainnetClaims({ verifierId: 'someone-else|1' }), alsoRetired)],
  };
  for (const [code, [status, makeToken]] of Object.entries(laterRefusals)) {
    it(`an \`aud\` list naming a retired id next to the active one keeps ${code} (${status}), never 426`, async () => {
      const { off, on } = await bothWays(async () => ({ idToken: await makeToken() }));
      assert.equal(on.status, status, JSON.stringify(on.body));
      assert.equal(on.body.code, code);
      assert.deepEqual(on.body, off.body);
    });
  }

  it('a retired-id token while the Web3Auth key set is unavailable keeps 503 IDTOKEN_UPSTREAM_UNAVAILABLE, never 426', async () => {
    const served = process.env.WEB3AUTH_JWKS_URL;
    process.env.WEB3AUTH_JWKS_URL = served.replace(/\/jwks$/, '/jwks-gone'); // the local JWKS answers 404 there
    try {
      const { off, on } = await bothWays(async () => ({ idToken: await retiredToken() }));
      assert.equal(on.status, 503, JSON.stringify(on.body));
      assert.equal(on.body.code, 'IDTOKEN_UPSTREAM_UNAVAILABLE');
      assert.deepEqual(on.body, off.body);
    } finally {
      process.env.WEB3AUTH_JWKS_URL = served;
      configure();
    }
  });
});

// ---------------------------------------------------------------------------
// The links, the unverified `aud` read, and the configuration
// ---------------------------------------------------------------------------

describe('the update links come from the environment', () => {
  it('APP_STORE_URL_IOS and APP_DOWNLOAD_URL_ANDROID, as GET /api/app/version-policy serves them', async () => {
    configure({ links: { APP_STORE_URL_IOS: 'https://apps.apple.com/app/id2000000002', APP_DOWNLOAD_URL_ANDROID: 'https://dl.example.test/a.apk' } });
    assertAppUpdateRequired(await post({ idToken: await retiredToken() }), {
      ios: 'https://apps.apple.com/app/id2000000002',
      android: 'https://dl.example.test/a.apk',
    });
    assertAppUpdateRequired(await post({}), {
      ios: 'https://apps.apple.com/app/id2000000002',
      android: 'https://dl.example.test/a.apk',
    });
  });

  it('unset: iOS falls back to the App Store listing, Android is null (the version-policy defaults)', async () => {
    configure({ links: {} });
    const res = await post({});
    assertAppUpdateRequired(res, { ios: versionPolicy.DEFAULT_IOS_STORE_URL, android: null });
  });

  it('the same body for both triggers', async () => {
    const a = await post({ idToken: await retiredToken() });
    const b = await post({});
    assert.equal(a.status, 426);
    assert.deepEqual(a.body, b.body);
  });
});

describe('isRetiredClientIdToken: the unverified `aud` read', () => {
  const b64 = (value) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
  const unsigned = (payload) => `${b64({ alg: 'ES256' })}.${b64(payload)}.c2ln`;

  it('never throws on a malformed token or a non-string, and calls none of them retired', () => {
    const junk = [
      undefined, null, 42, {}, [], '', ' ', 'abc', 'a.b', 'a.b.c', '...', 'a.b.c.d.e', '.x.', 'x..y',
      `${b64({})}.${b64('not json')}.x`, `${b64({})}.${b64('[1,2]')}.x`, `${b64({})}.${b64('"str"')}.x`,
      `${b64({})}.!!!!.x`, `${b64({})}.${'A'.repeat(100000)}.x`,
      unsigned({ aud: 7 }), unsigned({ aud: null }), unsigned({ aud: { id: RETIRED_ID } }), unsigned({ aud: [7, null] }),
      unsigned({ sub: RETIRED_ID }), unsigned({ aud: `${RETIRED_ID} ` }), unsigned({ aud: RETIRED_ID.toUpperCase() }),
    ];
    for (const token of junk) {
      assert.doesNotThrow(() => identityService.isRetiredClientIdToken(token), String(token).slice(0, 40));
      assert.equal(identityService.isRetiredClientIdToken(token), false, String(token).slice(0, 40));
    }
  });

  it('reads `aud` as a string or a list, and is false whenever the list is empty', () => {
    assert.equal(identityService.isRetiredClientIdToken(unsigned({ aud: RETIRED_ID })), true);
    assert.equal(identityService.isRetiredClientIdToken(`  ${unsigned({ aud: RETIRED_ID })}  `), true);
    assert.equal(identityService.isRetiredClientIdToken(unsigned({ aud: ['x', RETIRED_ID] })), true);
    assert.equal(identityService.isRetiredClientIdToken(unsigned({ aud: MAINNET_ID })), false);
    configure({ retired: '' });
    assert.equal(identityService.isRetiredClientIdToken(unsigned({ aud: RETIRED_ID })), false);
  });

  it('an unsigned token naming the retired id is still refused for its signature over HTTP, never 426', async () => {
    const res = await post({ idToken: unsigned({ iss: SOCIAL_ISS, aud: RETIRED_ID, iat: nowSec(), exp: nowSec() + 60 }) });
    assert.equal(res.status, 401);
    assert.equal(res.body.code, 'IDTOKEN_SIGNATURE');
    assertNothingTouched(res);
  });
});

describe('configuration', () => {
  const base = { WEB3AUTH_CLIENT_ID: 'c' };
  const { loadConfig, assertBootConfig } = identityService._internals;

  it('both are off by default', () => {
    const cfg = loadConfig(base);
    assert.deepEqual(cfg.retiredClientIds, []);
    assert.equal(cfg.missingIdTokenMeansOldApp, false);
  });

  it('WEB3AUTH_RETIRED_CLIENT_IDS is a csv; LOGIN_MISSING_IDTOKEN_MEANS_OLD_APP takes on / off in any case', () => {
    assert.deepEqual(loadConfig({ ...base, WEB3AUTH_RETIRED_CLIENT_IDS: ' a , b ,, ' }).retiredClientIds, ['a', 'b']);
    assert.equal(assertBootConfig({ ...base, LOGIN_MISSING_IDTOKEN_MEANS_OLD_APP: 'ON' }).missingIdTokenMeansOldApp, true);
    assert.equal(assertBootConfig({ ...base, LOGIN_MISSING_IDTOKEN_MEANS_OLD_APP: ' off ' }).missingIdTokenMeansOldApp, false);
  });

  it('refuses to boot on anything else, so a typo cannot read as a choice', () => {
    for (const value of ['true', 'false', 'yes', '1', '0', 'enabled']) {
      assert.throws(
        () => assertBootConfig({ ...base, LOGIN_MISSING_IDTOKEN_MEANS_OLD_APP: value }),
        /LOGIN_MISSING_IDTOKEN_MEANS_OLD_APP must be "on" or "off"/,
        value
      );
    }
  });

  describe('a retired id that is still an accepted audience', () => {
    const ACTIVE = 'BBpkxUTUr-active-client-id-under-test';
    const OLD = 'BGiGcxrX-retired-client-id-under-test';
    const prod = { NODE_ENV: 'production', WEB3AUTH_CLIENT_ID: ACTIVE };

    it('production: the boot refuses it when it equals WEB3AUTH_CLIENT_ID, naming the position only', () => {
      assert.throws(
        () => assertBootConfig({ ...prod, WEB3AUTH_RETIRED_CLIENT_IDS: `${OLD}, ${ACTIVE}` }),
        (err) =>
          /^WEB3AUTH_RETIRED_CLIENT_IDS is misconfigured: entry #2 equals WEB3AUTH_CLIENT_ID\. /.test(err.message) &&
          !err.message.includes(ACTIVE) &&
          !err.message.includes(OLD)
      );
    });

    it('production: the boot refuses it when it equals a WEB3AUTH_EXTERNAL_AUDIENCE entry', () => {
      assert.throws(
        () => assertBootConfig({ ...prod, WEB3AUTH_EXTERNAL_AUDIENCE: `${ACTIVE},${OLD}`, WEB3AUTH_RETIRED_CLIENT_IDS: OLD }),
        /^Error: WEB3AUTH_RETIRED_CLIENT_IDS is misconfigured: entry #1 equals a WEB3AUTH_EXTERNAL_AUDIENCE entry\. /
      );
    });

    it('production: distinct ids boot', () => {
      const cfg = assertBootConfig({ ...prod, WEB3AUTH_EXTERNAL_AUDIENCE: ACTIVE, WEB3AUTH_RETIRED_CLIENT_IDS: OLD });
      assert.deepEqual(cfg.retiredClientIds, [OLD]);
    });

    it('outside production the same overlap boots', () => {
      for (const NODE_ENV of [undefined, 'development', 'test']) {
        assert.doesNotThrow(() => assertBootConfig({ ...prod, NODE_ENV, WEB3AUTH_RETIRED_CLIENT_IDS: ACTIVE }), String(NODE_ENV));
      }
    });
  });

  it('one startup line: the retired-id count, the first 8 characters of each id, and the flag', () => {
    const line = identityService.describeOldAppSwitches(
      loadConfig({ ...base, WEB3AUTH_RETIRED_CLIENT_IDS: 'BGiGcxrXAdtx-43HZ-devnet, short', LOGIN_MISSING_IDTOKEN_MEANS_OLD_APP: 'ON' })
    );
    assert.equal(
      line,
      'Old App update answer (426 APP_UPDATE_REQUIRED): WEB3AUTH_RETIRED_CLIENT_IDS count=2 first8=BGiGcxrX,short LOGIN_MISSING_IDTOKEN_MEANS_OLD_APP=on'
    );
    assert.equal(
      identityService.describeOldAppSwitches(loadConfig(base)),
      'Old App update answer (426 APP_UPDATE_REQUIRED): WEB3AUTH_RETIRED_CLIENT_IDS count=0 first8=(none) LOGIN_MISSING_IDTOKEN_MEANS_OLD_APP=off'
    );
    // Without an argument it describes the configuration the server runs with.
    configure({ retired: `${RETIRED_ID},x`, missingMeansOldApp: 'off' });
    assert.match(identityService.describeOldAppSwitches(), / count=2 first8=retired-,x LOGIN_MISSING_IDTOKEN_MEANS_OLD_APP=off$/);
  });

  it('src/server.js prints that line at boot, once the environment is loaded', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/server.js'), 'utf8');
    const printAt = src.indexOf('console.log(describeOldAppSwitches());');
    assert.ok(printAt > -1, 'server.js must print describeOldAppSwitches()');
    assert.ok(src.indexOf('dotenv.config();') < printAt, 'after dotenv.config()');
  });
});
