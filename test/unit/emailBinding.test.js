const { test } = require('node:test');
const assert = require('node:assert/strict');
const { bindingClaims, reauthBindingSession, sendBindingCode, verifyBindingCode, bindLoginEmail } = require('../../src/services/emailBinding');
const { publicUser } = require('../../src/utils/publicUser');

const ON = { EMAIL_BINDING_ENABLED: 'true' };
const NOW = 1_800_000_000_000;
const ISSUED = NOW / 1000;
const EMAIL = 'recovery@example.com';
const SOCIAL = { kind: 'social', verifier: 'trusted-x', verifierId: 'twitter|42' };

function user(id, overrides = {}) {
  return {
    id,
    email: 'twitter|42',
    walletAddress: 'original-wallet',
    userType: 'regular',
    authType: 'web3auth',
    web3authVerifier: SOCIAL.verifier,
    web3authVerifierId: SOCIAL.verifierId,
    ...overrides,
  };
}

function session(account, issued = { iat: ISSUED }) {
  return { id: account.id, iat: ISSUED, ver: 2, ...bindingClaims(account, SOCIAL, true, issued, ON, NOW) };
}

function harness(account, claims = session(account)) {
  const sent = [];
  let bound = null;
  let writes = 0;
  return {
    sent,
    get writes() { return writes; },
    send(overrides = {}) {
      return sendBindingCode({
        user: account, claims, now: NOW, rawEmail: EMAIL,
        getBinding: async () => bound,
        sendMail: async (email, code) => sent.push({ email, code }),
        ...overrides,
      });
    },
    verify(rawCode, overrides = {}) {
      return verifyBindingCode({
        user: account, claims, now: NOW, rawEmail: EMAIL, rawCode,
        bindEmail: async (id, email) => {
          assert.equal(id, account.id);
          writes += 1;
          bound = { email };
          return 'bound';
        },
        ...overrides,
      });
    },
  };
}

test('only a fresh, trusted social token for the exact persisted identity creates binding proof', () => {
  const account = user('claims');
  assert.equal(session(account).amr, 'web3auth');
  assert.equal(bindingClaims(account, SOCIAL, true, {}, ON, NOW).amr, undefined);
  assert.equal(session(account, { iat: ISSUED - 600 }).amr, undefined);
  assert.equal(session(account, { iat: ISSUED, auth_time: ISSUED - 600 }).amr, undefined);
  assert.equal(session(account, { iat: ISSUED + 31 }).amr, undefined);
  assert.equal(bindingClaims(account, SOCIAL, true, { iat: ISSUED }, {}, NOW).amr, undefined);
  assert.equal(bindingClaims(account, SOCIAL, false, { iat: ISSUED }, ON, NOW).amr, undefined);
  assert.equal(bindingClaims(account, { ...SOCIAL, kind: 'external' }, true, { iat: ISSUED }, ON, NOW).amr, undefined);
  assert.equal(bindingClaims(user('different', { web3authVerifierId: 'twitter|99' }), SOCIAL, true, { iat: ISSUED }, ON, NOW).amr, undefined);
});

test('send requires current regular account identity and rejects OTP, old and stale proofs', async () => {
  const account = user('freshness');
  const box = harness(account);
  for (const overrides of [
    { claims: { id: account.id, iat: ISSUED, ver: 2, amr: 'email_otp' } },
    { claims: { id: account.id, iat: ISSUED, ver: 2 } },
    { user: { ...account, isOrganization: true } },
    { user: { ...account, userType: 'system' } },
    { user: { ...account, disabledAt: new Date(NOW) } },
    { user: { ...account, web3authVerifierId: null } },
    { user: { ...account, web3authVerifierId: 'twitter|99' } },
    { now: NOW + 600_000 },
    { claims: session(account, { iat: ISSUED - 599 }), now: NOW + 1_000 },
  ]) {
    const result = await box.send(overrides);
    assert.equal(result.status, 403);
    assert.equal(result.body.code, 'EMAIL_BIND_REAUTH_REQUIRED');
  }
  assert.deepEqual(box.sent, []);
});

test('reauth verifies the same provider account and wallet without resolving or creating a user', async () => {
  const account = user('reauth', { privateKey: 'private' });
  const now = Math.floor(Date.now() / 1000);
  const issued = [];
  const provider = {
    async verifyIdToken() { return { kind: 'social', payload: { iat: now } }; },
    extractIdentity() { return SOCIAL; },
    isTrustedVerifier(verifier) { return verifier === SOCIAL.verifier; },
    assertWalletBound(_identity, claimed) { return claimed; },
    resolveUser() { assert.fail('reauth cannot resolve or create another account'); },
    Web3AuthIdentityError: class extends Error {},
  };
  const inputs = {
    user: account, idToken: 'verified-by-fixture', walletAddress: account.walletAddress,
    provider, env: ON,
    issueToken(id, claims) {
      issued.push({ id, claims });
      return 'test-session';
    },
  };
  const response = await reauthBindingSession(inputs);
  assert.equal(response.status, 200);
  assert.equal(response.body.data.token, 'test-session');
  assert.equal(response.body.data.user.id, account.id);
  assert.equal(Object.hasOwn(response.body.data.user, 'privateKey'), false);
  assert.equal(issued[0].claims.amr, 'web3auth');

  const wrongAccount = { ...provider, extractIdentity: () => ({ ...SOCIAL, verifierId: 'twitter|99' }) };
  for (const overrides of [{ provider: wrongAccount }, { walletAddress: 'another-wallet' }, { idToken: '' }]) {
    const refused = await reauthBindingSession({ ...inputs, ...overrides });
    assert.equal(refused.status, 403);
    assert.equal(refused.body.code, 'EMAIL_BIND_REAUTH_REQUIRED');
  }
  assert.equal(issued.length, 1);
});

