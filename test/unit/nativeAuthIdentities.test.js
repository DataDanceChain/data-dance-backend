/**
 * Identities list / link / unlink with the step-up and the notices (design §2.1 #12–15, §3.8;
 * F2, D4, D9): the link attempt is verified with complete.loadAttempt({intent: 'link'}) and must
 * belong to the session; an identity linked anywhere is refused; the step-up is a signature by the
 * account's CURRENT wallet over a single-use challenge naming the action and the target (or, for a
 * wallet-less account, a fresh identify of an already-linked method); the last method is never
 * removed; every change mails the strong addresses; nothing mints a Web3Auth JWT from a session.
 *
 * In-memory Prisma with unique checks; nodemailer is a recorder; wallets are random local keys.
 */
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');
const { Wallet } = require('ethers');

const { makeKeyFile, localEnv } = require('../helpers/nativeAuthKeys');

const key = makeKeyFile();
const LEGACY_EMAIL = 'web3auth-auth0-email-passwordless-sapphire-devnet';
const BASE_ENV = localEnv(key, {
  DDC_AUTH_METHODS: 'email,google,apple,x',
  DDC_AUTH_NEW_ACCOUNTS: 'open',
  DDC_AUTH_LEGACY_EMAIL_VERIFIERS: LEGACY_EMAIL,
  SMTP_HOST: '127.0.0.1',
  SMTP_PORT: '1025',
  DDC_AUTH_EMAIL_FROM: 'DataDance <no-reply@datadance.test>',
});
Object.assign(process.env, BASE_ENV, { NODE_ENV: 'test', LOG_LEVEL: 'error' });

// nodemailer → a recorder (installed before src/utils/email.js loads it).
const mails = [];
let mailFailure = null;
require.cache[require.resolve('nodemailer')] = {
  id: require.resolve('nodemailer'),
  filename: require.resolve('nodemailer'),
  loaded: true,
  exports: {
    createTransport: () => ({
      sendMail: async (message) => {
        if (mailFailure) throw mailFailure;
        mails.push(message);
        return { messageId: `m${mails.length}` };
      },
    }),
  },
};

const { installMockPrisma } = require('../helpers/mockPrisma');

const prisma = installMockPrisma({ enforceUnique: true });

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
const identities = require('../../src/services/nativeAuth/identities');
const notify = require('../../src/services/nativeAuth/notify');
const { buildProofMessage } = require('../../src/services/nativeAuth/proofMessage');
const identitiesController = require('../../src/controllers/nativeAuth/identitiesController');
const { NATIVE_ERROR_CODES } = require('../../src/controllers/nativeAuth/respond');
const { listenLoopback } = require('../helpers/loopbackServer');

const cfg = () => config.readNativeAuthConfig(BASE_ENV);

// ---------------------------------------------------------------------------------------------
// App: the real controller behind a stand-in for `protect` (x-user header → req.user).
// ---------------------------------------------------------------------------------------------
const app = express();
app.use(express.json());
app.use(async (req, res, next) => {
  req.nativeAuthConfig = cfg();
  const id = req.get('x-user');
  if (!id) return res.status(401).json({ status: 'fail', message: 'Authentication required.' });
  req.user = await prisma.user.findUnique({ where: { id } });
  if (!req.user) return res.status(401).json({ status: 'fail' });
  return next();
});
app.post('/identities/challenge', identitiesController.challenge);
app.get('/identities', identitiesController.list);
app.post('/identities/link', identitiesController.link);
app.delete('/identities/:id', identitiesController.unlink);
app.use((err, req, res, next) => res.status(500).json({ status: 'error', message: 'internal' }));

let server;
before(async () => {
  server = await listenLoopback(app);
});
after(() => server.close());

beforeEach(() => {
  prisma.reset();
  mails.length = 0;
  logs.length = 0;
  mailFailure = null;
});

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------
let seq = 0;
async function makeUser({ wallet = Wallet.createRandom(), email, password = null, web3authVerifier = 'ddc-jwt-devnet', web3authVerifierId } = {}) {
  seq += 1;
  const id = `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`;
  const user = await prisma.user.create({
    data: {
      id,
      email: email || `email|${id}`,
      name: `User ${seq}`,
      walletAddress: wallet ? wallet.address : null,
      authType: wallet ? 'web3auth' : 'traditional',
      userType: 'regular',
      password,
      web3authVerifier: wallet ? web3authVerifier : null,
      web3authVerifierId: wallet ? web3authVerifierId || id : null,
      disabledAt: null,
    },
  });
  return { user, wallet };
}

async function addIdentity(userId, { provider = 'email', subject, email, grade, linkedVia = 'created', createdAt } = {}) {
  const addr = email === undefined ? (provider === 'email' ? subject : null) : email;
  return prisma.authIdentity.create({
    data: {
      userId,
      provider,
      subject,
      email: addr,
      emailLinkGrade: grade || (provider === 'email' ? 'strong' : 'none'),
      isPrivateRelay: false,
      linkedVia,
      ...(createdAt && { createdAt }),
    },
  });
}

const email = (address) => ({ provider: 'email', subject: address, email: address, emailVerified: true });
const google = (address, extra = {}) => ({ provider: 'google', subject: `g-${address}`, email: address, emailVerified: true, ...extra });
const apple = (address) => ({ provider: 'apple', subject: `a-${address}`, email: address, emailVerified: true, isPrivateRelay: true });
const x = (id) => ({ provider: 'x', subject: id, profile: { xUsername: `h${id}` } });

