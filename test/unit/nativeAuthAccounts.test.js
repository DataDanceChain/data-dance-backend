/**
 * Native account resolution (design §3.6, F4/F5/F12/F16/F21): link grades, the full resolution
 * matrix (identity → legacy X pair → strong e-mail a/b/c/d → create), the new-account gate, and
 * that resolution writes nothing. In-memory Prisma (test/helpers/mockPrisma) with unique checks.
 */
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.LOG_LEVEL = 'error';

const { installMockPrisma } = require('../helpers/mockPrisma');

const prisma = installMockPrisma({ enforceUnique: true });

const { makeKeyFile, localEnv } = require('../helpers/nativeAuthKeys');
const config = require('../../src/services/nativeAuth/config');
const accounts = require('../../src/services/nativeAuth/accounts');

const key = makeKeyFile();
const LEGACY_EMAIL = 'web3auth-auth0-email-passwordless-sapphire-devnet';
const LEGACY_GOOGLE = 'web3auth-google-sapphire-devnet';
const LEGACY_X = 'web3auth-auth0-twitter-sapphire-devnet';
const LEGACY_APPLE = 'web3auth-auth0-apple-sapphire-devnet';
const CONN = 'ddc-jwt-devnet';

function cfgFor(overrides = {}) {
  return config.readNativeAuthConfig(
    localEnv(key, {
      DDC_AUTH_NEW_ACCOUNTS: 'open',
      DDC_AUTH_LEGACY_EMAIL_VERIFIERS: LEGACY_EMAIL,
      DDC_AUTH_LEGACY_GOOGLE_VERIFIERS: LEGACY_GOOGLE,
      DDC_AUTH_LEGACY_X_VERIFIERS: LEGACY_X,
      ...overrides,
    }),
  );
}

let seq = 0;
function addUser(fields = {}) {
  seq += 1;
  const row = {
    id: `user-${seq}`,
    email: `user${seq}@example.com`,
    name: null,
    walletAddress: null,
    authType: 'web3auth',
    userType: 'regular',
    isOrganization: false,
    disabledAt: null,
    xid: null,
    web3authVerifier: null,
    web3authVerifierId: null,
    referralCode: `CODE${seq}`,
    legacyReferralCode: null,
    ...fields,
  };
  prisma.user.rows.push(row);
  return row;
}

function addIdentity(fields) {
  const row = { id: `ident-${++seq}`, createdAt: new Date(), lastLoginAt: null, isPrivateRelay: false, email: null, emailLinkGrade: 'none', linkedVia: 'created', ...fields };
  prisma.authIdentity.rows.push(row);
  return row;
}

const email = (address) => ({ provider: 'email', subject: address, email: address, emailVerified: true });
const google = (address, extra = {}) => ({ provider: 'google', subject: `g-${address}`, email: address, emailVerified: true, ...extra });
const apple = (address, extra = {}) => ({ provider: 'apple', subject: `001234.${address}`, email: address, emailVerified: true, ...extra });
const x = (id) => ({ provider: 'x', subject: id, profile: { xUsername: `x${id}` } });

function snapshot() {
  return JSON.stringify(prisma.store);
}

async function resolve(identity, cfgOverrides = {}, options = {}) {
  const before = snapshot();
  try {
    return await accounts.resolveNativeIdentity({ identity, cfg: cfgFor(cfgOverrides), db: prisma, ...options });
  } finally {
    assert.equal(snapshot(), before, 'resolveNativeIdentity must write nothing');
  }
}

async function rejects(promise, code, dataCheck) {
  let caught;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, `expected ${code}`);
  assert.equal(caught.code, code, caught.message);
  if (dataCheck) dataCheck(caught.data);
  return caught;
}

beforeEach(() => {
  prisma.reset();
});