test('a normalized address and the requesting session bind once without changing the account', async () => {
  const account = user('single-bind');
  const original = { ...account };
  const box = harness(account);
  assert.deepEqual((await box.send({ rawEmail: ' RECOVERY@Example.com ' })).body.data, { accepted: true });
  const [{ email, code }] = box.sent;
  assert.equal(email, EMAIL);
  assert.match(code, /^\d{6}$/);
  assert.equal((await box.send()).status, 429);
  assert.equal((await box.verify(code, { claims: session(account) })).status, 400);
  assert.equal((await box.verify(code, { rawEmail: 'other@example.com' })).status, 400);

  const results = await Promise.all([box.verify(code), box.verify(code)]);
  assert.deepEqual(results.map(({ status }) => status).sort(), [200, 400]);
  assert.deepEqual(results.find(({ status }) => status === 200).body.data, { loginEmail: EMAIL });
  assert.equal(box.writes, 1);
  assert.deepEqual(account, original);
  assert.equal((await box.send()).body.code, 'EMAIL_BIND_ALREADY_BOUND');
  assert.equal((await box.send({ rawEmail: 'other@example.com' })).body.code, 'EMAIL_BIND_CONFLICT');
});

test('wrong, expired and unsent binding codes cannot commit', async () => {
  const limited = harness(user('attempts'));
  await limited.send();
  const [{ code }] = limited.sent;
  const wrong = code === '000000' ? '000001' : '000000';
  for (let i = 0; i < 5; i += 1) assert.equal((await limited.verify(wrong)).status, 400);
  assert.equal((await limited.verify(code)).status, 400);
  assert.equal(limited.writes, 0);

  const expired = harness(user('expiry'));
  await expired.send();
  assert.equal((await expired.verify(expired.sent[0].code, { now: NOW + 300_000 })).status, 400);
  assert.equal(expired.writes, 0);

  const failed = harness(user('mail-failure'));
  let rejectedCode;
  const response = await failed.send({ sendMail: async (_email, code) => {
    rejectedCode = code;
    throw new Error('SMTP unavailable');
  } });
  assert.equal(response.status, 503);
  assert.equal((await failed.verify(rejectedCode)).status, 400);
});

function bindingDb(account, { legacyOwner = null, createError = null } = {}) {
  const writes = [];
  const db = {
    async $transaction(operation, options) {
      assert.deepEqual(options, { isolationLevel: 'Serializable' });
      return operation({
        user: {
          async findUnique({ where }) { assert.deepEqual(where, { id: account.id }); return account; },
          async findFirst({ where }) {
            assert.deepEqual(where, {
              id: { not: account.id }, email: { equals: EMAIL, mode: 'insensitive' },
            });
            return legacyOwner;
          },
        },
        userLoginEmail: {
          async create({ data }) {
            if (createError) throw Object.assign(new Error(), { code: createError });
            writes.push(data);
          },
        },
      });
    },
  };
  return { db, writes };
}

test('database first bind checks another legacy owner, current proof, uniqueness and first write', async () => {
  const account = user('database');
  const claims = session(account);
  const bound = bindingDb(account);
  assert.equal(await bindLoginEmail(bound.db, account.id, EMAIL, claims, NOW), 'bound');
  assert.deepEqual(bound.writes, [{ userId: account.id, email: EMAIL }]);

  const legacy = bindingDb(account, { legacyOwner: { id: 'other' } });
  assert.equal(await bindLoginEmail(legacy.db, account.id, EMAIL, claims, NOW), 'conflict');
  assert.deepEqual(legacy.writes, []);
  for (const createError of ['P2002', 'P2034']) {
    const race = bindingDb(account, { createError });
    assert.equal(await bindLoginEmail(race.db, account.id, EMAIL, claims, NOW), 'conflict');
    assert.deepEqual(race.writes, []);
  }
  const replaced = bindingDb({ ...account, web3authVerifierId: 'twitter|99' });
  assert.equal(await bindLoginEmail(replaced.db, account.id, EMAIL, claims, NOW), 'recent_required');
  const already = bindingDb({ ...account, loginEmail: { email: EMAIL } });
  assert.equal(await bindLoginEmail(already.db, account.id, EMAIL, claims, NOW), 'bound');
  assert.deepEqual(already.writes, []);
});

test('profile and OTP serialization keeps public fields and strips credentials and recovery state', () => {
  const account = user('profile', {
    name: 'Ada',
    referralCode: 'ABC234',
    password: 'hash',
    privateKey: 'private',
    xAccessToken: 'access',
    xRefreshToken: 'refresh',
    loginEmail: { email: EMAIL },
  });
  const serialized = publicUser(account);
  assert.equal(serialized.id, account.id);
  assert.equal(serialized.name, 'Ada');
  assert.equal(serialized.walletAddress, account.walletAddress);
  assert.equal(serialized.referralCode, 'DDC-ABC234');
  for (const field of ['password', 'privateKey', 'xAccessToken', 'xRefreshToken', 'loginEmail']) {
    assert.equal(Object.hasOwn(serialized, field), false);
  }
});
