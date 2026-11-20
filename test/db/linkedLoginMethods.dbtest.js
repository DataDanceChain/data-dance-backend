/**
 * Linked sign-in methods (WEB3AUTH_LINK_TRUSTED_METHODS) on REAL Postgres (`npm run test:db`; needs
 * TEST_DATABASE_URL pointing at a throwaway database whose name contains "test").
 *
 * The question: on Sapphire mainnet every login connection derives its own wallet. When one person
 * signs in with Google, the e-mail code or Apple using the same address, do they reach the SAME
 * account — same User.id, the account's own wallet in the session, the partner API and the
 * profile — while a connection that does not verify the address (X), an untrusted connection, a
 * disabled account and an ambiguous address are refused exactly as before, and the switch off
 * changes nothing?
 *
 * Isolation: the file migrates its own Postgres schema (`lm_<run>` inside TEST_DATABASE_URL's
 * database) with `prisma migrate deploy` and drops it afterwards. Tokens are minted locally and
 * verified through a local JWKS; the logins go through the real controller.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const path = require('path');
const http = require('node:http');
const { execFileSync } = require('child_process');
const express = require('express');
const request = require('supertest');
const jose = require('jose');
const jwt = require('jsonwebtoken');
const { Wallet, getAddress } = require('ethers');

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required for test:db (a throwaway, migrated database)');
if (!/\/[^/?]*test[^/?]*(\?|$)/.test(url)) throw new Error('TEST_DATABASE_URL must name a database containing "test" — refusing to write fixtures anywhere else');

const RUN = crypto.randomBytes(3).toString('hex');
const SCHEMA = `lm_${RUN}`;
const schemaUrl = `${url}${url.includes('?') ? '&' : '?'}schema=${SCHEMA}`;

const CLIENT_ID = 'linked-methods-test-client-id';
const SOCIAL_ISS = 'https://api-auth.web3auth.io';
const V = {
  google: 'web3auth-google-sapphire-mainnet',
  email: 'web3auth-auth0-email-passwordless-sapphire-mainnet',
  apple: 'web3auth-auth0-apple-sapphire-mainnet',
  x: 'web3auth-auth0-twitter-sapphire-mainnet',
  rogue: 'web3auth-rogue-sapphire-mainnet', // accepted, but does not verify e-mail
};

const ENV = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'error',
  JWT_SECRET: 'linked-methods-test-jwt-secret',
  JWT_EXPIRES_IN: '1h',
  DATABASE_URL: schemaUrl,
  WEB3AUTH_VERIFY_MODE: 'enforce',
  WEB3AUTH_CLIENT_ID: CLIENT_ID,
  WEB3AUTH_ALLOWED_VERIFIERS: [V.google, V.email, V.apple, V.x, V.rogue, 'external-wallet'].join(','),
  WEB3AUTH_LEGACY_VERIFIERS: '',
  WEB3AUTH_ALLOW_LEGACY_FALLBACK: 'false',
  WEB3AUTH_WALLET_MATCH: 'public_key',
  WEB3AUTH_JWKS_PIN_MODE: 'off',
  WEB3AUTH_NETWORK_REBIND: 'off',
  WEB3AUTH_REBIND_VERIFIERS: '',
  WEB3AUTH_EMAIL_TRUSTED_VERIFIERS: [V.google, V.email, V.apple].join(','),
  WEB3AUTH_LINK_TRUSTED_METHODS: 'on',
};
Object.assign(process.env, ENV);

execFileSync(path.join(__dirname, '../../node_modules/.bin/prisma'), ['migrate', 'deploy'], {
  cwd: path.join(__dirname, '../..'),
  env: { ...process.env, DATABASE_URL: schemaUrl },
  stdio: 'pipe',
});

const prisma = require('../../src/utils/prisma');
const identity = require('../../src/services/web3authIdentity');
const { web3authLogin } = require('../../src/controllers/web3AuthController');
const { protect } = require('../../src/middlewares/authMiddleware');
const { meBody } = require('../../src/routes/partnerTgeRoutes');
const { withPartnerVisibleWallet } = require('../../src/services/networkRebindWallet');

const app = express();
app.use(express.json());
app.post('/login', web3authLogin);
app.get('/whoami', protect, (req, res) => res.json({ id: req.user.id, walletAddress: req.user.walletAddress }));

function setSwitches(patch) {
  Object.assign(process.env, ENV, patch);
  identity._internals.resetConfig();
}

// ---------------------------------------------------------------------------
// Local JWKS + tokens
// ---------------------------------------------------------------------------

let socialKey;
let jwksServer;

const compressedHex = (w) => w.signingKey.compressedPublicKey.slice(2);

async function mint(claims) {
  return new jose.SignJWT(claims)
    .setProtectedHeader({ alg: 'ES256', kid: socialKey.kid })
    .setIssuer(SOCIAL_ISS)
    .setAudience(CLIENT_ID)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(socialKey.privateKey);
}

/**
 * One person's sign-in methods: each connection derives its own wallet (as on Sapphire mainnet),
 * and the same connection always derives the same one.
 */