describe('link grades (F4, D8)', () => {
  const grade = (identity) => accounts.linkGrade(accounts.normalizeIdentity(identity));

  it('our e-mail OTP is strong', () => assert.equal(grade(email('a@example.com')), 'strong'));
  it('Google is strong only for a verified @gmail.com address or with an hd claim', () => {
    assert.equal(grade(google('a@gmail.com')), 'strong');
    assert.equal(grade(google('a@corp.example', { hd: 'corp.example' })), 'strong');
    assert.equal(grade(google('a@corp.example')), 'weak', 'non-Gmail without hd');
    assert.equal(grade(google('a@gmail.com', { emailVerified: false })), 'weak', 'email_verified false');
    assert.equal(grade(google('a@gmail.com', { emailVerified: 'true' })), 'weak', 'only a real boolean counts');
  });
  it('Apple is weak (never a link source); an address Apple did not verify is dropped', () => {
    assert.equal(grade(apple('a@icloud.com')), 'weak');
    const unverified = accounts.normalizeIdentity(apple('a@icloud.com', { emailVerified: false }));
    assert.equal(unverified.email, null);
    assert.equal(accounts.linkGrade(unverified), 'none');
  });
  it('X has no grade', () => assert.equal(grade(x('123')), 'none'));
  it('normalises e-mail subjects and addresses to lower case', () => {
    const n = accounts.normalizeIdentity({ provider: 'email', subject: ' Ada@Example.COM ', email: 'Ada@Example.COM' });
    assert.equal(n.subject, 'ada@example.com');
    assert.equal(n.email, 'ada@example.com');
  });
  it('refuses a malformed identity', () => {
    assert.throws(() => accounts.normalizeIdentity({ provider: 'facebook', subject: '1' }), TypeError);
    assert.throws(() => accounts.normalizeIdentity({ provider: 'google', subject: '' }), TypeError);
  });
});

describe('rule 1: a known identity', () => {
  it('resolves to its user (existing, linkedBy identity)', async () => {
    const user = addUser({ walletAddress: '0x0000000000000000000000000000000000000001' });
    addIdentity({ userId: user.id, provider: 'google', subject: 'g-a@gmail.com', email: 'a@gmail.com', emailLinkGrade: 'strong' });
    const r = await resolve(google('a@gmail.com'));
    assert.equal(r.resolution, 'existing');
    assert.equal(r.user.id, user.id);
    assert.deepEqual(r.account, { status: 'existing', hasWallet: true, linkedBy: 'identity' });
  });

  it('guardAccount: disabled and organisation accounts are refused (F21)', async () => {
    const disabled = addUser({ disabledAt: new Date() });
    addIdentity({ userId: disabled.id, provider: 'email', subject: 'd@example.com' });
    await rejects(resolve(email('d@example.com')), 'ACCOUNT_DISABLED');
    const org = addUser({ userType: 'organization' });
    addIdentity({ userId: org.id, provider: 'email', subject: 'o@example.com' });
    await rejects(resolve(email('o@example.com')), 'ORG_NOT_ALLOWED');
  });
});

describe('rule 2: X links only through the legacy Web3Auth X pair (F12)', () => {
  it('a legacy (twitter|<id>) pair → link_legacy_x', async () => {
    const legacy = addUser({ email: 'twitter|42', web3authVerifier: LEGACY_X, web3authVerifierId: 'twitter|42' });
    const r = await resolve(x('42'));
    assert.equal(r.resolution, 'link_legacy_x');
    assert.equal(r.user.id, legacy.id);
    assert.equal(r.account.linkedBy, 'legacy_x');
  });

  it('User.xid alone is never trusted: a new account, not a link and not a 409', async () => {
    addUser({ xid: '42' });
    const r = await resolve(x('42'));
    assert.equal(r.resolution, 'create');
    assert.equal(r.user, null);
  });

  it('a pair under a verifier not listed in DDC_AUTH_LEGACY_X_VERIFIERS does not link', async () => {
    addUser({ web3authVerifier: 'some-other-twitter', web3authVerifierId: 'twitter|42' });
    assert.equal((await resolve(x('42'))).resolution, 'create');
  });

  it('a legacy X account that is disabled is refused', async () => {
    addUser({ disabledAt: new Date(), web3authVerifier: LEGACY_X, web3authVerifierId: 'twitter|42' });
    await rejects(resolve(x('42')), 'ACCOUNT_DISABLED');
  });
});

