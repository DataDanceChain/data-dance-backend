/**
 * POST /api/auth/web3auth-login — the dispatch between the verified and the legacy path.
 *
 * The question this file answers is a single one: CAN A REQUEST BODY ALONE MINT A SESSION?
 * It may only when WEB3AUTH_VERIFY_MODE=off (dev; refused at boot in production) or when the
 * operator has explicitly set WEB3AUTH_ALLOW_LEGACY_FALLBACK=true and the client sent no
 * `idToken` at all. A token that was sent and rejected is refused in every mode.
 *
 * Local JWKS + `jose` as in web3authIdentity.test.js; no database (test/helpers/mockPrisma).
 */
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const request = require('supertest');
const jose = require('jose');
const jwt = require('jsonwebtoken');
const { Wallet } = require('ethers');

const CLIENT_ID = 'test-web3auth-client-id';
const SOCIAL_ISS = 'https://api-auth.web3auth.io';
const ALLOWED_VERIFIER = 'web3auth-google-sapphire-devnet';

// Env first: the identity service asserts its config when the module is loaded.
Object.assign(process.env, {
  NODE_ENV: 'test',
  LOG_LEVEL: 'error',
  JWT_SECRET: 'test-jwt-secret-web3auth-login',
  JWT_EXPIRES_IN: '1h',
  WEB3AUTH_VERIFY_MODE: 'log',
  WEB3AUTH_CLIENT_ID: CLIENT_ID,
  WEB3AUTH_LEGACY_VERIFIERS: '',
  WEB3AUTH_ALLOW_LEGACY_FALLBACK: 'false',
  // The connections this deployment accepts as an identity source (item 2). Mandatory under
  // `enforce`; `configure()` below keeps it in step with the mode each test sets.
  WEB3AUTH_ALLOWED_VERIFIERS: ALLOWED_VERIFIER,
});

const { installMockPrisma } = require('../helpers/mockPrisma');

const prisma = installMockPrisma();

// Capture the audit lines the rollout is measured by (`legacy_login`, `idtoken_rejected`).
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

