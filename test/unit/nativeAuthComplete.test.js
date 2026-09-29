/**
 * Identify → POST /token → POST /complete (design §2.1 #10–11, §3.6, §3.7, §3.11; F2, F3, F5,
 * F11, F12, F21): the Identified body and what the attempt row stores, the loginSecret rules
 * (HMAC-stored, never logged, at most 2 re-mints with a reason), the wallet proof, the always-on
 * node lookup, create / link / bind in one transaction, refusals that write nothing, the rebind
 * policies, every P2002 → LOGIN_RACE, referral parity with web3auth-login and the session claims.
 *
 * In-memory Prisma with unique checks; the Web3Auth nodes are a fake that derives one random
 * wallet per subject (what the SFA client would derive), so no test reaches the network.
 */
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { Wallet } = require('ethers');

const { makeKeyFile, localEnv } = require('../helpers/nativeAuthKeys');

const key = makeKeyFile();
const CONN = 'ddc-jwt-devnet';
const LEGACY_EMAIL = 'web3auth-auth0-email-passwordless-sapphire-devnet';
const LEGACY_X = 'web3auth-auth0-twitter-sapphire-devnet';
const BASE_ENV = localEnv(key, {
  DDC_AUTH_METHODS: 'email,google,apple,x',
  DDC_AUTH_NEW_ACCOUNTS: 'open',
  DDC_AUTH_LEGACY_EMAIL_VERIFIERS: LEGACY_EMAIL,
  DDC_AUTH_LEGACY_X_VERIFIERS: LEGACY_X,
  JWT_EXPIRES_IN: '1h',
});
Object.assign(process.env, BASE_ENV, { NODE_ENV: 'test', LOG_LEVEL: 'error', WEB3AUTH_VERIFY_MODE: 'off' });

const { installMockPrisma, uniqueViolation } = require('../helpers/mockPrisma');

const prisma = installMockPrisma({ enforceUnique: true });

// findUserByReferralCode reads with $queryRaw; answer it from the in-memory user rows (as in
// web3authLoginReferral.test.js).
require.cache[require.resolve('@prisma/client')].exports.Prisma = { join: (values) => ({ values }) };
prisma.$queryRaw = async (_strings, ...params) => {
  const wanted = new Set(params.flatMap((p) => (p && Array.isArray(p.values) ? p.values : [])).map((v) => String(v).toLowerCase()));
  const hit = prisma.user.rows.find((r) => wanted.has(String(r.referralCode || '').toLowerCase()) || wanted.has(String(r.legacyReferralCode || '').toLowerCase()));
  return hit ? [{ id: hit.id, email: hit.email, name: hit.name, referralCode: hit.referralCode }] : [];
};

// Capture every log line (meta before redaction: the services must not even pass secrets).
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
const { createLoginAttempt } = require('../../src/services/nativeAuth/identify');
const complete = require('../../src/services/nativeAuth/complete');
const w3aLookup = require('../../src/services/nativeAuth/w3aLookup');
const { buildProofMessage } = require('../../src/services/nativeAuth/proofMessage');
const { NATIVE_ERROR_CODES } = require('../../src/controllers/nativeAuth/respond');
const completeController = require('../../src/controllers/nativeAuth/completeController');
const referralService = require('../../src/services/referralService');
const { listenLoopback } = require('../helpers/loopbackServer');

const settled = [];
referralService.processReferral = async (inviteeId, inviterId, code) => {
  settled.push({ inviteeId, inviterId, code });
};

// ---------------------------------------------------------------------------------------------
// The fake Web3Auth nodes: one wallet per subject; the "client" derives the same one.
// ---------------------------------------------------------------------------------------------
const wallets = new Map();
const lookups = [];
let nodesDown = false;
function walletFor(subject) {
  if (!wallets.has(subject)) wallets.set(subject, Wallet.createRandom());
  return wallets.get(subject);
}
class FakeTorus {
  async getPublicAddress(endpoints, pubs, { verifier, verifierId }) {
    lookups.push({ verifier, verifierId });
    if (nodesDown) throw new Error('nodes down');
    return { finalKeyData: { walletAddress: walletFor(verifierId).address } };
  }
}
w3aLookup.setLookupDepsForTests({ Torus: FakeTorus, keyType: 'secp256k1', fetchLocalConfig: () => ({ torusNodeEndpoints: ['https://n1'], torusNodePub: [{}] }) });

// ---------------------------------------------------------------------------------------------
// App and helpers
// ---------------------------------------------------------------------------------------------
let envOverrides = {};
const cfg = () => config.readNativeAuthConfig({ ...BASE_ENV, ...envOverrides });

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  req.nativeAuthConfig = cfg();
  next();
});
app.post('/token', completeController.token);
app.post('/complete', completeController.complete);
let server;
before(async () => {
  server = await listenLoopback(app);
});
after(() => server.close());

const email = (address) => ({ provider: 'email', subject: address, email: address, emailVerified: true });
const google = (address, extra = {}) => ({ provider: 'google', subject: `g-${address}`, email: address, emailVerified: true, ...extra });
const x = (id, extra = {}) => ({ provider: 'x', subject: id, profile: { xUsername: `handle${id}` }, ...extra });

const identify = (identity, options = {}) => createLoginAttempt({ identity, cfg: cfg(), db: prisma, ...options });