function person(name) {
  const address = `${name}-${RUN}@example.test`;
  const wallets = {};
  const walletFor = (verifier) => (wallets[verifier] = wallets[verifier] || Wallet.createRandom());
  return { name, address, walletFor };
}

/** A social login through the real controller. `email: null` = the address only as verifierId. */
async function login(p, verifier, { verifierId = p.address, email = p.address } = {}) {
  const wallet = p.walletFor(`${verifier}|${verifierId}`);
  const idToken = await mint({
    aggregateVerifier: verifier,
    verifier: 'web3auth',
    verifierId,
    ...(email && { email }),
    name: p.name,
    wallets: [{ public_key: compressedHex(wallet), type: 'web3auth_app_key', curve: 'secp256k1' }],
  });
  const res = await request(app).post('/login').send({ idToken, walletAddress: wallet.address });
  return { res, wallet };
}

const userRow = (id) => prisma.user.findUnique({ where: { id } });
const linksOf = (userId) =>
  prisma.web3AuthLinkedMethod.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });
const linkCount = () => prisma.web3AuthLinkedMethod.count();

/** The identity columns that must never move on a linked login. */
const identityColumns = (u) => ({
  id: u.id,
  email: u.email,
  walletAddress: u.walletAddress,
  web3authVerifier: u.web3authVerifier,
  web3authVerifierId: u.web3authVerifierId,
  web3authLinkedAt: u.web3authLinkedAt && u.web3authLinkedAt.toISOString(),
  totalPoints: u.totalPoints,
  referralCode: u.referralCode,
});

/** What the partner API's /me returns as wallet_address for this account (tge:wallet served). */
async function partnerWalletAddress(userId) {
  const user = await withPartnerVisibleWallet(await userRow(userId));
  const req = {
    partner: {
      user,
      client: { statusFields: ['wallet_address', 'email_masked'] },
      token: { scope: 'sso:identity tge:identity tge:wallet', clientId: 'partner', issuedAt: new Date(), expiresAt: new Date() },
    },
    protocol: 'https',
    get: () => 'api.example.test',
  };
  return meBody(req).wallet_address;
}

/** Create an account the way production does: its first login through `verifier`. */
async function signUp(p, verifier, opts) {
  const { res, wallet } = await login(p, verifier, opts);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return { id: res.body.data.user.id, wallet };
}

before(async () => {
  const { publicKey, privateKey } = await jose.generateKeyPair('ES256');
  const jwk = await jose.exportJWK(publicKey);
  socialKey = { kid: 'social-kid', privateKey, jwk: { ...jwk, kid: 'social-kid', alg: 'ES256', use: 'sig' } };
  jwksServer = http.createServer((req, res) => {
    if (req.url !== '/jwks') {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ keys: [socialKey.jwk] }));
  });
  await new Promise((resolve) => jwksServer.listen(0, '127.0.0.1', resolve));
  ENV.WEB3AUTH_JWKS_URL = `http://127.0.0.1:${jwksServer.address().port}/jwks`;
  setSwitches({});
});