async function linkAttempt(user, identity) {
  return createLoginAttempt({ identity, intent: 'link', bearerUser: user, cfg: cfg(), db: prisma });
}

const as = (user) => ({ 'x-user': user.id });

async function challenge(user, body) {
  return request(server).post('/identities/challenge').set(as(user)).send(body);
}

async function sign(wallet, stepUp) {
  return wallet.signMessage(buildProofMessage(stepUp, wallet.address));
}

/** Ask for the link challenge, sign it, link. */
async function linkWithWallet(user, wallet, identified, extra = {}) {
  const ch = await challenge(user, { action: 'link', loginId: identified.loginId });
  assert.equal(ch.status, 200, JSON.stringify(ch.body));
  const stepUpSignature = await sign(wallet, ch.body.data.stepUp);
  return request(server)
    .post('/identities/link')
    .set(as(user))
    .send({ loginId: identified.loginId, loginSecret: identified.loginSecret, stepUpSignature, ...extra });
}

async function unlinkWithWallet(user, wallet, identityId) {
  const ch = await challenge(user, { action: 'unlink', identityId });
  if (ch.status !== 200) return ch;
  const stepUpSignature = await sign(wallet, ch.body.data.stepUp);
  return request(server).delete(`/identities/${identityId}`).set(as(user)).send({ stepUpSignature });
}