describe('rule 3a: strong identities of the same e-mail', () => {
  it('exactly one user → link_verified_email', async () => {
    const user = addUser();
    addIdentity({ userId: user.id, provider: 'email', subject: 'a@gmail.com', email: 'a@gmail.com', emailLinkGrade: 'strong' });
    const r = await resolve(google('a@gmail.com'));
    assert.equal(r.resolution, 'link_verified_email');
    assert.equal(r.user.id, user.id);
    assert.equal(r.account.linkedBy, 'verified_email');
  });

  it('more than one user → ACCOUNT_LINK_REQUIRED {reason: ambiguous}', async () => {
    addIdentity({ userId: addUser().id, provider: 'email', subject: 'a@gmail.com', email: 'a@gmail.com', emailLinkGrade: 'strong' });
    addIdentity({ userId: addUser().id, provider: 'google', subject: 'g-other', email: 'a@gmail.com', emailLinkGrade: 'strong' });
    await rejects(resolve(google('a@gmail.com')), 'ACCOUNT_LINK_REQUIRED', (data) => assert.equal(data.reason, 'ambiguous'));
  });

  it('a weaker stored row (Apple, non-Gmail Google) is never a target (F4b)', async () => {
    const holder = addUser({ email: 'relay@icloud.com', web3authVerifier: CONN, web3authVerifierId: 'x' });
    addIdentity({ userId: holder.id, provider: 'apple', subject: 'apple-1', email: 'a@corp.example', emailLinkGrade: 'weak' });
    addIdentity({ userId: holder.id, provider: 'google', subject: 'g-weak', email: 'a@corp.example', emailLinkGrade: 'weak' });
    const r = await resolve(email('a@corp.example'));
    assert.equal(r.resolution, 'create');
  });

  it('a weak incoming identity never auto-links, even to a strong row', async () => {
    const user = addUser();
    addIdentity({ userId: user.id, provider: 'email', subject: 'a@corp.example', email: 'a@corp.example', emailLinkGrade: 'strong' });
    assert.equal((await resolve(google('a@corp.example'))).resolution, 'create', 'non-Gmail Google without hd');
    assert.equal((await resolve(apple('a@corp.example'))).resolution, 'create', 'Apple');
  });
});

