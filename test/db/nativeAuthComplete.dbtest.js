/**
 * Native login identify → /token → /complete on REAL Postgres (`npm run test:db`; needs
 * TEST_DATABASE_URL pointing at a throwaway, migrated database whose name contains "test").
 * Design §7.3: unique constraints, concurrent /complete for one attempt (one wins), concurrent
 * creates (LOGIN_RACE with a full rollback), concurrent re-mints, the lazy rebind transaction,
 * and the cascade on user delete. The Web3Auth nodes are a fake (one wallet per subject); nothing
 * here reaches the network. Fixture identities use a per-run prefix.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const path = require('path');
const { Wallet } = require('ethers');

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required for test:db (a throwaway, migrated database)');
if (!/\/[^/?]*test[^/?]*(\?|$)/.test(url)) throw new Error('TEST_DATABASE_URL must name a database containing "test" — refusing to write fixtures anywhere else');

const { makeKeyFile, localEnv } = require('../helpers/nativeAuthKeys');

const key = makeKeyFile();
const LEGACY_EMAIL = 'web3auth-auth0-email-passwordless-sapphire-devnet';
const ENV = localEnv(key, { DDC_AUTH_NEW_ACCOUNTS: 'open', DDC_AUTH_LEGACY_EMAIL_VERIFIERS: LEGACY_EMAIL, JWT_EXPIRES_IN: '1h' });
Object.assign(process.env, ENV, { DATABASE_URL: url, LOG_LEVEL: 'error', WEB3AUTH_VERIFY_MODE: 'off' });

const src = (rel) => path.join(__dirname, '../../src', rel);
const prisma = require(src('utils/prisma.js'));
const config = require(src('services/nativeAuth/config.js'));
const { createLoginAttempt } = require(src('services/nativeAuth/identify.js'));
const { completeLogin, reissueToken } = require(src('services/nativeAuth/complete.js'));
const w3aLookup = require(src('services/nativeAuth/w3aLookup.js'));
const { buildProofMessage } = require(src('services/nativeAuth/proofMessage.js'));

const RUN = `nat${crypto.randomBytes(3).toString('hex')}`;
const addr = (name) => `${RUN}-${name}@example.test`;

const wallets = new Map();
function walletFor(subject) {
  if (!wallets.has(subject)) wallets.set(subject, Wallet.createRandom());
  return wallets.get(subject);
}
w3aLookup.setLookupDepsForTests({
  Torus: class {
    async getPublicAddress(endpoints, pubs, { verifierId }) {
      return { finalKeyData: { walletAddress: walletFor(verifierId).address } };
    }
  },
  keyType: 'secp256k1',
  fetchLocalConfig: () => ({ torusNodeEndpoints: ['https://n1'], torusNodePub: [{}] }),
});

let overrides = {};
const cfg = () => config.readNativeAuthConfig({ ...ENV, ...overrides });
const email = (address) => ({ provider: 'email', subject: address, email: address, emailVerified: true });

async function proofBody(identified, extra = {}) {
  const wallet = walletFor(identified.web3auth.verifierId);
  const signature = await wallet.signMessage(buildProofMessage(identified.walletProof, wallet.address));
  return { loginId: identified.loginId, loginSecret: identified.loginSecret, walletAddress: wallet.address, signature, ...extra };
}

async function settle(promise) {
  try {
    return { ok: await promise };
  } catch (err) {
    return { err };
  }
}

const createdUsers = [];

after(async () => {
  // Throwaway database; still remove this run's rows so a rerun starts clean.
  const ids = [...new Set(createdUsers)];
  if (ids.length) {
    await prisma.walletAddressHistory.deleteMany({ where: { userId: { in: ids } } });
    await prisma.userProfile.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.authLoginAttempt.deleteMany({ where: { subject: { startsWith: RUN } } });
  await prisma.$disconnect();
});

describe('native login on Postgres', () => {
  before(() => {
    overrides = {};
  });

  it('creates user, binding and identity; the unique constraints hold', async () => {
    const identified = await createLoginAttempt({ identity: email(addr('ada')), cfg: cfg() });
    const { httpStatus, data } = await completeLogin({ body: await proofBody(identified, { locale: 'ja' }), cfg: cfg() });
    assert.equal(httpStatus, 201);
    createdUsers.push(data.user.id);
    const binding = await prisma.nativeWalletBinding.findUnique({ where: { userId: data.user.id } });
    assert.equal(binding.subject, identified.web3auth.verifierId);
    assert.equal(binding.address, data.user.walletAddress);
    const profile = await prisma.userProfile.findUnique({ where: { userId: data.user.id } });
    assert.equal(profile.language, 'ja');
    await assert.rejects(
      prisma.nativeWalletBinding.create({ data: { userId: crypto.randomUUID(), connection: 'ddc-jwt-devnet', network: 'sapphire_devnet', subject: binding.subject, address: '0x1' } }),
      (err) => err.code === 'P2002' || err.code === 'P2003',
    );
    await assert.rejects(
      prisma.authIdentity.create({ data: { userId: data.user.id, provider: 'email', subject: addr('ada'), linkedVia: 'created' } }),
      (err) => err.code === 'P2002',
    );
    const attempt = await prisma.authLoginAttempt.findUnique({ where: { id: identified.loginId } });
    assert.equal(attempt.state, 'completed');
    assert.notEqual(attempt.loginSecretHash, identified.loginSecret);
  });

  it('two concurrent /complete calls for one attempt: exactly one wins', async () => {
    const identified = await createLoginAttempt({ identity: email(addr('bob')), cfg: cfg() });
    const body = await proofBody(identified);
    const results = await Promise.all([settle(completeLogin({ body, cfg: cfg() })), settle(completeLogin({ body, cfg: cfg() }))]);
    const wins = results.filter((r) => r.ok);
    const losses = results.filter((r) => r.err);
    assert.equal(wins.length, 1);
    assert.equal(losses.length, 1);
    assert.equal(losses[0].err.code, 'LOGIN_EXPIRED');
    createdUsers.push(wins[0].ok.data.user.id);
    assert.equal(await prisma.user.count({ where: { email: addr('bob') } }), 1);
  });

  it('two attempts creating the same identity concurrently: one account, the loser is LOGIN_RACE and fully rolled back', async () => {
    const a = await createLoginAttempt({ identity: email(addr('cat')), cfg: cfg() });
    const b = await createLoginAttempt({ identity: email(addr('cat')), cfg: cfg() });
    // As if the two identifies had raced: B carries its own pending user and subject.
    const otherUser = crypto.randomUUID();
    const otherSubject = crypto.randomUUID();
    await prisma.authLoginAttempt.update({ where: { id: b.loginId }, data: { pendingUserId: otherUser, w3aSubject: otherSubject } });
    const bFixed = { ...b, web3auth: { ...b.web3auth, verifierId: otherSubject } };
    const results = await Promise.all([
      settle(completeLogin({ body: await proofBody(a), cfg: cfg() })),
      settle(completeLogin({ body: await proofBody(bFixed), cfg: cfg() })),
    ]);
    const wins = results.filter((r) => r.ok);
    const losses = results.filter((r) => r.err);
    assert.equal(wins.length, 1, JSON.stringify(results.map((r) => (r.err ? r.err.code : r.ok.httpStatus))));
    assert.equal(losses[0].err.code, 'LOGIN_RACE');
    createdUsers.push(wins[0].ok.data.user.id);
    const winnerId = wins[0].ok.data.user.id;
    const loserId = winnerId === otherUser ? attemptPending(a) : otherUser;
    assert.equal(await prisma.user.count({ where: { id: await loserId } }), 0, 'no user row of the loser');
    assert.equal(await prisma.nativeWalletBinding.count({ where: { userId: await loserId } }), 0, 'no binding of the loser');
    assert.equal(await prisma.authIdentity.count({ where: { provider: 'email', subject: addr('cat') } }), 1);
    const loserAttempt = await prisma.authLoginAttempt.findFirst({ where: { id: { in: [a.loginId, b.loginId] }, state: 'identified' } });
    assert.ok(loserAttempt, 'the losing attempt was reset to identified');
  });

  it('concurrent re-mints never exceed two per attempt', async () => {
    const identified = await createLoginAttempt({ identity: email(addr('dan')), cfg: cfg() });
    const results = await Promise.all(
      Array.from({ length: 5 }, () => settle(reissueToken({ loginId: identified.loginId, loginSecret: identified.loginSecret, reason: 'network', cfg: cfg() }))),
    );
    assert.equal(results.filter((r) => r.ok).length, 2);
    assert.ok(results.filter((r) => r.err).every((r) => r.err.code === 'LOGIN_TOKEN_LIMIT'));
    const row = await prisma.authLoginAttempt.findUnique({ where: { id: identified.loginId } });
    assert.equal(row.w3aTokenCount, 3);
  });

  it('refuse writes nothing; lazy rebind commits history, legacy identity, binding and wallet together', async () => {
    const legacyId = crypto.randomUUID();
    const oldAddress = Wallet.createRandom().address;
    await prisma.user.create({
      data: { id: legacyId, email: addr('eve'), authType: 'web3auth', referralCode: `${RUN}EVE`.toUpperCase(), walletAddress: oldAddress, web3authVerifier: LEGACY_EMAIL, web3authVerifierId: addr('eve') },
    });
    createdUsers.push(legacyId);
    overrides = {};
    const refused = await createLoginAttempt({ identity: email(addr('eve')), cfg: cfg() });
    await assert.rejects(completeLogin({ body: await proofBody(refused), cfg: cfg() }), (err) => err.code === 'WALLET_REBIND_REQUIRED');
    assert.equal(await prisma.authIdentity.count({ where: { userId: legacyId } }), 0);
    assert.equal(await prisma.nativeWalletBinding.count({ where: { userId: legacyId } }), 0);
    assert.equal((await prisma.user.findUnique({ where: { id: legacyId } })).walletAddress, oldAddress);

    overrides = { DDC_AUTH_REBIND_POLICY: 'lazy' };
    const lazy = await createLoginAttempt({ identity: email(addr('eve')), cfg: cfg() });
    const { httpStatus, data } = await completeLogin({ body: await proofBody(lazy), cfg: cfg() });
    overrides = {};
    assert.equal(httpStatus, 200);
    assert.equal(data.user.walletAddress, walletFor(lazy.web3auth.verifierId).address);
    const history = await prisma.walletAddressHistory.findMany({ where: { userId: legacyId } });
    assert.equal(history.length, 1);
    assert.equal(history[0].oldAddress, oldAddress);
    const providers = (await prisma.authIdentity.findMany({ where: { userId: legacyId } })).map((r) => r.provider).sort();
    assert.deepEqual(providers, ['email', 'web3auth_legacy']);
  });

  it('deleting a user cascades to identities, binding and attempts; the address history stays', async () => {
    const identified = await createLoginAttempt({ identity: email(addr('fay')), cfg: cfg() });
    const { data } = await completeLogin({ body: await proofBody(identified), cfg: cfg() });
    const userId = data.user.id;
    await prisma.walletAddressHistory.create({
      data: { userId, oldAddress: '0x0', oldNetwork: 'sapphire_devnet', newAddress: '0x1', newVerifier: 'ddc-jwt-devnet', newSubjectRef: 'b', newNetwork: 'sapphire_devnet', reason: 'test', status: 'planned', chainStatus: 'pending' },
    });
    await prisma.userProfile.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } });
    assert.equal(await prisma.authIdentity.count({ where: { userId } }), 0);
    assert.equal(await prisma.nativeWalletBinding.count({ where: { userId } }), 0);
    assert.equal(await prisma.authLoginAttempt.count({ where: { userId } }), 0);
    assert.equal(await prisma.walletAddressHistory.count({ where: { userId } }), 1);
    await prisma.walletAddressHistory.deleteMany({ where: { userId } });
  });
});

async function attemptPending(identified) {
  const row = await prisma.authLoginAttempt.findUnique({ where: { id: identified.loginId } });
  return row.pendingUserId;
}