async function proofFor(identified, wallet = walletFor(identified.web3auth.verifierId)) {
  const message = buildProofMessage(identified.walletProof, wallet.address);
  return { walletAddress: wallet.address, signature: await wallet.signMessage(message) };
}

async function completeWith(identified, extra = {}, wallet) {
  const proof = await proofFor(identified, wallet);
  return request(server)
    .post('/complete')
    .send({ loginId: identified.loginId, loginSecret: identified.loginSecret, ...proof, ...extra });
}

async function signIn(identity, extra = {}) {
  const identified = await identify(identity);
  const res = await completeWith(identified, extra);
  return { identified, res };
}

const token = (identified, reason = 'duplicate_token', secret = identified.loginSecret) =>
  request(server).post('/token').send({ loginId: identified.loginId, loginSecret: secret, reason });

function expectCode(res, status, code) {
  assert.equal(res.status, status, JSON.stringify(res.body));
  assert.equal(res.body.code, code, JSON.stringify(res.body));
}

let seq = 0;
function addUser(fields = {}) {
  seq += 1;
  const row = {
    id: `user-${seq}`,
    email: `user${seq}@example.com`,
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
    referralCode: `CODE${seq}X`,
    legacyReferralCode: null,
    password: null,
    privateKey: null,
    ...fields,
  };
  prisma.user.rows.push(row);
  return row;
}

const attemptRow = (loginId) => prisma.authLoginAttempt.rows.find((r) => r.id === loginId);
const tables = () => JSON.stringify({ u: prisma.user.rows, i: prisma.authIdentity.rows, b: prisma.nativeWalletBinding.rows, h: prisma.walletAddressHistory.rows, r: prisma.referral.rows });

beforeEach(() => {
  prisma.reset();
  logs.length = 0;
  lookups.length = 0;
  settled.length = 0;
  nodesDown = false;
  envOverrides = {};
});

// ---------------------------------------------------------------------------------------------
describe('identify: the Identified body and the attempt row', () => {
  it('returns loginId, a 256-bit loginSecret, the account, a Web3Auth JWT for the opaque subject and the proof', async () => {
    const identified = await identify(email('ada@example.com'));
    assert.match(identified.loginId, /^[0-9a-f-]{36}$/);
    assert.match(identified.loginSecret, /^[A-Za-z0-9_-]{43}$/);
    assert.deepEqual(identified.account, { status: 'new', hasWallet: false, linkedBy: 'new' });
    const { web3auth, walletProof } = identified;
    assert.equal(web3auth.network, 'sapphire_devnet');
    assert.equal(web3auth.verifier, CONN);
    assert.match(web3auth.verifierId, /^[0-9a-f-]{36}$/);
    const claims = jwt.decode(web3auth.idToken, { complete: true });
    assert.equal(claims.header.alg, 'RS256');
    assert.equal(claims.header.kid, key.thumbprint);
    assert.equal(claims.payload.sub, web3auth.verifierId);
    assert.equal(claims.payload.iss, 'ddc-auth-devnet');
    assert.equal(claims.payload.aud, 'ddc-w3a-devnet');
    assert.equal(claims.payload.email, undefined, 'no PII in the node token');
    assert.equal(new Date(web3auth.idTokenExpiresAt).getTime(), claims.payload.exp * 1000);
    assert.equal(walletProof.requestId, config.loginRef(identified.loginId, cfg()));
    assert.equal(walletProof.domain, 'localhost:20444');
    assert.equal(walletProof.chainId, 44508);

    const row = attemptRow(identified.loginId);
    assert.notEqual(row.w3aSubject, row.pendingUserId, 'the subject is not the user id (F11)');
    assert.equal(row.w3aSubject, web3auth.verifierId);
    assert.equal(row.w3aTokenCount, 1);
    assert.equal(row.lastJti, claims.payload.jti);
    assert.equal(row.state, 'identified');
    assert.equal(row.resolution, 'create');
    assert.ok(!JSON.stringify(prisma.store).includes(identified.loginSecret), 'the loginSecret is stored only as an HMAC (F3)');
    assert.equal(row.loginSecretHash, config.stateHmac('login', identified.loginSecret, cfg()));
  });

  it('repeating identify for the same new identity keeps the same subject and pending user id', async () => {
    const a = await identify(email('ada@example.com'));
    const b = await identify(email('ada@example.com'));
    assert.equal(b.web3auth.verifierId, a.web3auth.verifierId);
    assert.equal(attemptRow(b.loginId).pendingUserId, attemptRow(a.loginId).pendingUserId);
    assert.notEqual(b.loginId, a.loginId);
    assert.notEqual(b.loginSecret, a.loginSecret);
  });

  it("intent 'link' mints nothing and returns only loginId, loginSecret, expiresAt and account (F2)", async () => {
    const user = addUser({ walletAddress: Wallet.createRandom().address });
    const identified = await identify(google('ada@gmail.com'), { intent: 'link', bearerUser: user });
    assert.deepEqual(Object.keys(identified).sort(), ['account', 'expiresAt', 'loginId', 'loginSecret']);
    assert.deepEqual(identified.account, { status: 'existing', hasWallet: true, linkedBy: 'identity' });
    const row = attemptRow(identified.loginId);
    assert.equal(row.w3aSubject, null);
    assert.equal(row.walletProof, null);
    assert.equal(row.w3aTokenCount, 0);
    assert.equal(row.userId, user.id);
    assert.ok(!logs.some((l) => l.message === 'native_auth.w3a_jwt_issued'));
    await assert.rejects(identify(google('ada@gmail.com'), { intent: 'link' }), TypeError, 'link needs the signed-in user');
    const disabled = addUser({ disabledAt: new Date() });
    await assert.rejects(identify(google('b@gmail.com'), { intent: 'link', bearerUser: disabled }), (err) => err.code === 'ACCOUNT_DISABLED');
  });

  it('a refused resolution creates no attempt', async () => {
    addUser({ email: 'ada@example.com', web3authVerifier: 'web3auth-auth0-apple-sapphire-devnet', web3authVerifierId: 'apple|1' });
    await assert.rejects(identify(email('ada@example.com')), (err) => err.code === 'ACCOUNT_LINK_REQUIRED' && err.data.reason === 'legacy_method');
    assert.equal(prisma.authLoginAttempt.rows.length, 0);
  });
});