/** Controller notices are not awaited by the request; let them run. */
async function flushNotices() {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function assertNoSecretsLogged(secrets) {
  const text = JSON.stringify(logs);
  for (const secret of secrets.filter(Boolean)) assert.equal(text.includes(secret), false, 'a secret reached a log line');
}

// ---------------------------------------------------------------------------------------------
// F2 / D4: no Web3Auth JWT from a DDC session
// ---------------------------------------------------------------------------------------------
describe('F2: a session never yields a Web3Auth JWT', () => {
  it('a link attempt carries no web3auth block, no wallet proof, no subject', async () => {
    const { user } = await makeUser();
    const identified = await linkAttempt(user, google('a@gmail.com'));
    assert.deepEqual(Object.keys(identified).sort(), ['account', 'expiresAt', 'loginId', 'loginSecret']);
    const row = prisma.authLoginAttempt.rows.find((r) => r.id === identified.loginId);
    assert.equal(row.w3aSubject, null);
    assert.equal(row.walletProof, null);
    assert.equal(row.w3aTokenCount, 0);
  });

  it('/token and /complete refuse a link attempt; loadAttempt refuses a login attempt as a link', async () => {
    const { user } = await makeUser();
    const link = await linkAttempt(user, google('b@gmail.com'));
    await assert.rejects(
      complete.reissueToken({ loginId: link.loginId, loginSecret: link.loginSecret, reason: 'expired', db: prisma, cfg: cfg() }),
      { code: 'LOGIN_EXPIRED' },
    );
    await assert.rejects(
      complete.completeLogin({ body: { loginId: link.loginId, loginSecret: link.loginSecret, walletAddress: user.walletAddress, signature: `0x${'1'.repeat(130)}` }, db: prisma, cfg: cfg() }),
      { code: 'LOGIN_EXPIRED' },
    );
    const login = await createLoginAttempt({ identity: email('login@example.com'), cfg: cfg(), db: prisma });
    await assert.rejects(
      complete.loadAttempt({ loginId: login.loginId, loginSecret: login.loginSecret, intent: 'link', db: prisma, cfg: cfg() }),
      { code: 'LOGIN_EXPIRED' },
      'an intent:login attempt must never pass as a link attempt',
    );
    // …and it cannot be used to link either.
    const res = await request(server).post('/identities/link').set(as(user)).send({ loginId: login.loginId, loginSecret: login.loginSecret, stepUpSignature: `0x${'1'.repeat(130)}` });
    assert.equal(res.body.code, 'LOGIN_EXPIRED');
  });

  it('only identify.js and complete.js call the issuer; the identities modules do not even load it', () => {
    const root = path.join(__dirname, '../../src');
    const minters = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(file);
        else if (entry.name.endsWith('.js') && /issueW3aToken\s*\(/.test(fs.readFileSync(file, 'utf8'))) minters.push(path.relative(root, file));
      }
    };
    walk(root);
    assert.deepEqual(minters.sort(), ['services/nativeAuth/complete.js', 'services/nativeAuth/identify.js', 'services/nativeAuth/issuer.js'].sort());
    for (const file of ['services/nativeAuth/identities.js', 'services/nativeAuth/notify.js', 'controllers/nativeAuth/identitiesController.js']) {
      assert.doesNotMatch(fs.readFileSync(path.join(root, file), 'utf8'), /require\(['"][^'"]*issuer['"]\)|issueW3aToken|\bidToken\b/, file);
    }
  });

  it('no identities response carries a token or a subject', async () => {
    const { user, wallet } = await makeUser();
    await addIdentity(user.id, { provider: 'email', subject: 'own@example.com' });
    const identified = await linkAttempt(user, google('c@gmail.com'));
    const linked = await linkWithWallet(user, wallet, identified);
    const listed = await request(server).get('/identities').set(as(user));
    for (const body of [linked.body, listed.body]) {
      const text = JSON.stringify(body);
      assert.doesNotMatch(text, /idToken|eyJ|web3auth|g-c@gmail\.com|verifierId/);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// GET /identities
// ---------------------------------------------------------------------------------------------
describe('GET /identities', () => {
  it('lists the account’s methods, oldest first, masked, without subjects or internal rows', async () => {
    const { user } = await makeUser();
    const other = await makeUser();
    await addIdentity(user.id, { provider: 'google', subject: 'g-sub-1', email: 'alice@gmail.com', grade: 'strong', createdAt: new Date('2026-09-02T00:00:00Z') });
    await addIdentity(user.id, { provider: 'email', subject: 'alice@example.com', createdAt: new Date('2026-09-01T00:00:00Z') });
    await addIdentity(user.id, { provider: 'x', subject: '12345', createdAt: new Date('2026-09-03T00:00:00Z') });
    await addIdentity(user.id, { provider: 'web3auth_legacy', subject: `${LEGACY_EMAIL}|alice@example.com`, linkedVia: 'lazy_rebind' });
    await addIdentity(other.user.id, { provider: 'email', subject: 'bob@example.com' });

    const res = await request(server).get('/identities').set(as(user));
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'success');
    assert.deepEqual(res.body.data.map((r) => r.provider), ['email', 'google', 'x']);
    assert.deepEqual(Object.keys(res.body.data[0]).sort(), ['createdAt', 'emailMasked', 'id', 'lastLoginAt', 'linkedVia', 'provider']);
    assert.equal(res.body.data[0].emailMasked, 'al***@example.com');
    assert.equal(res.body.data[1].emailMasked, 'al***@gmail.com');
    assert.equal(res.body.data[2].emailMasked, null);
    assert.equal(res.body.data[0].createdAt, '2026-09-01T00:00:00.000Z');
    assert.doesNotMatch(JSON.stringify(res.body), /g-sub-1|12345|alice@|bob/);
  });
});

// ---------------------------------------------------------------------------------------------
// Link
// ---------------------------------------------------------------------------------------------
describe('POST /identities/challenge + /identities/link (wallet step-up)', () => {
  it('the challenge names the action and the target; the current wallet’s signature links it', async () => {
    const { user, wallet } = await makeUser();
    await addIdentity(user.id, { provider: 'email', subject: 'me@example.com' });
    const identified = await linkAttempt(user, google('me.too@gmail.com'));

    const ch = await challenge(user, { action: 'link', loginId: identified.loginId });
    assert.equal(ch.status, 200, JSON.stringify(ch.body));
    assert.equal(ch.body.data.mode, 'wallet');
    const { stepUp } = ch.body.data;
    assert.deepEqual(Object.keys(stepUp).sort(), ['chainId', 'domain', 'expirationTime', 'issuedAt', 'nonce', 'requestId', 'statement', 'uri']);
    assert.equal(stepUp.domain, 'localhost:20444');
    assert.equal(stepUp.chainId, 44508);
    assert.match(stepUp.statement, /^Add Google \(me\*\*\*@gmail\.com\) as a sign-in method/);
    assert.equal(stepUp.requestId, config.loginRef(identified.loginId, cfg()));
    assert.equal(new Date(stepUp.expirationTime) - new Date(stepUp.issuedAt), 300000);
    // The stored challenge holds only a hash of its key; the nonce is in the proof, not a lookup key.
    const flow = prisma.authFlowState.rows.find((r) => r.kind === 'step_up');
    assert.ok(flow.valueHash && !flow.valueHash.includes(user.id));

    const res = await request(server)
      .post('/identities/link')
      .set(as(user))
      .send({ loginId: identified.loginId, loginSecret: identified.loginSecret, stepUpSignature: await sign(wallet, stepUp) });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.identity.provider, 'google');
    assert.equal(res.body.data.identity.linkedVia, 'manual');
    assert.equal(res.body.data.identity.emailMasked, 'me***@gmail.com');

    const row = prisma.authIdentity.rows.find((r) => r.provider === 'google');
    assert.equal(row.userId, user.id);
    assert.equal(row.subject, 'g-me.too@gmail.com');
    assert.equal(row.email, 'me.too@gmail.com');
    assert.equal(row.emailLinkGrade, 'strong');
    assert.equal(row.isPrivateRelay, false);
    const attempt = prisma.authLoginAttempt.rows.find((r) => r.id === identified.loginId);
    assert.equal(attempt.state, 'completed');
    assert.ok(attempt.completedAt instanceof Date);
    assert.ok(prisma.authFlowState.rows.find((r) => r.kind === 'step_up').consumedAt, 'the challenge is spent');
    assert.ok(prisma.rawStatements.some((s) => /pg_advisory_xact_lock/.test(s.sql)));
    assert.ok(logs.some((l) => l.message === 'native_auth.identity_linked' && l.meta.provider === 'google' && l.meta.stepUp === 'wallet'));
    assertNoSecretsLogged([identified.loginId, identified.loginSecret, 'g-me.too@gmail.com', 'me.too@gmail.com', user.walletAddress]);
  });

  it('keeps the attempt’s grade and relay flag (Apple relay → weak, relay)', async () => {
    const { user, wallet } = await makeUser();
    await addIdentity(user.id, { provider: 'email', subject: 'p@example.com' });
    const identified = await linkAttempt(user, apple('xyz@privaterelay.appleid.com'));
    const res = await linkWithWallet(user, wallet, identified);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const row = prisma.authIdentity.rows.find((r) => r.provider === 'apple');
    assert.equal(row.emailLinkGrade, 'weak');
    assert.equal(row.isPrivateRelay, true);
  });

  it('no signature → 401 STEP_UP_REQUIRED; nothing written', async () => {
    const { user } = await makeUser();
    const identified = await linkAttempt(user, x('777'));
    await challenge(user, { action: 'link', loginId: identified.loginId });
    const res = await request(server).post('/identities/link').set(as(user)).send({ loginId: identified.loginId, loginSecret: identified.loginSecret });
    assert.equal(res.status, 401);
    assert.equal(res.body.code, 'STEP_UP_REQUIRED');
    assert.equal(res.body.data.mode, 'wallet');
    assert.equal(prisma.authIdentity.rows.length, 0);
    assert.equal(prisma.authLoginAttempt.rows[0].state, 'identified');
  });

  it('a signature by another wallet, over another challenge, replayed or expired → STEP_UP_INVALID', async () => {
    const { user, wallet } = await makeUser();
    await addIdentity(user.id, { provider: 'email', subject: 'q@example.com' });
    const identified = await linkAttempt(user, x('888'));
    const send = (stepUpSignature) =>
      request(server).post('/identities/link').set(as(user)).send({ loginId: identified.loginId, loginSecret: identified.loginSecret, stepUpSignature });

    // Another wallet signs the right challenge.
    const ch = await challenge(user, { action: 'link', loginId: identified.loginId });
    const intruder = Wallet.createRandom();
    const foreign = await intruder.signMessage(buildProofMessage(ch.body.data.stepUp, user.walletAddress));
    let res = await send(foreign);
    assert.equal(res.status, 401);
    assert.equal(res.body.code, 'STEP_UP_INVALID');
    assert.ok(logs.some((l) => l.message === 'native_auth.step_up_failed'));

    // The right wallet signs an unlink challenge (another action / target).
    const own = prisma.authIdentity.rows[0];
    const other = await challenge(user, { action: 'unlink', identityId: own.id });
    assert.equal(other.status, 409, 'q@example.com is the only method');
    res = await send(await sign(wallet, { ...ch.body.data.stepUp, statement: 'Remove everything.' }));
    assert.equal(res.body.code, 'STEP_UP_INVALID', 'a message other than the issued one');

    // Malformed.
    res = await send('0x1234');
    assert.equal(res.body.code, 'STEP_UP_INVALID');

    // Expired.
    const flow = prisma.authFlowState.rows.find((r) => r.kind === 'step_up');
    const good = await sign(wallet, ch.body.data.stepUp);
    flow.expiresAt = new Date(Date.now() - 1000);
    res = await send(good);
    assert.equal(res.body.code, 'STEP_UP_INVALID');
    assert.equal(res.body.data.reason, 'challenge');

    // Fresh challenge → links once; the same signature cannot be replayed.
    const again = await challenge(user, { action: 'link', loginId: identified.loginId });
    assert.equal(prisma.authFlowState.rows.filter((r) => r.kind === 'step_up').length, 1, 'a new challenge replaces the old one');
    const sig = await sign(wallet, again.body.data.stepUp);
    res = await send(sig);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    res = await send(sig);
    assert.equal(res.body.code, 'LOGIN_EXPIRED', 'the attempt is spent too');
    assert.equal(prisma.authIdentity.rows.filter((r) => r.provider === 'x').length, 1);
  });

  it('a wallet changed since the challenge → STEP_UP_INVALID', async () => {
    const { user, wallet } = await makeUser();
    const identified = await linkAttempt(user, x('999'));
    const ch = await challenge(user, { action: 'link', loginId: identified.loginId });
    const sig = await sign(wallet, ch.body.data.stepUp);
    const next = Wallet.createRandom();
    prisma.user.rows.find((r) => r.id === user.id).walletAddress = next.address;
    const res = await request(server).post('/identities/link').set(as(user)).send({ loginId: identified.loginId, loginSecret: identified.loginSecret, stepUpSignature: sig });
    assert.equal(res.body.code, 'STEP_UP_INVALID');
  });

  it('another user’s link attempt, a wrong secret, an expired attempt → LOGIN_EXPIRED', async () => {
    const alice = await makeUser();
    const bob = await makeUser();
    const identified = await linkAttempt(alice.user, x('1001'));

    let ch = await challenge(bob.user, { action: 'link', loginId: identified.loginId });
    assert.equal(ch.body.code, 'LOGIN_EXPIRED', 'bob cannot even ask for a challenge on alice’s attempt');
    let res = await request(server).post('/identities/link').set(as(bob.user)).send({ loginId: identified.loginId, loginSecret: identified.loginSecret, stepUpSignature: `0x${'1'.repeat(130)}` });
    assert.equal(res.body.code, 'LOGIN_EXPIRED');

    res = await request(server).post('/identities/link').set(as(alice.user)).send({ loginId: identified.loginId, loginSecret: 'A'.repeat(43), stepUpSignature: `0x${'1'.repeat(130)}` });
    assert.equal(res.body.code, 'LOGIN_EXPIRED');

    prisma.authLoginAttempt.rows[0].expiresAt = new Date(Date.now() - 1);
    ch = await challenge(alice.user, { action: 'link', loginId: identified.loginId });
    assert.equal(ch.body.code, 'LOGIN_EXPIRED');
    assert.equal(prisma.authIdentity.rows.length, 0);
  });

  it('an identity already linked (to anyone) → 409 IDENTITY_ALREADY_LINKED, at challenge and at link', async () => {
    const alice = await makeUser();
    const bob = await makeUser();
    await addIdentity(bob.user.id, { provider: 'x', subject: '2002' });
    const identified = await linkAttempt(alice.user, x('2002'));
    const ch = await challenge(alice.user, { action: 'link', loginId: identified.loginId });
    assert.equal(ch.status, 409);
    assert.equal(ch.body.code, 'IDENTITY_ALREADY_LINKED');

    // Linked between the challenge and the link call.
    const second = await linkAttempt(alice.user, x('3003'));
    const ch2 = await challenge(alice.user, { action: 'link', loginId: second.loginId });
    await addIdentity(bob.user.id, { provider: 'x', subject: '3003' });
    const res = await request(server)
      .post('/identities/link')
      .set(as(alice.user))
      .send({ loginId: second.loginId, loginSecret: second.loginSecret, stepUpSignature: await sign(alice.wallet, ch2.body.data.stepUp) });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'IDENTITY_ALREADY_LINKED');
    assert.equal(prisma.authIdentity.rows.filter((r) => r.subject === '3003').length, 1);
  });

  it('a unique-constraint race at insert → IDENTITY_ALREADY_LINKED and the attempt is put back', async () => {
    const { user, wallet } = await makeUser();
    const identified = await linkAttempt(user, x('4004'));
    const ch = await challenge(user, { action: 'link', loginId: identified.loginId });
    const sig = await sign(wallet, ch.body.data.stepUp);
    const realCreate = prisma.authIdentity.create;
    prisma.authIdentity.create = async (args) => {
      await realCreate({ data: { ...args.data, userId: 'someone-else' } });
      return realCreate(args);
    };
    try {
      const res = await request(server).post('/identities/link').set(as(user)).send({ loginId: identified.loginId, loginSecret: identified.loginSecret, stepUpSignature: sig });
      assert.equal(res.status, 409);
      assert.equal(res.body.code, 'IDENTITY_ALREADY_LINKED');
    } finally {
      prisma.authIdentity.create = realCreate;
    }
    assert.equal(prisma.authLoginAttempt.rows.find((r) => r.id === identified.loginId).state, 'identified');
  });

  it('a disabled or organisation account cannot link', async () => {
    const { user } = await makeUser();
    const identified = await linkAttempt(user, x('5005'));
    prisma.user.rows.find((r) => r.id === user.id).userType = 'organization';
    const ch = await challenge(user, { action: 'link', loginId: identified.loginId });
    assert.equal(ch.status, 403);
    assert.equal(ch.body.code, 'ORG_NOT_ALLOWED');
  });

  it('unknown action → STEP_UP_INVALID', async () => {
    const { user } = await makeUser();
    const res = await challenge(user, { action: 'merge' });
    assert.equal(res.status, 401);
    assert.equal(res.body.code, 'STEP_UP_INVALID');
  });
});

// ---------------------------------------------------------------------------------------------
// Unlink
// ---------------------------------------------------------------------------------------------
describe('POST /identities/challenge + DELETE /identities/:id', () => {
  it('removes a method with the wallet step-up (204) and never the last one', async () => {
    const { user, wallet } = await makeUser();
    const a = await addIdentity(user.id, { provider: 'email', subject: 'a@example.com' });
    const b = await addIdentity(user.id, { provider: 'x', subject: '6006' });

    const ch = await challenge(user, { action: 'unlink', identityId: b.id });
    assert.equal(ch.status, 200);
    assert.match(ch.body.data.stepUp.statement, /^Remove X from the sign-in methods/);
    assert.equal(ch.body.data.stepUp.requestId, b.id);
    const res = await request(server).delete(`/identities/${b.id}`).set(as(user)).send({ stepUpSignature: await sign(wallet, ch.body.data.stepUp) });
    assert.equal(res.status, 204, JSON.stringify(res.body));
    assert.deepEqual(prisma.authIdentity.rows.map((r) => r.id), [a.id]);
    assert.ok(logs.some((l) => l.message === 'native_auth.identity_unlinked' && l.meta.identityId === b.id));

    const last = await challenge(user, { action: 'unlink', identityId: a.id });
    assert.equal(last.status, 409);
    assert.equal(last.body.code, 'IDENTITY_LAST_METHOD');
    const del = await request(server).delete(`/identities/${a.id}`).set(as(user)).send({ stepUpSignature: `0x${'1'.repeat(130)}` });
    assert.equal(del.body.code, 'IDENTITY_LAST_METHOD');
    assert.equal(prisma.authIdentity.rows.length, 1);
  });

  it('two unlinks signed before either ran: the second one is refused', async () => {
    const { user, wallet } = await makeUser();
    const a = await addIdentity(user.id, { provider: 'email', subject: 'c1@example.com' });
    const b = await addIdentity(user.id, { provider: 'google', subject: 'g-c1', email: 'c1@gmail.com', grade: 'strong' });
    const chA = await challenge(user, { action: 'unlink', identityId: a.id });
    const chB = await challenge(user, { action: 'unlink', identityId: b.id });
    const sigA = await sign(wallet, chA.body.data.stepUp);
    const sigB = await sign(wallet, chB.body.data.stepUp);
    const first = await request(server).delete(`/identities/${a.id}`).set(as(user)).send({ stepUpSignature: sigA });
    assert.equal(first.status, 204);
    const second = await request(server).delete(`/identities/${b.id}`).set(as(user)).send({ stepUpSignature: sigB });
    assert.equal(second.status, 409);
    assert.equal(second.body.code, 'IDENTITY_LAST_METHOD');
    assert.deepEqual(prisma.authIdentity.rows.map((r) => r.id), [b.id]);
  });

  it('the count is repeated under the per-account lock (a concurrent unlink landed after the early check)', async () => {
    const { user, wallet } = await makeUser();
    const a = await addIdentity(user.id, { provider: 'email', subject: 'r1@example.com' });
    const b = await addIdentity(user.id, { provider: 'x', subject: 'r2' });
    const ch = await challenge(user, { action: 'unlink', identityId: b.id });
    const sig = await sign(wallet, ch.body.data.stepUp);
    // The early check sees both rows; then the other unlink commits before our transaction.
    const stale = prisma.authIdentity.rows.map((r) => ({ ...r }));
    prisma.authIdentity.rows.splice(prisma.authIdentity.rows.findIndex((r) => r.id === a.id), 1);
    let first = true;
    const db = {
      ...prisma,
      authIdentity: {
        ...prisma.authIdentity,
        findMany: async (args) => {
          if (first) {
            first = false;
            return stale;
          }
          return prisma.authIdentity.findMany(args);
        },
      },
    };
    await assert.rejects(
      identities.unlinkIdentity({ user, identityId: b.id, body: { stepUpSignature: sig }, db, cfg: cfg() }),
      { code: 'IDENTITY_LAST_METHOD' },
    );
    assert.deepEqual(prisma.authIdentity.rows.map((r) => r.id), [b.id]);
    const lock = prisma.rawStatements.find((st) => /pg_advisory_xact_lock/.test(st.sql));
    assert.ok(lock, 'the per-account advisory lock is taken');
    assert.equal(lock.values[0], identities._internals.identityLockKey(user.id));
  });

  it('a password counts as a remaining method; web3auth_legacy rows do not', async () => {
    const pw = await makeUser({ wallet: Wallet.createRandom(), password: 'hash' });
    const only = await addIdentity(pw.user.id, { provider: 'email', subject: 'pw@example.com' });
    assert.equal((await challenge(pw.user, { action: 'unlink', identityId: only.id })).status, 200);

    const legacy = await makeUser();
    const one = await addIdentity(legacy.user.id, { provider: 'email', subject: 'lg@example.com' });
    await addIdentity(legacy.user.id, { provider: 'web3auth_legacy', subject: `${LEGACY_EMAIL}|lg@example.com`, linkedVia: 'lazy_rebind' });
    assert.equal((await challenge(legacy.user, { action: 'unlink', identityId: one.id })).body.code, 'IDENTITY_LAST_METHOD');
  });

  it('another user’s, an unknown or an internal identity → STEP_UP_INVALID {reason: identity}', async () => {
    const alice = await makeUser();
    const bob = await makeUser();
    await addIdentity(alice.user.id, { provider: 'email', subject: 'al@example.com' });
    await addIdentity(alice.user.id, { provider: 'x', subject: '7007' });
    const bobs = await addIdentity(bob.user.id, { provider: 'email', subject: 'bo@example.com' });
    const internal = await addIdentity(alice.user.id, { provider: 'web3auth_legacy', subject: `${LEGACY_EMAIL}|al@example.com`, linkedVia: 'lazy_rebind' });
    for (const id of [bobs.id, internal.id, 'nope']) {
      const ch = await challenge(alice.user, { action: 'unlink', identityId: id });
      assert.equal(ch.body.code, 'STEP_UP_INVALID', id);
      assert.equal(ch.body.data.reason, 'identity');
      const del = await request(server).delete(`/identities/${id}`).set(as(alice.user)).send({ stepUpSignature: `0x${'1'.repeat(130)}` });
      assert.equal(del.body.code, 'STEP_UP_INVALID', id);
    }
    assert.equal(prisma.authIdentity.rows.length, 4);
  });

  it('an unlink challenge cannot remove a different identity', async () => {
    const { user, wallet } = await makeUser();
    const a = await addIdentity(user.id, { provider: 'email', subject: 'd1@example.com' });
    const b = await addIdentity(user.id, { provider: 'x', subject: '8008' });
    await addIdentity(user.id, { provider: 'apple', subject: 'a-1', email: null, grade: 'none' });
    const ch = await challenge(user, { action: 'unlink', identityId: b.id });
    const sig = await sign(wallet, ch.body.data.stepUp);
    const res = await request(server).delete(`/identities/${a.id}`).set(as(user)).send({ stepUpSignature: sig });
    assert.equal(res.body.code, 'STEP_UP_INVALID');
    assert.equal(prisma.authIdentity.rows.length, 3);
  });
});

// ---------------------------------------------------------------------------------------------
// Accounts without a wallet
// ---------------------------------------------------------------------------------------------
describe('step-up for an account without a wallet', () => {
  it('our OTP for the account’s own address is its own step-up (password account, rule 3d owner)', async () => {
    const { user } = await makeUser({ wallet: null, email: 'Owner@Example.com', password: 'hash' });
    const identified = await linkAttempt(user, email('owner@example.com'));
    const ch = await challenge(user, { action: 'link', loginId: identified.loginId });
    assert.deepEqual(ch.body.data, { stepUp: null, mode: 'none' });
    const res = await request(server).post('/identities/link').set(as(user)).send({ loginId: identified.loginId, loginSecret: identified.loginSecret });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(prisma.authIdentity.rows[0].emailLinkGrade, 'strong');
    await flushNotices();
    assert.deepEqual(mails.map((m) => m.to), ['owner@example.com']);
    assert.doesNotMatch(mails[0].text, /wallet/i, 'no wallet line when no wallet confirmed it');
  });

  it('any other link needs a fresh identify of an already-linked method', async () => {
    const { user } = await makeUser({ wallet: null, email: 'nw@example.com', password: 'hash' });
    const known = await addIdentity(user.id, { provider: 'email', subject: 'nw@example.com' });
    const target = await linkAttempt(user, x('9009'));
    const ch = await challenge(user, { action: 'link', loginId: target.loginId });
    assert.deepEqual(ch.body.data, { stepUp: null, mode: 'identify' });

    const send = (extra) => request(server).post('/identities/link').set(as(user)).send({ loginId: target.loginId, loginSecret: target.loginSecret, ...extra });
    let res = await send({});
    assert.equal(res.body.code, 'STEP_UP_REQUIRED');
    assert.equal(res.body.data.mode, 'identify');

    // A proof of a method NOT linked to the account does not count.
    const unrelated = await linkAttempt(user, google('stranger@gmail.com'));
    res = await send({ stepUpLoginId: unrelated.loginId, stepUpLoginSecret: unrelated.loginSecret });
    assert.equal(res.body.code, 'STEP_UP_INVALID');

    // The link attempt itself does not count as its own proof.
    res = await send({ stepUpLoginId: target.loginId, stepUpLoginSecret: target.loginSecret });
    assert.equal(res.body.code, 'STEP_UP_INVALID');

    // Older than 10 minutes does not count.
    const stale = await linkAttempt(user, email(known.subject));
    prisma.authLoginAttempt.rows.find((r) => r.id === stale.loginId).createdAt = new Date(Date.now() - 11 * 60 * 1000);
    res = await send({ stepUpLoginId: stale.loginId, stepUpLoginSecret: stale.loginSecret });
    assert.equal(res.body.code, 'STEP_UP_INVALID');

    const fresh = await linkAttempt(user, email(known.subject));
    res = await send({ stepUpLoginId: fresh.loginId, stepUpLoginSecret: fresh.loginSecret });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(prisma.authLoginAttempt.rows.find((r) => r.id === fresh.loginId).state, 'completed', 'the proof is spent');
    assert.ok(logs.some((l) => l.message === 'native_auth.identity_linked' && l.meta.stepUp === 'identify'));
    assertNoSecretsLogged([fresh.loginId, fresh.loginSecret, target.loginSecret]);
  });

  it('unlink without a wallet needs the identify proof too', async () => {
    const { user } = await makeUser({ wallet: null, email: 'nw2@example.com', password: 'hash' });
    const known = await addIdentity(user.id, { provider: 'email', subject: 'nw2@example.com' });
    const extra = await addIdentity(user.id, { provider: 'x', subject: '1111' });
    const ch = await challenge(user, { action: 'unlink', identityId: extra.id });
    assert.deepEqual(ch.body.data, { stepUp: null, mode: 'identify' });
    let res = await request(server).delete(`/identities/${extra.id}`).set(as(user)).send({});
    assert.equal(res.body.code, 'STEP_UP_REQUIRED');
    const proof = await linkAttempt(user, email(known.subject));
    res = await request(server).delete(`/identities/${extra.id}`).set(as(user)).send({ stepUpLoginId: proof.loginId, stepUpLoginSecret: proof.loginSecret });
    assert.equal(res.status, 204, JSON.stringify(res.body));
    assert.equal(prisma.authIdentity.rows.length, 1);
  });
});

// ---------------------------------------------------------------------------------------------
// Notices
// ---------------------------------------------------------------------------------------------
describe('link / unlink notices', () => {
  it('go to every strong address (identities + a legacy e-mail pair), never to weak or placeholder ones', async () => {
    const { user, wallet } = await makeUser({ email: 'legacy@example.com', web3authVerifier: LEGACY_EMAIL, web3authVerifierId: 'legacy@example.com' });
    await addIdentity(user.id, { provider: 'google', subject: 'g-s', email: 'strong@gmail.com', grade: 'strong' });
    await addIdentity(user.id, { provider: 'google', subject: 'g-w', email: 'weak@corp.example', grade: 'weak' });
    const identified = await linkAttempt(user, x('1212'));
    const res = await linkWithWallet(user, wallet, identified, { locale: 'zh-CN' });
    assert.equal(res.status, 200);
    await flushNotices();
    assert.deepEqual(mails.map((m) => m.to).sort(), ['legacy@example.com', 'strong@gmail.com']);
    const mail = mails[0];
    assert.equal(mail.from, 'DataDance <no-reply@datadance.test>');
    assert.equal(mail.subject, '你的 DataDance 账号新增了一种登录方式');
    assert.match(mail.text, /X/);
    assert.match(mail.text, /钱包确认/);
    assert.doesNotMatch(mail.html, /<a\s|https?:\/\//i, 'no links');
    assert.equal(mail.headers['Auto-Submitted'], 'auto-generated');
    const sent = logs.filter((l) => l.message === 'native_auth.identity_notice_sent');
    assert.equal(sent.length, 2);
    assertNoSecretsLogged(['legacy@example.com', 'strong@gmail.com']);
  });

  it('an unlink notice reaches the removed method’s own strong address, masked in the body', async () => {
    const { user, wallet } = await makeUser();
    await addIdentity(user.id, { provider: 'x', subject: '1313' });
    const gone = await addIdentity(user.id, { provider: 'email', subject: 'gone@example.com' });
    const res = await unlinkWithWallet(user, wallet, gone.id);
    assert.equal(res.status, 204);
    await flushNotices();
    assert.deepEqual(mails.map((m) => m.to), ['gone@example.com']);
    assert.equal(mails[0].subject, 'A sign-in method was removed from your DataDance account');
    assert.match(mails[0].text, /E-mail code \(go\*\*\*@example\.com\)/);
    assert.doesNotMatch(mails[0].text + mails[0].subject, /gone@example\.com/);
  });

  it('a failed send never fails the change; it is logged with a masked address', async () => {
    const { user, wallet } = await makeUser();
    await addIdentity(user.id, { provider: 'email', subject: 'f@example.com' });
    mailFailure = Object.assign(new Error('smtp down'), { code: 'ECONNREFUSED' });
    const identified = await linkAttempt(user, x('1414'));
    const res = await linkWithWallet(user, wallet, identified);
    assert.equal(res.status, 200);
    await flushNotices();
    const failed = logs.find((l) => l.message === 'native_auth.identity_notice_failed');
    assert.ok(failed);
    assert.equal(failed.level, 'error');
    assert.equal(failed.meta.emailMasked, 'f***@example.com');
    assert.equal(failed.meta.reason, 'ECONNREFUSED');
  });

  it('no strong address → nothing sent, a warning logged', async () => {
    const { user, wallet } = await makeUser();
    await addIdentity(user.id, { provider: 'x', subject: '1515' });
    const identified = await linkAttempt(user, x('1616'));
    await linkWithWallet(user, wallet, identified);
    await flushNotices();
    assert.equal(mails.length, 0);
    assert.ok(logs.some((l) => l.message === 'native_auth.identity_notice_skipped'));
  });

  it('renders in five locales, no raw User-Agent, a fixed device name and the country', () => {
    for (const locale of ['en', 'zh', 'zh-TW', 'ja', 'ko']) {
      for (const kind of ['linked', 'unlinked']) {
        const mail = notify.renderIdentityNotice({
          kind,
          provider: 'google',
          methodEmailMasked: 'ab***@gmail.com',
          locale,
          at: new Date('2026-09-29T10:00:00Z'),
          context: { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/128.0 Safari/537.36 <script>evil</script>', country: 'SG' },
          confirmedWithWallet: true,
        });
        assert.equal(mail.locale, locale);
        assert.equal(mail.subject, notify.STRINGS[locale].subject[kind]);
        assert.match(mail.text, /Google \(ab\*\*\*@gmail\.com\)/);
        assert.match(mail.text, /2026-09-29 10:00:00Z/);
        assert.match(mail.text, /Chrome/);
        assert.doesNotMatch(mail.text + mail.html, /evil|Mozilla/);
        assert.match(mail.html, /^<!doctype html>/);
      }
    }
    assert.throws(() => notify.renderIdentityNotice({ kind: 'merged', provider: 'x' }));
  });

  it('strongEmailsOf ignores placeholders, weak rows and unproven User.email', () => {
    const c = cfg();
    const user = { email: 'typed@example.com', web3authVerifier: null, web3authVerifierId: null };
    assert.deepEqual(
      notify.strongEmailsOf({
        user,
        identities: [
          { email: 'S@Gmail.com', emailLinkGrade: 'strong' },
          { email: 's@gmail.com', emailLinkGrade: 'strong' },
          { email: 'w@x.io', emailLinkGrade: 'weak' },
          { email: 'email|abc', emailLinkGrade: 'strong' },
          { email: null, emailLinkGrade: 'strong' },
        ],
        cfg: c,
      }),
      ['s@gmail.com'],
    );
    assert.deepEqual(notify.strongEmailsOf({ user: { email: 'p@example.com', web3authVerifier: LEGACY_EMAIL, web3authVerifierId: 'p@example.com' }, identities: [], cfg: c }), ['p@example.com']);
  });
});

describe('contract', () => {
  it('every code the identities service emits is in the closed set', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../src/services/nativeAuth/identities.js'), 'utf8');
    const codes = [...source.matchAll(/NativeAuthError\('([A-Z_]+)'/g)].map((m) => m[1]);
    assert.ok(codes.length >= 5);
    for (const code of codes) assert.ok(code in NATIVE_ERROR_CODES, code);
  });
});