// Every read of the user table, so "refused before any lookup" can be asserted.
let userLookups = 0;
for (const op of ['findUnique', 'findFirst', 'findMany']) {
  const original = prisma.user[op];
  prisma.user[op] = async (args) => {
    userLookups += 1;
    return original(args);
  };
}

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
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
  keys.rogue = await makeKey('rogue-kid'); // never served
  server = http.createServer((req, res) => {
    if (req.url !== '/jwks') {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ keys: [keys.social.jwk] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.env.WEB3AUTH_JWKS_URL = `http://127.0.0.1:${server.address().port}/jwks`;
  identityService._internals.resetConfig();
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function mint(claims, { key = keys.social, iss = SOCIAL_ISS, aud = CLIENT_ID } = {}) {
  return new jose.SignJWT(claims)
    .setProtectedHeader({ alg: 'ES256', kid: key.kid })
    .setIssuer(iss)
    .setAudience(aud)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(key.privateKey);
}

/** A genuine token for this project whose e-mail claim the holder chose (the F03 threat). */
function claims(overrides = {}) {
  return {
    email: 'attacker@example.com',
    email_verified: true,
    name: 'Attacker',
    aggregateVerifier: ALLOWED_VERIFIER,
    verifierId: 'attacker@example.com',
    wallets: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VICTIM_EMAIL = 'victim@example.com';
const VICTIM_XID = '999888777';
const VICTIM_WALLET = '0xAbC0000000000000000000000000000000000001';

const victimRow = () => ({
  id: 'victim-1',
  email: VICTIM_EMAIL,
  name: 'Victim',
  avatar: null,
  xid: VICTIM_XID,
  xUsername: 'victim',
  walletAddress: null,
  authType: 'web3auth',
  userType: 'regular',
  isOrganization: false,
  web3authVerifier: null,
  web3authVerifierId: null,
  web3authLinkedAt: null,
  disabledAt: null,
  referralCode: 'VICTIM1',
});

function configure({ mode = 'log', fallback = false, legacyVerifiers = '', allowedVerifiers = ALLOWED_VERIFIER } = {}) {
  process.env.WEB3AUTH_VERIFY_MODE = mode;
  process.env.WEB3AUTH_ALLOW_LEGACY_FALLBACK = fallback ? 'true' : 'false';
  process.env.WEB3AUTH_LEGACY_VERIFIERS = legacyVerifiers;
  process.env.WEB3AUTH_ALLOWED_VERIFIERS = allowedVerifiers;
  identityService._internals.resetConfig();
}

const post = (body) => request(app).post('/api/auth/web3auth-login').send(body);
const victim = () => prisma.user.rows.find((r) => r.id === 'victim-1');
const logged = (message) => logs.filter((l) => l.message === message);

/** No token in the body, and the victim row untouched: nothing was minted, nothing was linked. */
function assertNoSession(res) {
  assert.equal(res.body?.data, undefined, `a session was minted: ${JSON.stringify(res.body)}`);
  assert.equal(victim().web3authVerifier, null, 'the victim row was linked');
  assert.equal(logged('legacy_login').length, 0, 'the legacy path ran');
}

beforeEach(() => {
  prisma.reset();
  logs.length = 0;
  userLookups = 0;
  prisma.user.rows.push(victimRow());
  configure();
});

// ---------------------------------------------------------------------------
// enforce
// ---------------------------------------------------------------------------

describe('enforce mode', () => {
  it('refuses a request with no idToken before it ever looks a user up', async () => {
    configure({ mode: 'enforce' });
    const res = await post({ userInfo: { email: VICTIM_EMAIL }, walletAddress: VICTIM_WALLET });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'IDTOKEN_REQUIRED');
    assertNoSession(res);
    assert.equal(userLookups, 0, 'the body must not even be used as a lookup key');
    assert.equal(logged('idtoken_rejected')[0].meta.outcome, 'refused');
  });

  it('refuses the {xid}-only takeover', async () => {
    configure({ mode: 'enforce' });
    const res = await post({ xid: VICTIM_XID });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'IDTOKEN_REQUIRED');
    assertNoSession(res);
    assert.equal(userLookups, 0);
  });

  it('ignores the fallback flag entirely', async () => {
    configure({ mode: 'enforce', fallback: true });
    const res = await post({ userInfo: { email: VICTIM_EMAIL } });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'IDTOKEN_REQUIRED');
    assertNoSession(res);
  });
});

// ---------------------------------------------------------------------------
// log, fallback off (the default)
// ---------------------------------------------------------------------------

describe('log mode with WEB3AUTH_ALLOW_LEGACY_FALLBACK=false', () => {
  it('refuses a request with no idToken (400 IDTOKEN_REQUIRED), no lookup, no session', async () => {
    const res = await post({ userInfo: { email: VICTIM_EMAIL }, walletAddress: VICTIM_WALLET });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'IDTOKEN_REQUIRED');
    assertNoSession(res);
    assert.equal(userLookups, 0);
  });

  it('refuses the {xid}-only and {userInfo.email}-only takeovers', async () => {
    const byXid = await post({ xid: VICTIM_XID });
    assert.equal(byXid.status, 400);
    assert.equal(byXid.body.code, 'IDTOKEN_REQUIRED');
    assertNoSession(byXid);

    const byEmail = await post({ userInfo: { email: VICTIM_EMAIL }, walletAddress: VICTIM_WALLET });
    assert.equal(byEmail.status, 400);
    assert.equal(byEmail.body.code, 'IDTOKEN_REQUIRED');
    assertNoSession(byEmail);
    assert.equal(userLookups, 0);
  });

  it('fails closed on a token with a bad signature — no legacy fallback, no session', async () => {
    const token = await mint(claims(), { key: keys.rogue });
    const res = await post({ idToken: token, userInfo: { email: VICTIM_EMAIL }, xid: VICTIM_XID });
    assert.equal(res.status, 401);
    assert.equal(res.body.code, 'IDTOKEN_SIGNATURE');
    assertNoSession(res);
    assert.equal(userLookups, 0, 'a rejected token must not reach the database at all');
    assert.equal(logged('idtoken_rejected')[0].meta.outcome, 'refused');
  });

  it('fails closed on a wrong issuer and on a wrong audience', async () => {
    const wrongIss = await mint(claims(), { iss: 'https://evil.example' });
    const a = await post({ idToken: wrongIss, xid: VICTIM_XID });
    assert.equal(a.status, 401);
    assert.equal(a.body.code, 'IDTOKEN_ISSUER');
    assertNoSession(a);

    const wrongAud = await mint(claims(), { aud: 'some-other-project' });
    const b = await post({ idToken: wrongAud, xid: VICTIM_XID });
    assert.equal(b.status, 401);
    assert.equal(b.body.code, 'IDTOKEN_AUDIENCE');
    assertNoSession(b);
  });

  it('fails closed when the claimed wallet is not the one the token proves', async () => {
    const holder = Wallet.createRandom();
    const token = await mint(
      claims({
        wallets: [
          {
            public_key: holder.signingKey.compressedPublicKey.slice(2),
            type: 'web3auth_app_key',
            curve: 'secp256k1',
          },
        ],
      })
    );
    const res = await post({ idToken: token, walletAddress: VICTIM_WALLET });
    assert.equal(res.status, 401);
    assert.equal(res.body.code, 'WALLET_NOT_IN_TOKEN');
    assertNoSession(res);
  });

  it('answers 409 and mints nothing when a verified token claims a legacy row by e-mail', async () => {
    // Genuine token for this project, attacker-chosen `email` claim: the C2 takeover.
    const token = await mint(claims({ email: VICTIM_EMAIL, verifierId: 'attacker|evil-id' }));
    const res = await post({ idToken: token });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'IDENTITY_CONFLICT');
    assertNoSession(res);
    assert.equal(logged('idtoken_rejected')[0].meta.outcome, 'refused');
  });

  it('still refuses an allow-listed verifier when the token does not say the e-mail is verified', async () => {
    configure({ legacyVerifiers: ALLOWED_VERIFIER });
    const token = await mint(claims({ email: VICTIM_EMAIL, email_verified: false, verifierId: 'attacker|evil-id' }));
    const res = await post({ idToken: token });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'IDENTITY_CONFLICT');
    assertNoSession(res);
  });

  it('links the legacy row only with the explicit opt-in AND a verified e-mail', async () => {
    configure({ legacyVerifiers: ALLOWED_VERIFIER });
    const token = await mint(claims({ email: VICTIM_EMAIL, email_verified: true, verifierId: VICTIM_EMAIL }));
    const res = await post({ idToken: token });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(victim().web3authVerifier, ALLOWED_VERIFIER);
    assert.equal(jwt.decode(res.body.data.token).ver, 2, 'a verified session carries ver: 2');
    assert.equal(logged('legacy_login').length, 0);
  });

  it('logs a verified holder of the pair in (the good path still works)', async () => {
    prisma.user.rows.push({
      ...victimRow(),
      id: 'linked-1',
      email: 'attacker@example.com',
      name: null,
      xid: null,
      referralCode: 'LINKED1',
      web3authVerifier: ALLOWED_VERIFIER,
      web3authVerifierId: 'attacker@example.com',
    });
    const res = await post({ idToken: await mint(claims()) });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.user.id, 'linked-1');
    assert.equal(jwt.decode(res.body.data.token).ver, 2);
    assert.equal(logged('web3auth_login')[0].meta.action, 'login');
    assert.equal(victim().web3authVerifier, null, 'the unrelated victim row is untouched');
  });
});