// ---------------------------------------------------------------------------------------------
describe('POST /token (loginSecret, at most 2 re-mints with a reason)', () => {
  it('re-mints for the same subject with a new jti; the third re-mint is LOGIN_TOKEN_LIMIT', async () => {
    const identified = await identify(email('ada@example.com'));
    const first = jwt.decode(identified.web3auth.idToken);
    for (const reason of ['duplicate_token', 'timesigned']) {
      const res = await token(identified, reason);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.deepEqual(Object.keys(res.body.data), ['web3auth']);
      assert.deepEqual(Object.keys(res.body.data.web3auth).sort(), ['idToken', 'idTokenExpiresAt']);
      const claims = jwt.decode(res.body.data.web3auth.idToken);
      assert.equal(claims.sub, first.sub);
      assert.notEqual(claims.jti, first.jti);
      assert.equal(attemptRow(identified.loginId).lastJti, claims.jti);
    }
    assert.equal(attemptRow(identified.loginId).w3aTokenCount, 3);
    expectCode(await token(identified, 'network'), 429, 'LOGIN_TOKEN_LIMIT');
    assert.equal(attemptRow(identified.loginId).w3aTokenCount, 3);
    const issued = logs.filter((l) => l.message === 'native_auth.w3a_jwt_issued').map((l) => l.meta.count);
    assert.deepEqual(issued, [1, 2, 3]);
  });

  it('a wrong secret, an unknown or malformed id, an unknown reason, an expired or finished attempt → LOGIN_EXPIRED', async () => {
    const identified = await identify(email('ada@example.com'));
    expectCode(await token(identified, 'duplicate_token', crypto.randomBytes(32).toString('base64url')), 400, 'LOGIN_EXPIRED');
    expectCode(await request(server).post('/token').send({ loginId: crypto.randomUUID(), loginSecret: identified.loginSecret, reason: 'expired' }), 400, 'LOGIN_EXPIRED');
    expectCode(await request(server).post('/token').send({ loginId: 'x', loginSecret: 'y', reason: 'expired' }), 400, 'LOGIN_EXPIRED');
    expectCode(await request(server).post('/token').send({}), 400, 'LOGIN_EXPIRED');
    expectCode(await token(identified, 'because'), 400, 'LOGIN_EXPIRED');
    assert.equal(attemptRow(identified.loginId).w3aTokenCount, 1, 'no refused call minted');
    attemptRow(identified.loginId).expiresAt = new Date(Date.now() - 1000);
    expectCode(await token(identified), 400, 'LOGIN_EXPIRED');
  });

  it('never mints for a link attempt or from a session (F2, D4)', async () => {
    const user = addUser();
    const link = await identify(google('ada@gmail.com'), { intent: 'link', bearerUser: user });
    expectCode(await token(link), 400, 'LOGIN_EXPIRED');
    const session = jwt.sign({ id: user.id, ver: 2 }, process.env.JWT_SECRET);
    const res = await request(server).post('/token').set('Authorization', `Bearer ${session}`).send({ reason: 'expired' });
    expectCode(res, 400, 'LOGIN_EXPIRED');
    assert.ok(!logs.some((l) => l.message === 'native_auth.w3a_jwt_issued'));
  });

  it('only identify and /token call the issuer (source check)', () => {
    const dir = path.join(__dirname, '../../src');
    const callers = [];
    const walk = (d) => {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const file = path.join(d, entry.name);
        if (entry.isDirectory()) walk(file);
        else if (entry.name.endsWith('.js') && /issueW3aToken\s*\(|mintW3aJwt\s*\(/.test(fs.readFileSync(file, 'utf8'))) callers.push(path.relative(dir, file));
      }
    };
    walk(dir);
    assert.deepEqual(callers.sort(), ['services/nativeAuth/complete.js', 'services/nativeAuth/identify.js', 'services/nativeAuth/issuer.js']);
  });

  it('guardAccount runs at /token (F21)', async () => {
    const user = addUser();
    prisma.authIdentity.rows.push({ id: 'i1', userId: user.id, provider: 'email', subject: 'ada@example.com', email: 'ada@example.com', emailLinkGrade: 'strong', linkedVia: 'created', createdAt: new Date() });
    const identified = await identify(email('ada@example.com'));
    user.disabledAt = new Date();
    expectCode(await token(identified), 403, 'ACCOUNT_DISABLED');
  });

  it('after /complete the attempt can no longer mint', async () => {
    const { identified, res } = await signIn(email('ada@example.com'));
    assert.equal(res.status, 201);
    expectCode(await token(identified), 400, 'LOGIN_EXPIRED');
  });
});

// ---------------------------------------------------------------------------------------------
describe('POST /complete: a new account', () => {
  it('creates user, binding and identity in one step; 201 with today\'s body plus isNewUser', async () => {
    const { identified, res } = await signIn(email('ada@example.com'), { locale: 'zh-TW' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.headers['cache-control'], undefined, 'the router adds no-store (tested with the real router below)');
    assert.deepEqual(Object.keys(res.body.data).sort(), ['isNewUser', 'token', 'user']);
    assert.equal(res.body.data.isNewUser, true);
    const wallet = walletFor(identified.web3auth.verifierId);
    const user = res.body.data.user;
    assert.equal(user.email, 'ada@example.com');
    assert.equal(user.walletAddress, wallet.address);
    assert.equal(user.authType, 'web3auth');
    assert.equal(user.web3authVerifier, CONN);
    assert.equal(user.web3authVerifierId, user.id, 'the pair is (connection, userId)');
    assert.equal(user.password, undefined);
    assert.equal(user.privateKey, undefined);
    assert.ok(!JSON.stringify(res.body).includes(identified.web3auth.verifierId), 'the w3aSubject is never returned (F11)');

    const binding = prisma.nativeWalletBinding.rows[0];
    assert.equal(binding.userId, user.id);
    assert.equal(binding.subject, identified.web3auth.verifierId);
    assert.notEqual(binding.subject, user.id);
    assert.equal(binding.address, wallet.address);
    assert.equal(binding.connection, CONN);
    const identity = prisma.authIdentity.rows[0];
    assert.deepEqual(
      { provider: identity.provider, subject: identity.subject, email: identity.email, grade: identity.emailLinkGrade, via: identity.linkedVia },
      { provider: 'email', subject: 'ada@example.com', email: 'ada@example.com', grade: 'strong', via: 'created' },
    );
    assert.equal(prisma.user.rows[0].profile.create.language, 'zh-TW');

    const session = jwt.verify(res.body.data.token, process.env.JWT_SECRET);
    assert.equal(session.id, user.id);
    assert.equal(session.ver, 2, 'a verified session: decideConsent with requireVerifiedSession accepts ver >= 2');
    assert.equal(session.amr, 'email');

    const row = attemptRow(identified.loginId);
    assert.equal(row.state, 'completed');
    assert.equal(row.userId, user.id);
    assert.deepEqual(lookups, [{ verifier: CONN, verifierId: identified.web3auth.verifierId }], 'the nodes proved the address');
  });

  it('a replayed /complete is LOGIN_EXPIRED; the next sign-in is existing (200, isNewUser false) and skips the lookup', async () => {
    const { identified, res } = await signIn(email('ada@example.com'));
    assert.equal(res.status, 201);
    expectCode(await completeWith(identified), 400, 'LOGIN_EXPIRED');
    lookups.length = 0;
    const again = await signIn(email('ada@example.com'));
    assert.equal(again.res.status, 200, JSON.stringify(again.res.body));
    assert.equal(again.res.body.data.isNewUser, false);
    assert.equal(again.res.body.data.user.id, res.body.data.user.id);
    assert.equal(again.identified.web3auth.verifierId, identified.web3auth.verifierId, 'same subject → same wallet');
    assert.equal(lookups.length, 0, 'NativeWalletBinding already holds (connection, subject, address)');
    assert.ok(prisma.authIdentity.rows[0].lastLoginAt instanceof Date);
    assert.equal(prisma.authIdentity.rows.length, 1);
  });

  it('X: xid is set when free; a held xid is left alone (no 409, F12)', async () => {
    const first = await signIn(x('42'));
    assert.equal(first.res.status, 201);
    assert.equal(first.res.body.data.user.xid, '42');
    assert.equal(first.res.body.data.user.email, 'x|42', 'placeholder e-mail');
    assert.equal(first.res.body.data.user.xUsername, 'handle42');
    assert.equal(first.res.body.data.user.name, 'handle42', 'display name from the X handle');
    prisma.reset();
    addUser({ xid: '43' });
    const second = await signIn(x('43'));
    assert.equal(second.res.status, 201, JSON.stringify(second.res.body));
    assert.equal(second.res.body.data.user.xid ?? null, null);
    assert.ok(logs.some((l) => l.message === 'native_auth.xid_held_elsewhere'));
  });

  it('a weak Google e-mail is never put in User.email (placeholder google|<sub>)', async () => {
    const { res } = await signIn(google('ada@corp.example'));
    assert.equal(res.status, 201);
    assert.equal(res.body.data.user.email, 'google|g-ada@corp.example');
    assert.equal(prisma.authIdentity.rows[0].emailLinkGrade, 'weak');
  });

  it('rule 3d: a password row holding the e-mail is untouched; the native account gets a placeholder (F5)', async () => {
    const old = addUser({ email: 'ada@example.com', authType: 'traditional', password: 'bcrypt-hash' });
    const before = JSON.stringify(old);
    const { res } = await signIn(email('ada@example.com'));
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const created = res.body.data.user;
    assert.notEqual(created.id, old.id);
    assert.equal(created.email, `email|${created.id}`);
    assert.equal(JSON.stringify(prisma.user.rows.find((u) => u.id === old.id)), before);
    const identity = prisma.authIdentity.rows[0];
    assert.equal(identity.email, 'ada@example.com');
    assert.equal(identity.emailLinkGrade, 'strong');
    assert.ok(logs.some((l) => l.message === 'native_auth.email_shadowed'));
  });

  it('the daily cap is re-checked at /complete', async () => {
    const identified = await identify(email('ada@example.com'));
    envOverrides = { DDC_AUTH_NEW_ACCOUNTS_PER_DAY: '1' };
    prisma.authIdentity.rows.push({ id: 'other', userId: 'u', provider: 'email', subject: 'z@x.com', linkedVia: 'created', createdAt: new Date() });
    expectCode(await completeWith(identified), 403, 'NEW_ACCOUNTS_CLOSED');
    assert.equal(prisma.user.rows.length, 0);
  });
});

// ---------------------------------------------------------------------------------------------
describe('POST /complete: proof and lookup', () => {
  it('a signature by another wallet → WALLET_PROOF_INVALID; the attempt is reset and can still complete', async () => {
    const identified = await identify(email('ada@example.com'));
    const intruder = Wallet.createRandom();
    const message = buildProofMessage(identified.walletProof, walletFor(identified.web3auth.verifierId).address);
    const res = await request(server).post('/complete').send({
      loginId: identified.loginId,
      loginSecret: identified.loginSecret,
      walletAddress: walletFor(identified.web3auth.verifierId).address,
      signature: await intruder.signMessage(message),
    });
    expectCode(res, 401, 'WALLET_PROOF_INVALID');
    assert.equal(attemptRow(identified.loginId).state, 'identified');
    assert.equal(prisma.user.rows.length, 0);
    assert.equal((await completeWith(identified)).status, 201);
  });

  it('a signature over another message (other nonce) or a malformed one → WALLET_PROOF_INVALID', async () => {
    const identified = await identify(email('ada@example.com'));
    const wallet = walletFor(identified.web3auth.verifierId);
    const other = { ...identified.walletProof, nonce: crypto.randomBytes(16).toString('hex') };
    const signature = await wallet.signMessage(buildProofMessage(other, wallet.address));
    const send = (body) => request(server).post('/complete').send({ loginId: identified.loginId, loginSecret: identified.loginSecret, walletAddress: wallet.address, ...body });
    expectCode(await send({ signature }), 401, 'WALLET_PROOF_INVALID');
    expectCode(await send({ signature: '0x1234' }), 401, 'WALLET_PROOF_INVALID');
    expectCode(await send({ signature, walletAddress: 'nope' }), 401, 'WALLET_PROOF_INVALID');
  });

  it('a wallet the nodes do not derive for the subject (e.g. usePnPKey:true) → WALLET_NOT_DERIVED, nothing written', async () => {
    const identified = await identify(email('ada@example.com'));
    const pnpKey = Wallet.createRandom();
    const res = await completeWith(identified, {}, pnpKey);
    expectCode(res, 401, 'WALLET_NOT_DERIVED');
    assert.equal(prisma.user.rows.length + prisma.nativeWalletBinding.rows.length + prisma.authIdentity.rows.length, 0);
    assert.equal(attemptRow(identified.loginId).state, 'identified');
  });

  it('a node outage → 503 W3A_LOOKUP_UNAVAILABLE (fail closed), nothing written; a retry succeeds', async () => {
    const identified = await identify(email('ada@example.com'));
    nodesDown = true;
    const res = await completeWith(identified);
    expectCode(res, 503, 'W3A_LOOKUP_UNAVAILABLE');
    assert.equal(res.body.status, 'error');
    assert.equal(prisma.user.rows.length, 0);
    nodesDown = false;
    assert.equal((await completeWith(identified)).status, 201);
  });

  it('an expired attempt or a wrong loginSecret → LOGIN_EXPIRED', async () => {
    const identified = await identify(email('ada@example.com'));
    expectCode(await completeWith({ ...identified, loginSecret: crypto.randomBytes(32).toString('base64url') }), 400, 'LOGIN_EXPIRED');
    attemptRow(identified.loginId).expiresAt = new Date(Date.now() - 1);
    expectCode(await completeWith(identified), 400, 'LOGIN_EXPIRED');
  });
});

// ---------------------------------------------------------------------------------------------
describe('POST /complete: existing accounts and the wallet rule', () => {
  it('a legacy e-mail account without a wallet is linked and bound (linkedVia legacy_email)', async () => {
    const legacy = addUser({ email: 'ada@example.com', web3authVerifier: LEGACY_EMAIL, web3authVerifierId: 'ada@example.com', name: 'Ada' });
    const { identified, res } = await signIn(email('ada@example.com'));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.isNewUser, false);
    assert.equal(res.body.data.user.id, legacy.id);
    assert.equal(res.body.data.user.walletAddress, walletFor(identified.web3auth.verifierId).address);
    assert.equal(res.body.data.user.web3authVerifier, LEGACY_EMAIL, 'the legacy pair is kept');
    assert.equal(prisma.authIdentity.rows[0].linkedVia, 'legacy_email');
    assert.equal(prisma.nativeWalletBinding.rows[0].userId, legacy.id);
    assert.ok(logs.some((l) => l.message === 'native_auth.complete' && l.meta.walletAction === 'bound'));
  });

  it('refuse (default): a legacy account with another wallet → 409 WALLET_REBIND_REQUIRED and NOTHING is written', async () => {
    addUser({ email: 'ada@example.com', web3authVerifier: LEGACY_EMAIL, web3authVerifierId: 'ada@example.com', walletAddress: Wallet.createRandom().address });
    const identified = await identify(email('ada@example.com'));
    const before = tables();
    expectCode(await completeWith(identified), 409, 'WALLET_REBIND_REQUIRED');
    assert.equal(tables(), before, 'not even the identity');
    assert.equal(attemptRow(identified.loginId).state, 'identified');
    assert.ok(logs.some((l) => l.message === 'native_auth.rebind_refused'));
  });

  it('lazy (local only): history, the web3auth_legacy identity, the new identity, the binding and the new wallet', async () => {
    envOverrides = { DDC_AUTH_REBIND_POLICY: 'lazy' };
    const oldAddress = Wallet.createRandom().address;
    const legacy = addUser({ email: 'ada@example.com', web3authVerifier: LEGACY_EMAIL, web3authVerifierId: 'ada@example.com', walletAddress: oldAddress });
    const { identified, res } = await signIn(email('ada@example.com'));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const newAddress = walletFor(identified.web3auth.verifierId).address;
    assert.equal(res.body.data.user.walletAddress, newAddress);
    const [history] = prisma.walletAddressHistory.rows;
    assert.equal(history.userId, legacy.id);
    assert.equal(history.oldAddress, oldAddress);
    assert.equal(history.oldVerifier, LEGACY_EMAIL);
    assert.equal(history.oldNetwork, 'sapphire_devnet');
    assert.equal(history.newAddress, newAddress);
    assert.equal(history.reason, 'native_login_rebind');
    assert.equal(history.status, 'applied');
    assert.equal(history.chainStatus, 'pending');
    assert.equal(history.newSubjectRef, prisma.nativeWalletBinding.rows[0].id, 'a reference, never the subject (F11)');
    const providers = prisma.authIdentity.rows.map((r) => `${r.provider}:${r.subject}`).sort();
    assert.deepEqual(providers, ['email:ada@example.com', `web3auth_legacy:${LEGACY_EMAIL}|ada@example.com`]);
    assert.ok(logs.some((l) => l.message === 'native_auth.wallet_rebound' && l.level === 'warn'));

    // A later legacy login of that user still signs in (pair hit) and logs the rebind.
    const identityService = require('../../src/services/web3authIdentity');
    const legacyIdentity = { kind: 'social', verifier: LEGACY_EMAIL, verifierId: 'ada@example.com', email: 'ada@example.com', wallets: [] };
    const resolved = await identityService.resolveUser(legacyIdentity, { db: prisma });
    assert.equal(resolved.user.id, legacy.id);
    assert.ok(logs.some((l) => l.message === 'legacy_login_wallet_rebound' && l.meta.userId === legacy.id));
  });

  it('a binding whose address differs from what the nodes now derive → WALLET_MISMATCH', async () => {
    const { identified, res } = await signIn(email('ada@example.com'));
    assert.equal(res.status, 201);
    prisma.nativeWalletBinding.rows[0].address = Wallet.createRandom().address;
    const again = await identify(email('ada@example.com'));
    assert.equal(again.web3auth.verifierId, identified.web3auth.verifierId);
    expectCode(await completeWith(again), 409, 'WALLET_MISMATCH');
    assert.ok(logs.some((l) => l.message === 'native_auth.wallet_mismatch' && l.level === 'error'));
  });

  it('WALLET_IN_USE when another account holds the derived address', async () => {
    const identified = await identify(email('ada@example.com'));
    addUser({ walletAddress: walletFor(identified.web3auth.verifierId).address.toLowerCase() });
    expectCode(await completeWith(identified), 400, 'WALLET_IN_USE');
  });

  it('guardAccount runs at /complete (F21)', async () => {
    const legacy = addUser({ email: 'ada@example.com', web3authVerifier: LEGACY_EMAIL, web3authVerifierId: 'ada@example.com' });
    const identified = await identify(email('ada@example.com'));
    legacy.userType = 'organization';
    expectCode(await completeWith(identified), 403, 'ORG_NOT_ALLOWED');
  });

  it('a legacy X account links through its pair and gets its xid when free', async () => {
    const legacy = addUser({ email: 'twitter|77', web3authVerifier: LEGACY_X, web3authVerifierId: 'twitter|77' });
    const { res } = await signIn(x('77'));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.user.id, legacy.id);
    assert.equal(res.body.data.user.xid, '77');
    assert.equal(prisma.authIdentity.rows[0].linkedVia, 'legacy_x');
  });
});

