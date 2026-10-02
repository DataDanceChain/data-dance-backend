/**
 * Web3Auth network switch (devnet -> mainnet) on REAL Postgres (`npm run test:db`; needs
 * TEST_DATABASE_URL pointing at a throwaway database whose name contains "test").
 *
 * The question: after the Wallet and the TGE login move to the mainnet project, does EVERY kind
 * of existing account log back into the SAME User.id — points, referrals, invite code intact —
 * while nobody can use the switch to enter someone else's account, and can the one-step
 * migration be planned, applied, repeated and rolled back?
 *
 * Isolation: the file migrates its own Postgres schema (`ms_<run>` inside TEST_DATABASE_URL's
 * database) with `prisma migrate deploy` and drops it afterwards, because --plan/--apply look at
 * every User row and the other db test files run in parallel.
 *
 * Tokens are minted locally and verified through a local JWKS, exactly as in
 * test/unit/web3authIdentity.test.js; the login goes through the real controller.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('node:http');
const { execFileSync } = require('child_process');
const express = require('express');
const request = require('supertest');
const jose = require('jose');
const { Wallet } = require('ethers');

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required for test:db (a throwaway, migrated database)');
if (!/\/[^/?]*test[^/?]*(\?|$)/.test(url)) throw new Error('TEST_DATABASE_URL must name a database containing "test" — refusing to write fixtures anywhere else');

const RUN = crypto.randomBytes(3).toString('hex');
const SCHEMA = `ms_${RUN}`;
const schemaUrl = `${url}${url.includes('?') ? '&' : '?'}schema=${SCHEMA}`;

const CLIENT_ID = 'mainnet-test-client-id';
const SOCIAL_ISS = 'https://api-auth.web3auth.io';
const EXTERNAL_ISS = 'https://authjs.web3auth.io';
const V = {
  google: 'web3auth-google-sapphire-mainnet',
  email: 'web3auth-auth0-email-passwordless-sapphire-mainnet',
  apple: 'web3auth-auth0-apple-sapphire-mainnet',
  x: 'web3auth-auth0-twitter-sapphire-mainnet',
  rogue: 'web3auth-rogue-sapphire-mainnet', // in the project, not on any list
  googleDevnet: 'web3auth-google-sapphire-devnet',
};

const CUT_ENV = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'error',
  JWT_SECRET: 'mainnet-switch-test-jwt-secret',
  JWT_EXPIRES_IN: '1h',
  DATABASE_URL: schemaUrl,
  WEB3AUTH_VERIFY_MODE: 'enforce',
  WEB3AUTH_CLIENT_ID: CLIENT_ID,
  WEB3AUTH_ALLOWED_VERIFIERS: [V.google, V.email, V.apple, V.x, 'external-wallet'].join(','),
  WEB3AUTH_LEGACY_VERIFIERS: '',
  WEB3AUTH_ALLOW_LEGACY_FALLBACK: 'false',
  WEB3AUTH_WALLET_MATCH: 'public_key',
  WEB3AUTH_JWKS_PIN_MODE: 'off',
  WEB3AUTH_NETWORK_REBIND: 'on',
  WEB3AUTH_REBIND_VERIFIERS: [V.google, V.email, V.apple, V.x].join(','),
  WEB3AUTH_EMAIL_TRUSTED_VERIFIERS: [V.google, V.email, V.apple].join(','),
};
Object.assign(process.env, CUT_ENV);

// Own schema, migrated exactly as production is.
execFileSync(path.join(__dirname, '../../node_modules/.bin/prisma'), ['migrate', 'deploy'], {
  cwd: path.join(__dirname, '../..'),
  env: { ...process.env, DATABASE_URL: schemaUrl },
  stdio: 'pipe',
});

const prisma = require('../../src/utils/prisma');
const identity = require('../../src/services/web3authIdentity');
const { web3authLogin } = require('../../src/controllers/web3AuthController');
const { withPartnerVisibleWallet } = require('../../src/services/networkRebindWallet');
const mainnetSwitch = require('../../scripts/mainnetSwitch');

const app = express();
app.use(express.json());
app.post('/login', web3authLogin);

// ---------------------------------------------------------------------------
// Local JWKS + tokens
// ---------------------------------------------------------------------------

const keys = {};
let jwksServer;

async function makeKey(kid) {
  const { publicKey, privateKey } = await jose.generateKeyPair('ES256');
  const jwk = await jose.exportJWK(publicKey);
  return { kid, privateKey, jwk: { ...jwk, kid, alg: 'ES256', use: 'sig' } };
}

const compressedHex = (w) => w.signingKey.compressedPublicKey.slice(2);

async function mint(claims, { key = keys.social, iss = SOCIAL_ISS } = {}) {
  return new jose.SignJWT(claims)
    .setProtectedHeader({ alg: 'ES256', kid: key.kid })
    .setIssuer(iss)
    .setAudience(CLIENT_ID)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(key.privateKey);
}

/** A mainnet social login: the token proves `wallet` (a NEW key, as every network switch gives). */
async function socialLogin(verifier, verifierId, { email, wallet = Wallet.createRandom() } = {}) {
  const idToken = await mint({
    aggregateVerifier: verifier,
    verifier: 'web3auth',
    verifierId,
    ...(email && { email }),
    name: 'Someone',
    wallets: [{ public_key: compressedHex(wallet), type: 'web3auth_app_key', curve: 'secp256k1' }],
  });
  const res = await request(app).post('/login').send({ idToken, walletAddress: wallet.address });
  return { res, wallet };
}