// ---------------------------------------------------------------------------
// log, fallback on — the one deliberate window
// ---------------------------------------------------------------------------

describe('log mode with WEB3AUTH_ALLOW_LEGACY_FALLBACK=true', () => {
  it('lets a request with no idToken use the legacy path and logs legacy_login with the reason', async () => {
    configure({ fallback: true });
    const res = await post({ userInfo: { email: VICTIM_EMAIL }, walletAddress: VICTIM_WALLET });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(res.body.data.token, 'the rollout window still mints a legacy session');
    assert.equal(jwt.decode(res.body.data.token).ver, undefined, 'a legacy session carries no ver');
    const [entry] = logged('legacy_login');
    assert.equal(entry.meta.mode, 'log');
    assert.equal(entry.meta.reason, 'legacy_fallback_allowed');
    assert.equal(entry.meta.hasEmail, true);
    assert.equal(entry.meta.hasWallet, true);
  });

  it('the flag re-opens the {xid}-only path too — which is why it defaults to false', async () => {
    configure({ fallback: true });
    const res = await post({ xid: VICTIM_XID });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.user.id, 'victim-1');
    assert.equal(logged('legacy_login')[0].meta.hasXid, true);
  });

  it('does NOT cover a token that was supplied and rejected', async () => {
    configure({ fallback: true });
    const token = await mint(claims({ email: VICTIM_EMAIL }), { key: keys.rogue });
    const res = await post({ idToken: token, userInfo: { email: VICTIM_EMAIL }, xid: VICTIM_XID });
    assert.equal(res.status, 401);
    assert.equal(res.body.code, 'IDTOKEN_SIGNATURE');
    assertNoSession(res);
  });

  it('does NOT cover a verified token whose identity conflicts', async () => {
    configure({ fallback: true });
    const token = await mint(claims({ email: VICTIM_EMAIL, verifierId: 'attacker|evil-id' }));
    const res = await post({ idToken: token, userInfo: { email: VICTIM_EMAIL } });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'IDENTITY_CONFLICT');
    assertNoSession(res);
  });
});

// ---------------------------------------------------------------------------
// off — local dev only
// ---------------------------------------------------------------------------