// ---------------------------------------------------------------------------------------------
describe('races → LOGIN_RACE', () => {
  it('every P2002 in the transaction → 409 LOGIN_RACE and the attempt is reset', async () => {
    const identified = await identify(email('ada@example.com'));
    const original = prisma.nativeWalletBinding.create;
    prisma.nativeWalletBinding.create = async () => {
      throw uniqueViolation('nativeWalletBinding', ['subject']);
    };
    try {
      expectCode(await completeWith(identified), 409, 'LOGIN_RACE');
    } finally {
      prisma.nativeWalletBinding.create = original;
    }
    assert.equal(attemptRow(identified.loginId).state, 'identified');
    assert.ok(logs.some((l) => l.message === 'native_auth.login_race'));
  });

  it('a user-row unique clash (e-mail taken meanwhile by a password sign-up) → LOGIN_RACE', async () => {
    const identified = await identify(email('ada@example.com'));
    // The row appears between identify and /complete; the re-resolution sees a changed account.
    addUser({ email: 'ada@example.com', authType: 'traditional' });
    expectCode(await completeWith(identified), 409, 'LOGIN_RACE');
    // The client re-identifies once and gets the separate (shadow) account.
    const retry = await identify(email('ada@example.com'));
    assert.equal(retry.account.status, 'new');
    assert.equal((await completeWith(retry)).status, 201);
  });

  it('two attempts for one new identity: the second completion is a race, then an existing sign-in', async () => {
    const a = await identify(email('ada@example.com'));
    const b = await identify(email('ada@example.com'));
    assert.equal((await completeWith(a)).status, 201);
    expectCode(await completeWith(b), 409, 'LOGIN_RACE');
    const c = await identify(email('ada@example.com'));
    assert.equal(c.account.status, 'existing');
    assert.equal((await completeWith(c)).status, 200);
  });

  it('two concurrent /complete calls for one attempt: exactly one wins', async () => {
    const identified = await identify(email('ada@example.com'));
    const [r1, r2] = await Promise.all([completeWith(identified), completeWith(identified)]);
    const statuses = [r1.status, r2.status].sort();
    assert.deepEqual(statuses, [201, 400]);
    assert.equal(prisma.user.rows.length, 1);
  });
});