describe('rules 3b–3d: accounts holding the e-mail', () => {
  it('3b: a legacy e-mail-passwordless pair → link_legacy_email (case-insensitive e-mail column)', async () => {
    const legacy = addUser({ email: 'Ada@Example.com', web3authVerifier: LEGACY_EMAIL, web3authVerifierId: 'ada@example.com' });
    const r = await resolve(email('ada@example.com'));
    assert.equal(r.resolution, 'link_legacy_email');
    assert.equal(r.user.id, legacy.id);
    assert.equal(r.account.linkedBy, 'legacy_email');
  });

  it('3b: a legacy Google pair links only for a @gmail.com address', async () => {
    const gmail = addUser({ email: 'ada@gmail.com', web3authVerifier: LEGACY_GOOGLE, web3authVerifierId: 'ada@gmail.com' });
    assert.equal((await resolve(email('ada@gmail.com'))).user.id, gmail.id);
    assert.equal((await resolve(google('ada@gmail.com'))).resolution, 'link_legacy_email');
    addUser({ email: 'ada@corp.example', web3authVerifier: LEGACY_GOOGLE, web3authVerifierId: 'ada@corp.example' });
    await rejects(resolve(google('ada@corp.example', { hd: 'corp.example' })), 'ACCOUNT_LINK_REQUIRED', (data) =>
      assert.deepEqual(data, { reason: 'legacy_method', hint: 'sign_in_with_previous_method_then_link' }),
    );
  });

  it('3b: found by the legacy pair even when the e-mail column differs', async () => {
    const legacy = addUser({ email: 'old@example.com', web3authVerifier: LEGACY_EMAIL, web3authVerifierId: 'ada@example.com' });
    assert.equal((await resolve(email('ada@example.com'))).user.id, legacy.id);
  });

  it('3c: any other legacy pair (Apple, external wallet) → ACCOUNT_LINK_REQUIRED legacy_method', async () => {
    addUser({ email: 'ada@example.com', web3authVerifier: LEGACY_APPLE, web3authVerifierId: 'apple|001' });
    await rejects(resolve(email('ada@example.com')), 'ACCOUNT_LINK_REQUIRED', (data) => assert.equal(data.reason, 'legacy_method'));
    prisma.reset();
    addUser({ email: 'bob@example.com', web3authVerifier: 'external-wallet', web3authVerifierId: '0xabc' });
    await rejects(resolve(email('bob@example.com')), 'ACCOUNT_LINK_REQUIRED');
  });

  it('3c: a legacy e-mail verifier whose pair names another address is not a match', async () => {
    addUser({ email: 'ada@example.com', web3authVerifier: LEGACY_EMAIL, web3authVerifierId: 'someone@else.com' });
    await rejects(resolve(email('ada@example.com')), 'ACCOUNT_LINK_REQUIRED');
  });

  it('3d: a password / placeholder row holding E never blocks and is never merged → shadow account (F5)', async () => {
    addUser({ email: 'ada@example.com', authType: 'traditional', password: 'hash' });
    const r = await resolve(email('ada@example.com'));
    assert.equal(r.resolution, 'shadow_email');
    assert.equal(r.user, null, 'the old row is not the target');
    assert.deepEqual(r.account, { status: 'new', hasWallet: false, linkedBy: 'new' });
  });

  it('3d: a native account holding E through Apple (weak) is neither target nor blocker', async () => {
    addUser({ email: 'ada@example.com', web3authVerifier: CONN, web3authVerifierId: 'native-user' });
    assert.equal((await resolve(email('ada@example.com'))).resolution, 'shadow_email');
  });

  it('two legacy e-mail pairs for E → ambiguous', async () => {
    addUser({ email: 'ada@example.com', web3authVerifier: LEGACY_EMAIL, web3authVerifierId: 'ada@example.com' });
    addUser({ email: 'ADA@example.com', web3authVerifier: 'legacy-email-mainnet', web3authVerifierId: 'ada@example.com' });
    await rejects(
      resolve(email('ada@example.com'), { DDC_AUTH_LEGACY_EMAIL_VERIFIERS: `${LEGACY_EMAIL},legacy-email-mainnet` }),
      'ACCOUNT_LINK_REQUIRED',
      (data) => assert.equal(data.reason, 'ambiguous'),
    );
  });

  it('a weak Google identity whose e-mail a row holds creates a new account (no block)', async () => {
    addUser({ email: 'ada@corp.example', web3authVerifier: LEGACY_APPLE, web3authVerifierId: 'apple|1' });
    assert.equal((await resolve(google('ada@corp.example'))).resolution, 'create');
  });

  it('the legacy lists are opt-in: empty lists link nothing', async () => {
    addUser({ email: 'ada@example.com', web3authVerifier: LEGACY_EMAIL, web3authVerifierId: 'ada@example.com' });
    await rejects(resolve(email('ada@example.com'), { DDC_AUTH_LEGACY_EMAIL_VERIFIERS: '' }), 'ACCOUNT_LINK_REQUIRED');
  });
});

describe('rule 4: the new-account gate (F16)', () => {
  it('closed → NEW_ACCOUNTS_CLOSED for new accounts only', async () => {
    await rejects(resolve(email('new@example.com'), { DDC_AUTH_NEW_ACCOUNTS: 'closed' }), 'NEW_ACCOUNTS_CLOSED');
    const user = addUser();
    addIdentity({ userId: user.id, provider: 'email', subject: 'known@example.com' });
    assert.equal((await resolve(email('known@example.com'), { DDC_AUTH_NEW_ACCOUNTS: 'closed' })).resolution, 'existing');
  });

  it('allowlist: e-mails, @domain and x:<id>; an unverified address never opens it', async () => {
    const list = { DDC_AUTH_NEW_ACCOUNTS: 'allowlist', DDC_AUTH_ALLOWLIST: 'tester@example.com,@datadance.ai,x:777' };
    assert.equal((await resolve(email('Tester@Example.com'), list)).resolution, 'create');
    assert.equal((await resolve(google('anyone@datadance.ai', { hd: 'datadance.ai' }), list)).resolution, 'create');
    assert.equal((await resolve(x('777'), list)).resolution, 'create');
    await rejects(resolve(email('stranger@example.com'), list), 'NEW_ACCOUNTS_CLOSED');
    await rejects(resolve(x('778'), list), 'NEW_ACCOUNTS_CLOSED');
    await rejects(resolve(google('anyone@datadance.ai', { emailVerified: false }), list), 'NEW_ACCOUNTS_CLOSED');
  });

  it('the allowlist also gates a shadow account', async () => {
    addUser({ email: 'ada@example.com', authType: 'traditional' });
    await rejects(resolve(email('ada@example.com'), { DDC_AUTH_NEW_ACCOUNTS: 'allowlist', DDC_AUTH_ALLOWLIST: '' }), 'NEW_ACCOUNTS_CLOSED');
  });

  it('the daily cap counts native accounts created since 00:00 UTC', async () => {
    const now = new Date('2026-10-01T12:00:00Z');
    addIdentity({ userId: 'u1', provider: 'email', subject: 'a@x.com', linkedVia: 'created', createdAt: new Date('2026-10-01T01:00:00Z') });
    addIdentity({ userId: 'u2', provider: 'email', subject: 'b@x.com', linkedVia: 'created', createdAt: new Date('2026-09-30T23:00:00Z') });
    addIdentity({ userId: 'u3', provider: 'email', subject: 'c@x.com', linkedVia: 'legacy_email', createdAt: new Date('2026-10-01T02:00:00Z') });
    assert.equal((await resolve(email('new@example.com'), { DDC_AUTH_NEW_ACCOUNTS_PER_DAY: '2' }, { now })).resolution, 'create');
    await rejects(resolve(email('new@example.com'), { DDC_AUTH_NEW_ACCOUNTS_PER_DAY: '1' }, { now }), 'NEW_ACCOUNTS_CLOSED');
  });

  it('checkNewAccountGate:false skips the gate (the /complete re-resolution)', async () => {
    const r = await resolve(email('new@example.com'), { DDC_AUTH_NEW_ACCOUNTS: 'closed' }, { checkNewAccountGate: false });
    assert.equal(r.resolution, 'create');
  });
});