describe('off mode (dev only)', () => {
  it('keeps the legacy path for local development and logs it as verify_mode_off', async () => {
    configure({ mode: 'off' });
    const res = await post({ userInfo: { email: VICTIM_EMAIL } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(res.body.data.token);
    assert.equal(logged('legacy_login')[0].meta.reason, 'verify_mode_off');
  });

  it('is refused at boot in production, which is what keeps it dev-only', () => {
    assert.throws(
      () => identityService._internals.assertBootConfig({ NODE_ENV: 'production', WEB3AUTH_VERIFY_MODE: 'off' }),
      /not allowed when NODE_ENV=production/
    );
  });
});

// ---------------------------------------------------------------------------
// The flag itself
// ---------------------------------------------------------------------------

describe('WEB3AUTH_ALLOW_LEGACY_FALLBACK', () => {
  it('defaults to false and refuses anything that is not a plain true/false', () => {
    assert.equal(identityService._internals.loadConfig({ WEB3AUTH_CLIENT_ID: 'c' }).allowLegacyFallback, false);
    assert.equal(
      identityService._internals.loadConfig({ WEB3AUTH_CLIENT_ID: 'c', WEB3AUTH_ALLOW_LEGACY_FALLBACK: 'TRUE' })
        .allowLegacyFallback,
      true
    );
    assert.throws(
      () => identityService._internals.loadConfig({ WEB3AUTH_CLIENT_ID: 'c', WEB3AUTH_ALLOW_LEGACY_FALLBACK: 'yes' }),
      /must be "true" or "false"/
    );
  });
});

// ---------------------------------------------------------------------------
// The connection allow-list, over HTTP (item 2)
// ---------------------------------------------------------------------------

/**
 * "Whoever can add a connection in the DataDance Web3Auth project can become any user."
 * The token below is genuine: right issuer, right audience, right signature, fresh. The only
 * thing wrong with it is that DataDance never chose the connection it names — which, before
 * WEB3AUTH_ALLOWED_VERIFIERS, was not something the server had any opinion about.
 */
describe('WEB3AUTH_ALLOWED_VERIFIERS over HTTP (item 2)', () => {
  const rogue = (overrides = {}) =>
    claims({ aggregateVerifier: 'connection-added-by-whoever-holds-the-console', ...overrides });

  it('enforce: 401 IDTOKEN_VERIFIER_NOT_ALLOWED, no session, no row touched', async () => {
    configure({ mode: 'enforce' });
    const res = await post({ idToken: await mint(rogue({ email: VICTIM_EMAIL, verifierId: VICTIM_EMAIL })) });
    assert.equal(res.status, 401);
    assert.equal(res.body.code, 'IDTOKEN_VERIFIER_NOT_ALLOWED');
    assertNoSession(res);
    assert.equal(logged('idtoken_rejected')[0].meta.outcome, 'refused');
  });

  it('enforce: the listed connection still logs its holder in', async () => {
    configure({ mode: 'enforce' });
    prisma.user.rows.push({
      ...victimRow(),
      id: 'linked-1',
      email: 'attacker@example.com',
      referralCode: 'LINKED1',
      web3authVerifier: ALLOWED_VERIFIER,
      web3authVerifierId: 'attacker@example.com',
    });
    const res = await post({ idToken: await mint(claims()) });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.user.id, 'linked-1');
  });

  it('log: accepted, but said loudly on every single token', async () => {
    configure({ mode: 'log' });
    prisma.user.rows.push({
      ...victimRow(),
      id: 'rogue-linked',
      email: 'nobody@example.com',
      referralCode: 'ROGUE01',
      web3authVerifier: 'connection-added-by-whoever-holds-the-console',
      web3authVerifierId: 'nobody@example.com',
    });
    const res = await post({ idToken: await mint(rogue({ verifierId: 'nobody@example.com' })) });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const [warning] = logged('idtoken_verifier_not_allowed');
    assert.ok(warning, 'the rollout must not be able to end quietly with the list still wrong');
    assert.equal(warning.level, 'warn');
    assert.equal(warning.meta.outcome, 'accepted_log_mode');
    assert.equal(warning.meta.verifier, 'connection-added-by-whoever-holds-the-console');
  });

  it('log: the unlisted connection still cannot walk into an existing account', async () => {
    // Even where extractIdentity only warns, resolveUser refuses the backfill (item 2, 2nd half).
    configure({ mode: 'log', legacyVerifiers: 'connection-added-by-whoever-holds-the-console' });
    const res = await post({ idToken: await mint(rogue({ email: VICTIM_EMAIL, verifierId: VICTIM_EMAIL, email_verified: true })) });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'IDENTITY_CONFLICT');
    assertNoSession(res);
  });
});