// ---------------------------------------------------------------------------------------------
describe('referral parity with web3auth-login', () => {
  it('a new account with a valid code: referral row, settlement and REFERRAL_SUCCESSFUL', async () => {
    const inviter = addUser({ referralCode: 'IVY222' });
    const { res } = await signIn(email('ada@example.com'), { referralCode: 'IVY222' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.deepEqual(res.body.data.invitationStatus, { success: true, code: 'REFERRAL_SUCCESSFUL', message: 'Successfully registered with referral code' });
    const created = res.body.data.user;
    assert.deepEqual(prisma.referral.rows.map((r) => [r.inviterId, r.inviteeId, r.code]), [[inviter.id, created.id, 'IVY222']]);
    assert.deepEqual(settled, [{ inviteeId: created.id, inviterId: inviter.id, code: 'IVY222' }]);
    assert.deepEqual(Object.keys(res.body.data).sort(), ['invitationStatus', 'isNewUser', 'token', 'user']);
  });

  it('a new account with an unknown code is refused exactly as web3auth-login refuses it (404 INVALID_CODE), nothing created', async () => {
    const identified = await identify(email('ada@example.com'));
    const res = await completeWith(identified, { referralCode: 'NOPE99' });
    assert.equal(res.status, 404);
    assert.equal(res.body.status, 'fail');
    assert.equal(res.body.code, 'INVALID_CODE');
    assert.equal(prisma.user.rows.length, 0);
    assert.equal(attemptRow(identified.loginId).state, 'identified');
  });

  it('a new account with an unusable campaign is refused (INVALID_CAMPAIGN)', async () => {
    addUser({ referralCode: 'IVY222' });
    const identified = await identify(email('ada@example.com'));
    const res = await completeWith(identified, { referralCode: 'IVY222', referralCampaign: 'no-such-campaign' });
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(res.body.code, 'INVALID_CAMPAIGN');
  });

  it('an existing account with a code that cannot be applied still signs in (ALREADY_REFERRED)', async () => {
    const inviter = addUser({ referralCode: 'IVY222' });
    const other = addUser({ referralCode: 'OTTO33' });
    const { res } = await signIn(email('ada@example.com'));
    const userId = res.body.data.user.id;
    prisma.referral.rows.push({ id: 'ref-1', inviterId: inviter.id, inviteeId: userId, code: 'IVY222', createdAt: new Date() });
    const again = await signIn(email('ada@example.com'), { referralCode: other.referralCode });
    assert.equal(again.res.status, 200, JSON.stringify(again.res.body));
    assert.equal(again.res.body.data.invitationStatus.code, 'ALREADY_REFERRED');
    assert.equal(again.res.body.data.invitationStatus.success, false);
  });

  it('an existing account without a referrer gets the code bound late', async () => {
    const inviter = addUser({ referralCode: 'IVY222' });
    const { res } = await signIn(email('ada@example.com'));
    const again = await signIn(email('ada@example.com'), { referralCode: 'IVY222' });
    assert.equal(again.res.status, 200, JSON.stringify(again.res.body));
    assert.equal(again.res.body.data.invitationStatus.code, 'REFERRAL_SUCCESSFUL');
    assert.equal(prisma.referral.rows.find((r) => r.inviteeId === res.body.data.user.id).inviterId, inviter.id);
  });
});

// ---------------------------------------------------------------------------------------------
describe('secrets never reach a log (F3, F11, F17)', () => {
  it('no loginId, loginSecret, subject, token or signature in any log line', async () => {
    const identified = await identify(email('ada@example.com'));
    await token(identified);
    const res = await completeWith(identified);
    assert.equal(res.status, 201);
    const proof = await proofFor(identified);
    const text = JSON.stringify(logs);
    for (const secret of [identified.loginId, identified.loginSecret, identified.web3auth.verifierId, identified.web3auth.idToken, proof.signature, res.body.data.token]) {
      assert.ok(!text.includes(secret), 'a secret reached the log');
    }
    assert.ok(logs.some((l) => l.message === 'native_auth.complete' && /^[0-9a-f]{16}$/.test(l.meta.loginRef)));
  });
});

describe('contract', () => {
  it('every code these modules emit is in the §2.2 table', () => {
    const files = ['services/nativeAuth/accounts.js', 'services/nativeAuth/identify.js', 'services/nativeAuth/complete.js', 'services/nativeAuth/w3aLookup.js', 'controllers/nativeAuth/completeController.js'];
    const emitted = new Set();
    for (const file of files) {
      const text = fs.readFileSync(path.join(__dirname, '../../src', file), 'utf8');
      for (const m of text.matchAll(/NativeAuthError\('([A-Z0-9_]+)'/g)) emitted.add(m[1]);
    }
    const missing = [...emitted].filter((code) => !(code in NATIVE_ERROR_CODES));
    assert.deepEqual(missing, []);
    for (const code of ['LOGIN_EXPIRED', 'LOGIN_TOKEN_LIMIT', 'WALLET_PROOF_INVALID', 'WALLET_NOT_DERIVED', 'W3A_LOOKUP_UNAVAILABLE', 'WALLET_REBIND_REQUIRED', 'WALLET_MISMATCH', 'WALLET_IN_USE', 'LOGIN_RACE', 'ACCOUNT_LINK_REQUIRED', 'NEW_ACCOUNTS_CLOSED', 'ACCOUNT_DISABLED', 'ORG_NOT_ALLOWED']) {
      assert.ok(emitted.has(code), `${code} is emitted`);
    }
    assert.deepEqual(complete.TOKEN_REASONS, ['duplicate_token', 'timesigned', 'expired', 'network']);
  });
});

// ---------------------------------------------------------------------------------------------
describe('through the real router (flag on)', () => {
  let routerServer;
  before(async () => {
    const router = require('../../src/routes/nativeAuthRoutes');
    const routed = express();
    routed.set('trust proxy', 1);
    routed.use(express.json());
    routed.use('/api/auth/native', router);
    routerServer = await listenLoopback(routed);
  });
  after(() => routerServer.close());

  it('/token and /complete answer no-store in the native envelope', async () => {
    const identified = await identify(email('ada@example.com'));
    const t = await request(routerServer).post('/api/auth/native/token').set('X-Forwarded-For', '203.0.113.7').send({ loginId: identified.loginId, loginSecret: identified.loginSecret, reason: 'expired' });
    assert.equal(t.status, 200, JSON.stringify(t.body));
    assert.equal(t.headers['cache-control'], 'no-store');
    assert.equal(t.body.status, 'success');
    const proof = await proofFor(identified);
    const c = await request(routerServer).post('/api/auth/native/complete').set('X-Forwarded-For', '203.0.113.7').send({ loginId: identified.loginId, loginSecret: identified.loginSecret, ...proof });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    assert.equal(c.headers['cache-control'], 'no-store');
    assert.equal(c.body.data.isNewUser, true);
  });

  it('with DDC_AUTH_ENABLED off both answer 404 NATIVE_AUTH_DISABLED and touch nothing', async () => {
    const saved = process.env.DDC_AUTH_ENABLED;
    delete process.env.DDC_AUTH_ENABLED;
    try {
      for (const p of ['/api/auth/native/token', '/api/auth/native/complete']) {
        const res = await request(routerServer).post(p).set('X-Forwarded-For', '203.0.113.8').send({});
        assert.equal(res.status, 404);
        assert.equal(res.body.code, 'NATIVE_AUTH_DISABLED');
      }
      assert.equal(prisma.authLoginAttempt.rows.length, 0);
    } finally {
      process.env.DDC_AUTH_ENABLED = saved;
    }
  });
});

describe('loadAttempt for other packages (BE7 link)', () => {
  it("verifies a link attempt's secret only with intent 'link'", async () => {
    const user = addUser();
    const link = await identify(google('ada@gmail.com'), { intent: 'link', bearerUser: user });
    const row = await complete.loadAttempt({ loginId: link.loginId, loginSecret: link.loginSecret, intent: 'link', db: prisma, cfg: cfg() });
    assert.equal(row.userId, user.id);
    await assert.rejects(complete.loadAttempt({ loginId: link.loginId, loginSecret: link.loginSecret, db: prisma, cfg: cfg() }), (err) => err.code === 'LOGIN_EXPIRED');
    await assert.rejects(
      complete.loadAttempt({ loginId: link.loginId, loginSecret: crypto.randomBytes(32).toString('base64url'), intent: 'link', db: prisma, cfg: cfg() }),
      (err) => err.code === 'LOGIN_EXPIRED',
    );
  });
});