after(async () => {
  await new Promise((resolve) => jwksServer.close(resolve));
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------

describe('linked sign-in methods on Postgres', () => {
  it('e-mail code first, then Google with the same address: same account, its own wallet everywhere', async () => {
    setSwitches({});
    const alice = person('alice');
    const account = await signUp(alice, V.email);
    await prisma.user.update({ where: { id: account.id }, data: { totalPoints: 1234 } });
    const before = identityColumns(await userRow(account.id));
    assert.equal(before.walletAddress, account.wallet.address);

    const { res, wallet: googleWallet } = await login(alice, V.google);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.user.id, account.id);
    assert.equal(res.body.data.user.walletAddress, account.wallet.address);
    assert.notEqual(googleWallet.address, account.wallet.address);

    // The account row is exactly as it was: pair, wallet, points, invite code.
    assert.deepEqual(identityColumns(await userRow(account.id)), before);
    const links = await linksOf(account.id);
    assert.deepEqual(
      links.map(({ verifier, verifierId, walletAddress }) => ({ verifier, verifierId, walletAddress })),
      [{ verifier: V.google, verifierId: alice.address, walletAddress: googleWallet.address }]
    );

    // The session names the account; everything server-side reads the account's wallet.
    const claims = jwt.verify(res.body.data.token, ENV.JWT_SECRET);
    assert.equal(claims.id, account.id);
    assert.equal(claims.ver, 2);
    const who = await request(app).get('/whoami').set('Authorization', `Bearer ${res.body.data.token}`);
    assert.deepEqual(who.body, { id: account.id, walletAddress: account.wallet.address });
    assert.equal(await partnerWalletAddress(account.id), getAddress(account.wallet.address));
  });

  it('the linked method again: a plain login, no new row; the own method still logs in', async () => {
    setSwitches({});
    const bea = person('bea');
    const account = await signUp(bea, V.email);
    assert.equal((await login(bea, V.google)).res.status, 200);
    const linked = await linksOf(account.id);

    const again = await login(bea, V.google);
    assert.equal(again.res.status, 200);
    assert.equal(again.res.body.data.user.id, account.id);
    assert.equal(again.res.body.data.user.walletAddress, account.wallet.address);
    assert.deepEqual(await linksOf(account.id), linked);

    const own = await login(bea, V.email);
    assert.equal(own.res.status, 200);
    assert.equal(own.res.body.data.user.id, account.id);
  });

  it('Google first, then the e-mail code (address only as its verifierId): linked', async () => {
    setSwitches({});
    const cai = person('cai');
    const account = await signUp(cai, V.google);
    const { res, wallet } = await login(cai, V.email, { email: null });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.user.id, account.id);
    assert.equal((await userRow(account.id)).walletAddress, account.wallet.address);
    const [link] = await linksOf(account.id);
    assert.deepEqual([link.verifier, link.walletAddress], [V.email, wallet.address]);
  });

  it('Apple with the same address (opaque verifierId): linked; a third method links too', async () => {
    setSwitches({});
    const dan = person('dan');
    const account = await signUp(dan, V.email);
    const apple = await login(dan, V.apple, { verifierId: `apple|${RUN}.dan` });
    assert.equal(apple.res.status, 200, JSON.stringify(apple.res.body));
    assert.equal(apple.res.body.data.user.id, account.id);
    const google = await login(dan, V.google);
    assert.equal(google.res.body.data.user.id, account.id);
    assert.deepEqual((await linksOf(account.id)).map((l) => l.verifier), [V.apple, V.google]);
    assert.equal((await userRow(account.id)).walletAddress, account.wallet.address);
  });

  it('X with the same address: still IDENTITY_CONFLICT, nothing written', async () => {
    setSwitches({});
    const eve = person('eve');
    const account = await signUp(eve, V.email);
    const before = await userRow(account.id);
    const { res } = await login(eve, V.x, { verifierId: `twitter|${RUN}77` });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'IDENTITY_CONFLICT');
    assert.deepEqual(await userRow(account.id), before);
    assert.deepEqual(await linksOf(account.id), []);
  });

  it('an accepted connection that does not verify e-mail: refused as before', async () => {
    setSwitches({});
    const fay = person('fay');
    const account = await signUp(fay, V.email);
    const { res } = await login(fay, V.rogue);
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'IDENTITY_CONFLICT');
    assert.deepEqual(await linksOf(account.id), []);
  });

  it('a disabled account: 403 ACCOUNT_DISABLED, nothing linked; an existing link does not open it either', async () => {
    setSwitches({});
    const gus = person('gus');
    const account = await signUp(gus, V.email);
    assert.equal((await login(gus, V.apple, { verifierId: `apple|${RUN}.gus` })).res.status, 200);
    await prisma.user.update({ where: { id: account.id }, data: { disabledAt: new Date() } });
    const google = await login(gus, V.google);
    assert.equal(google.res.status, 403);
    assert.equal(google.res.body.code, 'ACCOUNT_DISABLED');
    const apple = await login(gus, V.apple, { verifierId: `apple|${RUN}.gus` });
    assert.equal(apple.res.status, 403);
    assert.deepEqual((await linksOf(account.id)).map((l) => l.verifier), [V.apple]);
  });

  it('two accounts whose e-mails differ only in case: refused, nothing linked', async () => {
    setSwitches({});
    const hal = person('hal');
    const account = await signUp(hal, V.email);
    const twinWallet = Wallet.createRandom();
    const twin = await prisma.user.create({
      data: {
        email: hal.address.toUpperCase(),
        authType: 'web3auth',
        referralCode: `TWIN${RUN}`.toUpperCase(),
        walletAddress: twinWallet.address,
        web3authVerifier: V.google,
        web3authVerifierId: `${hal.address}.twin`,
      },
    });
    const { res } = await login(hal, V.google);
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'IDENTITY_CONFLICT');
    assert.deepEqual(await linksOf(account.id), []);
    assert.deepEqual(await linksOf(twin.id), []);
  });

  it('concurrent first links of the same method: exactly one row, every login reaches the account', async () => {
    setSwitches({});
    const ivy = person('ivy');
    const account = await signUp(ivy, V.email);
    const results = await Promise.all(Array.from({ length: 8 }, () => login(ivy, V.google)));
    for (const { res } of results) {
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.user.id, account.id);
      assert.equal(res.body.data.user.walletAddress, account.wallet.address);
    }
    assert.equal((await linksOf(account.id)).length, 1);
    assert.equal(
      await prisma.web3AuthLinkedMethod.count({ where: { verifier: V.google, verifierId: ivy.address } }),
      1
    );
  });

  it('a linked login never binds the method\'s wallet, even on an account without one', async () => {
    setSwitches({});
    const jo = person('jo');
    const account = await signUp(jo, V.email);
    assert.equal((await login(jo, V.google)).res.status, 200);
    // An account that has lost its wallet (e.g. restored from an older backup) stays without one.
    await prisma.user.update({ where: { id: account.id }, data: { walletAddress: null } });
    const again = await login(jo, V.google);
    assert.equal(again.res.status, 200);
    assert.equal(again.res.body.data.user.id, account.id);
    assert.equal(again.res.body.data.user.walletAddress, null);
    assert.equal((await userRow(account.id)).walletAddress, null);
  });

  it('switch off: the refusal is exactly today\'s, existing links are not used, nothing is written', async () => {
    setSwitches({});
    const kim = person('kim');
    const account = await signUp(kim, V.email);
    assert.equal((await login(kim, V.apple, { verifierId: `apple|${RUN}.kim` })).res.status, 200);

    setSwitches({ WEB3AUTH_LINK_TRUSTED_METHODS: 'off' });
    try {
      const before = await userRow(account.id);
      const linksBefore = await linkCount();
      const google = await login(kim, V.google);
      assert.equal(google.res.status, 409);
      assert.deepEqual(google.res.body, {
        status: 'fail',
        code: 'IDENTITY_CONFLICT',
        message: 'This login cannot be linked to the existing account automatically',
      });
      let reason = null;
      try {
        const ident = identity.extractIdentity(
          { aggregateVerifier: V.google, verifierId: kim.address, email: kim.address },
          { kind: 'social' }
        );
        await identity.resolveUser(ident, { walletAddress: kim.walletFor(`${V.google}|${kim.address}`).address });
      } catch (err) {
        reason = err.details && err.details.reason;
      }
      assert.equal(reason, 'candidate_already_linked');
      const apple = await login(kim, V.apple, { verifierId: `apple|${RUN}.kim` });
      assert.equal(apple.res.status, 409, 'an existing link is not read while the switch is off');
      assert.deepEqual(await userRow(account.id), before);
      assert.equal(await linkCount(), linksBefore);
    } finally {
      setSwitches({});
    }
  });

  it('network re-bind on: a pending re-bind record still takes the re-bind path', async () => {
    setSwitches({
      WEB3AUTH_NETWORK_REBIND: 'on',
      WEB3AUTH_REBIND_VERIFIERS: [V.google, V.email, V.apple, V.x].join(','),
    });
    try {
      const lou = person('lou');
      const oldAddress = Wallet.createRandom().address;
      const legacy = await prisma.user.create({
        data: { email: lou.address, authType: 'web3auth', referralCode: `LOU${RUN}`.toUpperCase(), walletAddress: oldAddress },
      });
      const runId = `20261014000000_${RUN.slice(0, 4)}`;
      await prisma.web3AuthNetworkRebindRun.create({
        data: { id: runId, backupTable: 'none', fromNetwork: 'sapphire_devnet', toNetwork: 'sapphire_mainnet', accountCount: 1 },
      });
      await prisma.web3AuthNetworkRebind.create({
        data: {
          userId: legacy.id,
          runId,
          fromNetwork: 'sapphire_devnet',
          toNetwork: 'sapphire_mainnet',
          oldAddress,
          walletPolicy: 'replace',
          evidence: 'email_unpaired',
        },
      });
      const { res, wallet } = await login(lou, V.google);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.user.id, legacy.id);
      const row = await userRow(legacy.id);
      assert.deepEqual([row.web3authVerifier, row.walletAddress], [V.google, wallet.address], 're-bound, not linked');
      assert.equal((await prisma.web3AuthNetworkRebind.findUnique({ where: { userId: legacy.id } })).status, 'rebound');
      assert.deepEqual(await linksOf(legacy.id), []);

      // An account made on the new network still links with both switches on.
      const max = person('max');
      const account = await signUp(max, V.email);
      const google = await login(max, V.google);
      assert.equal(google.res.status, 200);
      assert.equal(google.res.body.data.user.id, account.id);
      assert.equal((await linksOf(account.id)).length, 1);
    } finally {
      setSwitches({});
    }
  });
});