describe('pendingSubjects: the w3aSubject is stable and opaque (F11)', () => {
  const now = new Date();
  const later = new Date(now.getTime() + 60000);
  const identity = accounts.normalizeIdentity(email('new@example.com'));

  it('an account with a binding uses the binding subject', async () => {
    const user = addUser();
    prisma.nativeWalletBinding.rows.push({ id: 'b1', userId: user.id, connection: CONN, network: 'sapphire_devnet', subject: 'bound-subject', address: '0x1' });
    assert.deepEqual(await accounts.pendingSubjects({ identity, userId: user.id, db: prisma, now }), { pendingUserId: null, w3aSubject: 'bound-subject' });
  });

  it('a new account reuses the open attempt of the same identity', async () => {
    prisma.authLoginAttempt.rows.push({ id: 'a1', intent: 'login', provider: 'email', subject: 'new@example.com', state: 'identified', expiresAt: later, userId: null, pendingUserId: 'pu-1', w3aSubject: 'ws-1' });
    assert.deepEqual(await accounts.pendingSubjects({ identity, userId: null, db: prisma, now }), { pendingUserId: 'pu-1', w3aSubject: 'ws-1' });
  });

  it('expired or completed attempts are not reused; fresh values are random UUIDs, never the user id', async () => {
    prisma.authLoginAttempt.rows.push({ id: 'a1', intent: 'login', provider: 'email', subject: 'new@example.com', state: 'identified', expiresAt: new Date(now.getTime() - 1), userId: null, pendingUserId: 'pu-1', w3aSubject: 'ws-1' });
    prisma.authLoginAttempt.rows.push({ id: 'a2', intent: 'login', provider: 'email', subject: 'new@example.com', state: 'completed', expiresAt: later, userId: null, pendingUserId: 'pu-2', w3aSubject: 'ws-2' });
    const fresh = await accounts.pendingSubjects({ identity, userId: null, db: prisma, now });
    assert.match(fresh.pendingUserId, /^[0-9a-f-]{36}$/);
    assert.match(fresh.w3aSubject, /^[0-9a-f-]{36}$/);
    assert.notEqual(fresh.pendingUserId, fresh.w3aSubject);
  });

  it('an existing account without a binding reuses its open attempt subject', async () => {
    const user = addUser();
    prisma.authLoginAttempt.rows.push({ id: 'a1', intent: 'login', provider: 'google', subject: 'g', state: 'identified', expiresAt: later, userId: user.id, pendingUserId: null, w3aSubject: 'ws-existing' });
    const r = await accounts.pendingSubjects({ identity, userId: user.id, db: prisma, now });
    assert.deepEqual(r, { pendingUserId: null, w3aSubject: 'ws-existing' });
    assert.notEqual(r.w3aSubject, user.id);
  });
});