async function externalLogin(wallet) {
  const idToken = await mint(
    { wallets: [{ address: wallet.address, type: 'ethereum' }] },
    { key: keys.external, iss: EXTERNAL_ISS }
  );
  return request(app).post('/login').send({ idToken, walletAddress: wallet.address });
}

// ---------------------------------------------------------------------------
// Fixtures: the production shape (pre-P0 build → every row a NULL-pair legacy row) plus one
// row already linked on devnet (main deployed on devnet before the cut).
// ---------------------------------------------------------------------------

const devnet = () => Wallet.createRandom().address;
const ext = {
  walt: Wallet.createRandom(),
  wanda: Wallet.createRandom(),
  wes: Wallet.createRandom(),
  squatter: Wallet.createRandom(),
};
const ids = {};
const OLD = {};

async function user(name, data) {
  const id = `${RUN}-${name}`;
  ids[name] = id;
  await prisma.user.create({
    data: {
      id,
      authType: 'web3auth',
      referralCode: `${RUN}${name}`.toUpperCase().slice(0, 20),
      totalPoints: 100,
      ...data,
    },
  });
  OLD[name] = data.walletAddress || null;
  return id;
}

before(async () => {
  keys.social = await makeKey('social-kid');
  keys.external = await makeKey('external-kid');
  jwksServer = http.createServer((req, res) => {
    const body = req.url === '/jwks' ? { keys: [keys.social.jwk] } : req.url === '/ext-jwks' ? { keys: [keys.external.jwk] } : null;
    if (!body) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(body));
  });
  await new Promise((resolve) => jwksServer.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${jwksServer.address().port}`;
  process.env.WEB3AUTH_JWKS_URL = `${base}/jwks`;
  process.env.WEB3AUTH_EXTERNAL_JWKS_URL = `${base}/ext-jwks`;
  identity._internals.resetConfig();

  await user('inviter', { email: `inviter-${RUN}@example.test`, walletAddress: devnet() });
  await user('gina', { email: `gina-${RUN}@example.test`, walletAddress: devnet(), totalPoints: 1234 });
  await user('eve', { email: `eve-${RUN}@example.test`, walletAddress: devnet() });
  await user('apple', { email: `apple${RUN}@privaterelay.appleid.com`, walletAddress: devnet() });
  await user('xavier', { email: `twitter|${RUN}4242`, xid: `${RUN}4242`, walletAddress: devnet() });
  await user('walt', { email: `walt-${RUN}@example.test`, walletAddress: ext.walt.address }); // MetaMask + typed e-mail
  await user('wanda', { email: `wanda-${RUN}@example.test`, walletAddress: ext.wanda.address });
  await user('wes', { email: `wes-${RUN}@example.test`, walletAddress: ext.wes.address }); // operator keep
  await user('sam', { email: `sam-${RUN}@example.test`, walletAddress: devnet() }); // Google + e-mail code
  await user('nowallet', { email: `nowallet-${RUN}@example.test` });
  await user('latebound', { email: `late-${RUN}@example.test` }); // gets a wallet after the apply
  await user('server', { email: `server-${RUN}@example.test`, walletAddress: devnet(), privateKey: '0xserverheld' });
  await user('paired', {
    email: `pat-${RUN}@example.test`,
    walletAddress: devnet(),
    web3authVerifier: V.googleDevnet,
    web3authVerifierId: `pat-${RUN}@example.test`,
    web3authLinkedAt: new Date(),
  });
  await user('dupUpper', { email: `Dup-${RUN}@example.test`, walletAddress: devnet() });
  await user('dupLower', { email: `dup-${RUN}@example.test`, walletAddress: devnet() });
  await user('victim', { email: `victim-${RUN}@example.test`, walletAddress: devnet() });
  // Pre-P0 squat: someone claimed this e-mail and bound their own MetaMask (body-asserted wallet).
  await user('squat', { email: `squat-${RUN}@example.test`, walletAddress: ext.squatter.address });
  // E-mail keyed row reached by a token that carries the address only as its verifierId.
  await user('plain', { email: `plain-${RUN}@example.test`, walletAddress: devnet() });
  await user('password', { email: `pw-${RUN}@example.test`, authType: 'traditional', password: 'x' });
  await user('org', { email: `org-${RUN}@example.test`, userType: 'organization', isOrganization: true });

  // Points and the referral relation the switch must not touch.
  await prisma.referral.create({ data: { inviterId: ids.inviter, inviteeId: ids.gina, code: `${RUN}INV` } });
  await prisma.point.create({ data: { userId: ids.gina, amount: 1234, source: 'test' } });
});

after(async () => {
  await new Promise((resolve) => jwksServer.close(resolve));
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  await prisma.$disconnect();
});

const row = (name) => prisma.user.findUnique({ where: { id: ids[name] } });
const record = (name) => prisma.web3AuthNetworkRebind.findUnique({ where: { userId: ids[name] } });
const userCount = () => prisma.user.count();

async function runScript(args, env = process.env) {
  const lines = [];
  const code = await mainnetSwitch.main(args, { db: prisma, env, log: (l) => lines.push(l) });
  const text = lines.join('\n');
  let json = null;
  if (args.includes('--json')) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  return { code, text, json };
}

// ---------------------------------------------------------------------------

describe('mainnet switch on Postgres', () => {
  let runId;
  let keepFile;

  it('switch off: today behaviour — an existing user is refused (wallet_mismatch), nothing is written', async () => {
    process.env.WEB3AUTH_NETWORK_REBIND = 'off';
    identity._internals.resetConfig();
    try {
      const before = await userCount();
      const { res } = await socialLogin(V.google, `gina-${RUN}@example.test`, { email: `gina-${RUN}@example.test` });
      assert.equal(res.status, 409);
      assert.equal(res.body.code, 'IDENTITY_CONFLICT');
      assert.equal(await userCount(), before);
      assert.equal((await row('gina')).walletAddress, OLD.gina);
    } finally {
      process.env.WEB3AUTH_NETWORK_REBIND = 'on';
      identity._internals.resetConfig();
    }
  });

  it('switch on but not applied: still refused (the re-bind needs a record)', async () => {
    const { res } = await socialLogin(V.google, `gina-${RUN}@example.test`, { email: `gina-${RUN}@example.test` });
    assert.equal(res.status, 409);
    assert.equal((await row('gina')).web3authVerifier, null);
  });

  it('--plan: counts, duplicates and the accounts that will not re-bind, ids only, GO', async () => {
    keepFile = path.join(os.tmpdir(), `ms-keep-${RUN}.txt`);
    fs.writeFileSync(keepFile, `# external wallets ops confirmed\n${ids.wes}\n`);
    const { code, json, text } = await runScript(['--plan', '--json', '--all-ids', '--keep-wallet-ids', keepFile]);
    assert.equal(code, mainnetSwitch.EXIT.GO, text);
    assert.equal(json.go, true);
    const r = json.report;
    assert.equal(r.users_total, Object.keys(ids).length);
    assert.equal(r.by_auth_type.traditional, 1);
    assert.equal(r.organizations, 1);
    assert.equal(r.web3auth_regular.by_pair_state.old_network, 1);
    assert.equal(r.web3auth_regular.with_server_key, 1);
    assert.equal(r.to_record.total, 18); // every web3auth regular row
    assert.deepEqual(r.to_record.by_evidence, {
      email_unpaired: 12,
      x_verifier_id: 1,
      operator_keep: 1,
      no_wallet: 2,
      server_wallet: 1,
      devnet_pair: 1,
    });
    assert.equal(r.to_record.old_network_pairs_cleared, 1);
    assert.equal(r.duplicate_emails.groups, 1);
    assert.deepEqual(new Set(r.not_automatic.ambiguous_email.ids), new Set([ids.dupUpper, ids.dupLower]));
    assert.deepEqual(r.not_automatic.apple_relay_address_may_differ.ids, [ids.apple]);
    assert.deepEqual(r.not_automatic.not_web3auth.ids, [ids.password]);
    assert.deepEqual(r.not_automatic.organization.ids, [ids.org]);
    // Never an e-mail, an address or a key in the output.
    assert.doesNotMatch(text, /@example\.test|privaterelay|0x[0-9a-fA-F]{40}|serverheld/);
    const human = await runScript(['--plan', '--keep-wallet-ids', keepFile]);
    assert.doesNotMatch(human.text, /@example\.test|privaterelay|0x[0-9a-fA-F]{40}|serverheld/);
    assert.match(human.text, /\nGO$/);
  });

  it('--plan / --apply: NO-GO when the environment still names devnet connections or the switch is off', async () => {
    const devnetEnv = { ...process.env, WEB3AUTH_ALLOWED_VERIFIERS: `${process.env.WEB3AUTH_ALLOWED_VERIFIERS},${V.googleDevnet}` };
    const a = await runScript(['--apply', '--yes', '--json'], devnetEnv);
    assert.equal(a.code, mainnetSwitch.EXIT.NO_GO);
    assert.match(a.json.blockers.join(' '), /sapphire-devnet/);
    const off = await runScript(['--plan', '--json'], { ...process.env, WEB3AUTH_NETWORK_REBIND: 'off' });
    assert.equal(off.code, mainnetSwitch.EXIT.NO_GO);
    const broken = await runScript(['--plan', '--json'], { ...process.env, WEB3AUTH_REBIND_VERIFIERS: 'not-allowed-name' });
    assert.equal(broken.code, mainnetSwitch.EXIT.NO_GO);
    assert.match(broken.json.blockers[0], /backend would not boot/);
    assert.equal(await prisma.web3AuthNetworkRebind.count(), 0, 'nothing applied');
    assert.equal((await runScript(['--apply'])).code, mainnetSwitch.EXIT.USAGE, '--apply needs --yes');
    assert.equal((await runScript(['--plan', '--apply'])).code, mainnetSwitch.EXIT.USAGE);
  });

  it('--apply: backup table first, one record per account, devnet pair cleared; a second run does nothing', async () => {
    const { code, json, text } = await runScript(['--apply', '--yes', '--json', '--keep-wallet-ids', keepFile]);
    assert.equal(code, mainnetSwitch.EXIT.GO, text);
    assert.equal(json.applied, true);
    assert.equal(json.accounts, 18);
    assert.equal(json.old_network_pairs_cleared, 1);
    runId = json.run_id;
    const backup = await prisma.$queryRawUnsafe(`SELECT id, "walletAddress", "web3authVerifier" FROM "${json.backup_table}"`);
    assert.equal(backup.length, 18);
    assert.equal(backup.find((b) => b.id === ids.paired).web3authVerifier, V.googleDevnet);
    const paired = await row('paired');
    assert.equal(paired.web3authVerifier, null);
    assert.equal(paired.walletAddress, OLD.paired, 'apply never touches a wallet');
    assert.equal((await record('paired')).oldVerifier, V.googleDevnet);
    assert.equal((await record('wes')).walletPolicy, 'keep');
    assert.equal((await record('server')).walletPolicy, 'keep');
    assert.equal((await record('wes')).evidence, 'operator_keep');
    assert.equal((await record('walt')).walletPolicy, 'replace');
    assert.equal(await record('password'), null);
    assert.equal(await record('org'), null);

    const again = await runScript(['--apply', '--yes', '--json']);
    assert.equal(again.code, mainnetSwitch.EXIT.GO);
    assert.equal(again.json.nothing_to_do, true);
    assert.equal(await prisma.web3AuthNetworkRebindRun.count(), 1);
  });

  it('partner API: a pending account reads as unbound until its re-bind', async () => {
    const pending = await withPartnerVisibleWallet(await row('gina'));
    assert.equal(pending.walletAddress, null);
    const kept = await withPartnerVisibleWallet(await row('server'));
    assert.equal(kept.walletAddress, OLD.server);
  });

  it('Google: same User.id, mainnet address bound, points / referral / invite code intact', async () => {
    const before = await userCount();
    const gina = await row('gina');
    const { res, wallet } = await socialLogin(V.google, `gina-${RUN}@example.test`, { email: `gina-${RUN}@example.test` });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.user.id, ids.gina);
    const after = await row('gina');
    assert.equal(after.walletAddress, wallet.address);
    assert.equal(after.web3authVerifier, V.google);
    assert.equal(after.totalPoints, gina.totalPoints);
    assert.equal(after.referralCode, gina.referralCode);
    assert.equal((await prisma.referral.findUnique({ where: { inviteeId: ids.gina } })).inviterId, ids.inviter);
    assert.equal(await prisma.point.count({ where: { userId: ids.gina } }), 1);
    const rec = await record('gina');
    assert.equal(rec.status, 'rebound');
    assert.equal(rec.oldAddress, OLD.gina);
    assert.equal(rec.newAddress, wallet.address);
    assert.equal(await userCount(), before, 'no new account');
    assert.equal((await withPartnerVisibleWallet(after)).walletAddress, wallet.address, 'partner sees the new address');
    // Next login: plain pair hit.
    const again = await request(app)
      .post('/login')
      .send({
        idToken: await mint({
          aggregateVerifier: V.google,
          verifierId: `gina-${RUN}@example.test`,
          email: `gina-${RUN}@example.test`,
          wallets: [{ public_key: compressedHex(wallet), type: 'web3auth_app_key', curve: 'secp256k1' }],
        }),
        walletAddress: wallet.address,
      });
    assert.equal(again.status, 200);
    assert.equal(again.body.data.user.id, ids.gina);
  });

  it('e-mail passwordless (address typed in another case), Apple, X, devnet-paired, no-wallet, server wallet: same User.id', async () => {
    const before = await userCount();
    const cases = [
      ['eve', V.email, `eve-${RUN}@example.test`, `EVE-${RUN}@Example.test`],
      ['apple', V.apple, `apple${RUN}@privaterelay.appleid.com`, `apple${RUN}@privaterelay.appleid.com`],
      ['xavier', V.x, `twitter|${RUN}4242`, undefined],
      ['paired', V.google, `pat-${RUN}@example.test`, `pat-${RUN}@example.test`],
      ['nowallet', V.google, `nowallet-${RUN}@example.test`, `nowallet-${RUN}@example.test`],
    ];
    for (const [name, verifier, verifierId, email] of cases) {
      const { res, wallet } = await socialLogin(verifier, verifierId, { email });
      assert.equal(res.status, 200, `${name}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.data.user.id, ids[name], name);
      const after = await row(name);
      assert.equal(after.walletAddress, wallet.address, name);
      assert.equal(after.web3authVerifier, verifier, name);
      assert.equal((await record(name)).status, 'rebound', name);
    }
    const { res } = await socialLogin(V.google, `server-${RUN}@example.test`, { email: `server-${RUN}@example.test` });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.user.id, ids.server);
    assert.equal((await row('server')).walletAddress, OLD.server, 'a server-held wallet is never replaced');
    // A wallet bound after the apply by another path (signed bind, partner payout bind) is not an
    // old-network address: the pair re-binds, the wallet stays.
    const lateWallet = devnet();
    await prisma.user.update({ where: { id: ids.latebound }, data: { walletAddress: lateWallet } });
    assert.equal((await withPartnerVisibleWallet(await row('latebound'))).walletAddress, lateWallet);
    const late = await socialLogin(V.google, `late-${RUN}@example.test`, { email: `late-${RUN}@example.test` });
    assert.equal(late.res.status, 200);
    assert.equal(late.res.body.data.user.id, ids.latebound);
    assert.equal((await row('latebound')).walletAddress, lateWallet);
    assert.equal((await record('latebound')).newAddress, lateWallet);
    assert.equal(await userCount(), before);
  });

  it('external wallet: signs in with its wallet → same User.id, address kept, record closed', async () => {
    const before = await userCount();
    const res = await externalLogin(ext.walt);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.user.id, ids.walt);
    const walt = await row('walt');
    assert.equal(walt.walletAddress, ext.walt.address);
    assert.equal(walt.web3authVerifier, 'external-wallet');
    const rec = await record('walt');
    assert.equal(rec.status, 'rebound');
    assert.equal(rec.newAddress, ext.walt.address);
    // The same e-mail through Google later cannot take the wallet or the account over.
    const google = await socialLogin(V.google, `walt-${RUN}@example.test`, { email: `walt-${RUN}@example.test` });
    assert.equal(google.res.status, 409);
    assert.equal((await row('walt')).walletAddress, ext.walt.address);
    assert.equal(await userCount(), before);
  });

  it('a wallet a re-bind replaced never logs in again (409, no duplicate); an operator-kept wallet does', async () => {
    const before = await userCount();
    const google = await socialLogin(V.google, `wanda-${RUN}@example.test`, { email: `wanda-${RUN}@example.test` });
    assert.equal(google.res.status, 200);
    assert.equal(google.res.body.data.user.id, ids.wanda);
    const res = await externalLogin(ext.wanda);
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.code, 'IDENTITY_CONFLICT');
    assert.equal(res.body.data, undefined, 'no session');
    assert.equal(await userCount(), before, 'no duplicate account for the replaced address');
    assert.equal((await row('wanda')).walletAddress, google.wallet.address);
    // Operator-kept external wallet: Google re-binds the pair, the address stays.
    const wes = await socialLogin(V.google, `wes-${RUN}@example.test`, { email: `wes-${RUN}@example.test` });
    assert.equal(wes.res.status, 200);
    assert.equal((await row('wes')).walletAddress, ext.wes.address);
    const wesWallet = await externalLogin(ext.wes);
    assert.equal(wesWallet.status, 200);
    assert.equal(wesWallet.body.data.user.id, ids.wes);
    assert.equal(await userCount(), before);
  });

  it('squat, then the owner re-binds: the squatter\'s pre-cut wallet gets 409, never the owner\'s account', async () => {
    const before = await userCount();
    const owner = await socialLogin(V.google, `squat-${RUN}@example.test`, { email: `squat-${RUN}@example.test` });
    assert.equal(owner.res.status, 200, JSON.stringify(owner.res.body));
    assert.equal(owner.res.body.data.user.id, ids.squat);
    assert.equal((await row('squat')).walletAddress, owner.wallet.address);
    const rec = await record('squat');
    assert.equal(rec.status, 'rebound');
    assert.equal(rec.oldAddress, ext.squatter.address, 'the squatter address stays only as history');
    for (let i = 0; i < 2; i++) {
      const attacker = await externalLogin(ext.squatter);
      assert.equal(attacker.status, 409, JSON.stringify(attacker.body));
      assert.equal(attacker.body.code, 'IDENTITY_CONFLICT');
      assert.equal(attacker.body.data, undefined, 'no session for the squatter');
      assert.doesNotMatch(JSON.stringify(attacker.body), new RegExp(ids.squat), 'the owner id is not disclosed');
    }
    const squat = await row('squat');
    assert.equal(squat.web3authVerifier, V.google);
    assert.equal(squat.walletAddress, owner.wallet.address);
    assert.equal(await userCount(), before);
  });

  it('e-mail-shaped verifierId without an e-mail claim still needs an e-mail-trusted connection', async () => {
    const before = await userCount();
    // Apple on the re-bind list but NOT on the e-mail-trusted list.
    process.env.WEB3AUTH_EMAIL_TRUSTED_VERIFIERS = [V.google, V.email].join(',');
    identity._internals.resetConfig();
    try {
      const apple = await socialLogin(V.apple, `plain-${RUN}@example.test`); // no `email` claim
      assert.equal(apple.res.status, 409, JSON.stringify(apple.res.body));
      assert.equal(apple.res.body.code, 'IDENTITY_CONFLICT');
      const differentCase = await socialLogin(V.apple, `PLAIN-${RUN}@example.test`);
      assert.equal(differentCase.res.status, 409, 'case-insensitive match is e-mail keyed too');
      const plain = await row('plain');
      assert.equal(plain.web3authVerifier, null);
      assert.equal(plain.walletAddress, OLD.plain);
      assert.equal((await record('plain')).status, 'pending');
    } finally {
      process.env.WEB3AUTH_EMAIL_TRUSTED_VERIFIERS = CUT_ENV.WEB3AUTH_EMAIL_TRUSTED_VERIFIERS;
      identity._internals.resetConfig();
    }
    // With Apple trusted again, the same token re-binds: the 409 came from the trust guard.
    const ok = await socialLogin(V.apple, `plain-${RUN}@example.test`);
    assert.equal(ok.res.status, 200, JSON.stringify(ok.res.body));
    assert.equal(ok.res.body.data.user.id, ids.plain);
    assert.equal(await userCount(), before);
  });

  it('one e-mail, two methods: Google then e-mail code reach the same account; the wallet stays the first one', async () => {
    const before = await userCount();
    const google = await socialLogin(V.google, `sam-${RUN}@example.test`, { email: `sam-${RUN}@example.test` });
    assert.equal(google.res.status, 200);
    const code = await socialLogin(V.email, `sam-${RUN}@example.test`, { email: `sam-${RUN}@example.test` });
    assert.equal(code.res.status, 200, JSON.stringify(code.res.body));
    assert.equal(code.res.body.data.user.id, ids.sam);
    const sam = await row('sam');
    assert.equal(sam.web3authVerifier, V.google);
    assert.equal(sam.walletAddress, google.wallet.address);
    // X carries no verified e-mail: it never gets in on the same address.
    const x = await socialLogin(V.x, `twitter|${RUN}999`, { email: `sam-${RUN}@example.test` });
    assert.equal(x.res.status, 409);
    assert.equal(await userCount(), before);
  });

  it('attackers stay out: untrusted verifier, e-mail claim from X, unknown connection, ambiguous e-mail, password account', async () => {
    const before = await userCount();
    // X token naming the victim's e-mail (X does not verify it): refused, nothing changes.
    const x = await socialLogin(V.x, `twitter|${RUN}666`, { email: `victim-${RUN}@example.test` });
    assert.equal(x.res.status, 409);
    // A connection someone added to the mainnet project but no list names.
    const rogue = await socialLogin(V.rogue, `victim-${RUN}@example.test`, { email: `victim-${RUN}@example.test` });
    assert.equal(rogue.res.status, 401);
    assert.equal(rogue.res.body.code, 'IDTOKEN_VERIFIER_NOT_ALLOWED');
    // A devnet token (old App build): wrong connection name → refused.
    const old = await socialLogin(V.googleDevnet, `victim-${RUN}@example.test`, { email: `victim-${RUN}@example.test` });
    assert.equal(old.res.status, 401);
    const victim = await row('victim');
    assert.equal(victim.web3authVerifier, null);
    assert.equal(victim.walletAddress, OLD.victim);
    assert.equal((await record('victim')).status, 'pending');
    // Two rows that differ only in case: a token in a third casing cannot pick one.
    const dup = await socialLogin(V.google, `dup-${RUN}@example.test`.toUpperCase(), { email: `DUP-${RUN}@EXAMPLE.TEST` });
    assert.equal(dup.res.status, 409);
    assert.equal((await row('dupUpper')).web3authVerifier, null);
    assert.equal((await row('dupLower')).web3authVerifier, null);
    // Password account with the same e-mail: refused as before.
    const pw = await socialLogin(V.google, `pw-${RUN}@example.test`, { email: `pw-${RUN}@example.test` });
    assert.equal(pw.res.status, 409);
    assert.equal(await userCount(), before);
    // The victim's own Google login still works afterwards.
    const own = await socialLogin(V.google, `victim-${RUN}@example.test`, { email: `victim-${RUN}@example.test` });
    assert.equal(own.res.status, 200);
    assert.equal(own.res.body.data.user.id, ids.victim);
  });

  it('a brand-new mainnet user is created normally, and is NOT e-mail keyed', async () => {
    const before = await userCount();
    const g = await socialLogin(V.google, `newbie-${RUN}@example.test`, { email: `newbie-${RUN}@example.test` });
    assert.equal(g.res.status, 201);
    assert.equal(await userCount(), before + 1);
    const second = await socialLogin(V.email, `newbie-${RUN}@example.test`, { email: `newbie-${RUN}@example.test` });
    assert.equal(second.res.status, 409, 'strict one-pair rule for accounts created on mainnet');
    ids.newbie = g.res.body.data.user.id;
  });

  it('--plan after the logins: pending and rebound counts', async () => {
    const { json } = await runScript(['--plan', '--json']);
    assert.equal(json.report.records.rebound, 15);
    assert.equal(json.report.records.pending, 3); // the inviter (never came back) and the two case-duplicates
    assert.equal(json.runs.length, 1);
  });

  it('--rollback: every column of the run back to the backup (re-binds included), records gone; idempotent; re-apply works', async () => {
    const { code, json, text } = await runScript(['--rollback', '--run', runId, '--yes', '--json']);
    assert.equal(code, mainnetSwitch.EXIT.GO, text);
    assert.equal(json.rolled_back, true);
    assert.equal(json.accounts_restored, 18);
    assert.equal(json.rebinds_reverted, 15);
    for (const name of ['gina', 'eve', 'apple', 'xavier', 'nowallet', 'latebound', 'server', 'walt', 'wanda', 'sam', 'squat', 'plain']) {
      const r = await row(name);
      assert.equal(r.walletAddress, OLD[name], name);
      assert.equal(r.web3authVerifier, null, name);
    }
    const paired = await row('paired');
    assert.equal(paired.web3authVerifier, V.googleDevnet);
    assert.equal(paired.walletAddress, OLD.paired);
    assert.equal(await prisma.web3AuthNetworkRebind.count(), 0);
    assert.equal((await row('gina')).totalPoints, 1234);
    // The newbie created on mainnet is not part of the run.
    assert.equal((await prisma.user.findUnique({ where: { id: ids.newbie } })).web3authVerifier, V.google);

    const again = await runScript(['--rollback', '--run', runId, '--yes', '--json']);
    assert.equal(again.code, mainnetSwitch.EXIT.GO);
    assert.equal(again.json.rolled_back, false);
    const unknown = await runScript(['--rollback', '--run', '20990101000000_beef', '--yes', '--json']);
    assert.equal(unknown.code, mainnetSwitch.EXIT.NO_GO);

    const reapply = await runScript(['--apply', '--yes', '--json']);
    assert.equal(reapply.code, mainnetSwitch.EXIT.GO);
    assert.equal(reapply.json.accounts, 18);
    assert.notEqual(reapply.json.run_id, runId);
    const gina = await socialLogin(V.google, `gina-${RUN}@example.test`, { email: `gina-${RUN}@example.test` });
    assert.equal(gina.res.status, 200);
    assert.equal(gina.res.body.data.user.id, ids.gina);
    fs.rmSync(keepFile, { force: true });
  });
});
