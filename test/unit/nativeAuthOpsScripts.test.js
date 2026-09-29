/**
 * BE9 ops scripts (design §9, §3.13): scripts/cleanupSso.js --native,
 * scripts/nativeAuthBackfillIdentities.js, scripts/nativeAuthWalletMigration.js and
 * scripts/nativeAuthOrphanReport.js against the in-memory Prisma stand-in. The Web3Auth nodes are a
 * fake lookup (one address per (connection, subject)); nothing here reaches the network.
 */
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Wallet, getAddress } = require('ethers');
const { installMockPrisma } = require('../helpers/mockPrisma');

const prisma = installMockPrisma({ enforceUnique: true });

const { cleanupSso, cleanupNative, parseArgs: cleanupArgs, NATIVE_RETENTION } = require('../../scripts/cleanupSso');
const backfill = require('../../scripts/nativeAuthBackfillIdentities');
const migration = require('../../scripts/nativeAuthWalletMigration');
const orphans = require('../../scripts/nativeAuthOrphanReport');
const { readNativeAuthConfig } = require('../../src/services/nativeAuth/config');

const LEGACY_EMAIL = 'web3auth-auth0-email-passwordless-sapphire-devnet';
const LEGACY_GOOGLE = 'web3auth-google-sapphire-devnet';
const LEGACY_X = 'web3auth-auth0-twitter-sapphire-devnet';
const LEGACY_APPLE = 'web3auth-apple-sapphire-devnet';
const cfg = readNativeAuthConfig({
  DDC_AUTH_LEGACY_EMAIL_VERIFIERS: LEGACY_EMAIL,
  DDC_AUTH_LEGACY_GOOGLE_VERIFIERS: LEGACY_GOOGLE,
  DDC_AUTH_LEGACY_X_VERIFIERS: LEGACY_X,
});
const lists = backfill.legacyLists(cfg);
const MAINNET = { network: 'sapphire_mainnet', connection: 'ddc-jwt-mainnet' };

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
let seq = 0;
const uid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
const addr = () => Wallet.createRandom().address;

function user(data) {
  const row = {
    id: uid(),
    email: `u${seq}@example.test`,
    walletAddress: null,
    authType: 'web3auth',
    userType: 'regular',
    isOrganization: false,
    disabledAt: null,
    xid: null,
    web3authVerifier: null,
    web3authVerifierId: null,
    ...data,
  };
  prisma.store.user.push(row);
  return row;
}

/** Fake nodes: a stable address per (connection, subject); records every call. */
function fakeLookup() {
  const derived = new Map();
  const calls = [];
  const lookup = async ({ connection, subject, network, clientId }) => {
    calls.push({ connection, subject, network, clientId });
    const key = `${network}|${connection}|${subject}`;
    if (!derived.has(key)) derived.set(key, addr());
    return derived.get(key);
  };
  return { lookup, calls, derived };
}

beforeEach(() => prisma.reset());

// ---------------------------------------------------------------------------------------------
describe('scripts/cleanupSso --native', () => {
  const now = new Date('2026-10-01T12:00:00Z');
  const ago = (ms) => new Date(now.getTime() - ms);

  async function seed() {
    const store = prisma.store;
    store.authFlowState.push(
      { id: 'f-old', kind: 'idp_nonce', valueHash: 'a', data: {}, expiresAt: ago(25 * HOUR), consumedAt: null, createdAt: ago(26 * HOUR) },
      { id: 'f-recent', kind: 'x_oauth', valueHash: 'b', data: {}, expiresAt: ago(23 * HOUR), consumedAt: ago(23 * HOUR), createdAt: ago(24 * HOUR) },
      { id: 'f-live', kind: 'step_up', valueHash: 'c', data: {}, expiresAt: new Date(now.getTime() + 60000), consumedAt: null, createdAt: now },
    );
    store.authEmailChallenge.push(
      { id: 'c-old', email: 'a@x.test', codeHash: 'h', attempts: 0, locale: 'en', expiresAt: ago(24 * HOUR), createdAt: ago(24 * HOUR + 1000), consumedAt: null, lockedAt: null },
      { id: 'c-window', email: 'a@x.test', codeHash: 'h', attempts: 5, locale: 'en', expiresAt: ago(23 * HOUR), createdAt: ago(23 * HOUR + 50 * 60000), consumedAt: null, lockedAt: ago(23 * HOUR) },
    );
    const attempt = (id, extra) => ({ id, loginSecretHash: 'x', intent: 'login', method: 'email', provider: 'email', subject: 's', resolution: 'create', state: 'identified', completedAt: null, ...extra });
    store.authLoginAttempt.push(
      attempt('a-stale', { createdAt: ago(8 * DAY), expiresAt: ago(8 * DAY - 600000) }),
      attempt('a-stale-completing', { state: 'completing', createdAt: ago(9 * DAY), expiresAt: ago(9 * DAY - 600000) }),
      attempt('a-6d', { createdAt: ago(6 * DAY), expiresAt: ago(6 * DAY - 600000) }),
      // An operator-set long TTL keeps an old attempt alive: never purged while unexpired.
      attempt('a-long-ttl', { createdAt: ago(8 * DAY), expiresAt: new Date(now.getTime() + DAY) }),
      attempt('a-done-old', { state: 'completed', createdAt: ago(31 * DAY), expiresAt: ago(31 * DAY), completedAt: ago(31 * DAY) }),
      attempt('a-done-recent', { state: 'completed', createdAt: ago(29 * DAY), expiresAt: ago(29 * DAY), completedAt: ago(29 * DAY) }),
    );
  }

  it('keeps the retention the design and BE3 fixed', () => {
    assert.deepEqual({ ...NATIVE_RETENTION }, { flowStateExpiredHours: 24, emailChallengeHours: 24, incompleteAttemptDays: 7, completedAttemptDays: 30 });
  });

  it('counts first, then deletes exactly the rows past retention; a rerun deletes nothing', async () => {
    await seed();
    const dry = await cleanupNative({ dryRun: true, now });
    assert.deepEqual(dry, { flowStates: 1, emailChallenges: 1, attemptsIncomplete: 2, attemptsCompleted: 1 });
    assert.equal(prisma.store.authLoginAttempt.length, 6, 'a dry run deletes nothing');

    const done = await cleanupNative({ now });
    assert.deepEqual(done, dry);
    assert.deepEqual(prisma.store.authFlowState.map((r) => r.id), ['f-recent', 'f-live']);
    assert.deepEqual(prisma.store.authEmailChallenge.map((r) => r.id), ['c-window'], 'the last 24 h of challenges stay for the rolling counts');
    assert.deepEqual(prisma.store.authLoginAttempt.map((r) => r.id).sort(), ['a-6d', 'a-done-recent', 'a-long-ttl']);

    assert.deepEqual(await cleanupNative({ now }), { flowStates: 0, emailChallenges: 0, attemptsIncomplete: 0, attemptsCompleted: 0 });
  });

  it('does not depend on --older-than-hours (a short window would weaken the e-mail limits)', async () => {
    await seed();
    const result = await cleanupSso({ now, hours: 1, native: true });
    assert.equal(result.native.emailChallenges, 1);
    assert.deepEqual(prisma.store.authEmailChallenge.map((r) => r.id), ['c-window']);
  });

  it('without --native: the same result shape as before and the native tables untouched', async () => {
    await seed();
    const result = await cleanupSso({ now });
    assert.deepEqual(Object.keys(result).sort(), ['authorizations', 'cutoff', 'dryRun', 'tickets']);
    assert.equal(prisma.store.authFlowState.length, 3);
    assert.equal(prisma.store.authEmailChallenge.length, 2);
    assert.equal(prisma.store.authLoginAttempt.length, 6);
  });

  it('parses --native next to the existing flags', () => {
    assert.deepEqual(cleanupArgs([]), { dryRun: false, hours: 24, native: false });
    assert.deepEqual(cleanupArgs(['--dry-run', '--native', '--older-than-hours=48']), { dryRun: true, hours: 48, native: true });
  });
});

// ---------------------------------------------------------------------------------------------
describe('scripts/nativeAuthBackfillIdentities', () => {
  it('maps only the linkable legacy pairs', () => {
    assert.deepEqual(backfill.identityForPair(LEGACY_EMAIL, ' Ann@Example.com ', lists).identity,
      { provider: 'email', subject: 'ann@example.com', email: 'ann@example.com', emailLinkGrade: 'strong', linkedVia: 'backfill_legacy_email' });
    assert.equal(backfill.identityForPair(LEGACY_GOOGLE, 'bob@gmail.com', lists).identity.linkedVia, 'backfill_legacy_google');
    assert.deepEqual(backfill.identityForPair(LEGACY_GOOGLE, 'bob@corp.example', lists), { skip: 'google_not_gmail' });
    assert.deepEqual(backfill.identityForPair(LEGACY_X, 'twitter|12345', lists).identity,
      { provider: 'x', subject: '12345', email: null, emailLinkGrade: 'none', linkedVia: 'backfill_legacy_x' });
    assert.deepEqual(backfill.identityForPair(LEGACY_X, 'twitter|abc', lists), { skip: 'malformed_pair' });
    assert.deepEqual(backfill.identityForPair(LEGACY_EMAIL, 'not-an-email', lists), { skip: 'malformed_pair' });
    assert.equal(backfill.identityForPair(LEGACY_APPLE, 'apple-sub', lists), null);
    assert.equal(backfill.identityForPair('external-wallet', '0xabc', lists), null);
  });

  it('normalises e-mail pairs exactly as the OTP path does (IDN domain, trailing dot)', () => {
    const { normalizeEmail } = require('../../src/services/nativeAuth/emailGuard');
    const idn = backfill.identityForPair(LEGACY_EMAIL, ' Ann@Bücher.Example. ', lists);
    assert.equal(idn.identity.subject, 'ann@xn--bcher-kva.example');
    assert.equal(idn.identity.subject, normalizeEmail(' Ann@Bücher.Example. '));
    assert.equal(idn.identity.email, idn.identity.subject);
    assert.equal(idn.legacyId, 'ann@bücher.example.', 'the pair keeps its own spelling for the ambiguity check');
    assert.equal(backfill.identityForPair(LEGACY_GOOGLE, 'Bob@Gmail.com.', lists).identity.subject, 'bob@gmail.com');
    // An address the OTP path refuses can never be signed in natively: not backfilled.
    assert.deepEqual(backfill.identityForPair(LEGACY_EMAIL, 'a b@example.com', lists), { skip: 'malformed_pair' });
    assert.deepEqual(backfill.identityForPair(LEGACY_EMAIL, 'ann@localhost', lists), { skip: 'malformed_pair' });
  });

  it('the ambiguity check also matches another legacy pair spelled like the original (IDN)', async () => {
    const a = user({ web3authVerifier: LEGACY_EMAIL, web3authVerifierId: 'zoe@bücher.example' });
    user({ web3authVerifier: LEGACY_EMAIL, web3authVerifierId: 'ZOE@Bücher.example' });
    const plan = await backfill.planUserIdentity({ user: a, lists, db: prisma });
    assert.deepEqual(plan, { status: 'skip', reason: 'ambiguous' });
  });

  it('dry run writes nothing; --write creates; a rerun finds everything present', async () => {
    const a = user({ web3authVerifier: LEGACY_EMAIL, web3authVerifierId: 'ann@example.com' });
    const b = user({ web3authVerifier: LEGACY_X, web3authVerifierId: 'twitter|777' });
    user({ web3authVerifier: LEGACY_GOOGLE, web3authVerifierId: 'carl@corp.example' });
    user({ web3authVerifier: LEGACY_APPLE, web3authVerifierId: 'apple-sub' });
    user({ authType: 'traditional' });

    const dry = await backfill.backfillIdentities({ db: prisma, cfg, batchSize: 2 });
    assert.equal(dry.scanned, 3, 'only pairs of listed legacy verifiers are scanned');
    assert.deepEqual(dry.create, { email: 1, x: 1 });
    assert.deepEqual(dry.skipped, { google_not_gmail: 1 });
    assert.equal(prisma.store.authIdentity.length, 0);

    const done = await backfill.backfillIdentities({ db: prisma, cfg, write: true, batchSize: 2 });
    assert.deepEqual(done.created, { email: 1, x: 1 });
    const rows = prisma.store.authIdentity.map((r) => [r.userId, r.provider, r.subject, r.emailLinkGrade, r.linkedVia]);
    assert.deepEqual(rows.sort(), [
      [a.id, 'email', 'ann@example.com', 'strong', 'backfill_legacy_email'],
      [b.id, 'x', '777', 'none', 'backfill_legacy_x'],
    ].sort());

    const again = await backfill.backfillIdentities({ db: prisma, cfg, write: true });
    assert.deepEqual(again.created, { email: 0, x: 0 });
    assert.equal(again.present, 2);
    assert.equal(prisma.store.authIdentity.length, 2);
  });

  it('never merges: ambiguous evidence, identities or strong e-mails held elsewhere, organisations', async () => {
    // Two legacy pairs for one Gmail address (rule 3b would answer 'ambiguous').
    user({ web3authVerifier: LEGACY_EMAIL, web3authVerifierId: 'dup@gmail.com' });
    user({ web3authVerifier: LEGACY_GOOGLE, web3authVerifierId: 'Dup@gmail.com' });
    // A native account already owns the X identity.
    const nativeX = user({});
    prisma.store.authIdentity.push({ id: 'i1', userId: nativeX.id, provider: 'x', subject: '999', email: null, emailLinkGrade: 'none', linkedVia: 'created' });
    user({ web3authVerifier: LEGACY_X, web3authVerifierId: 'twitter|999' });
    // A strong Google identity on another account carries the address.
    const other = user({});
    prisma.store.authIdentity.push({ id: 'i2', userId: other.id, provider: 'google', subject: 'g-1', email: 'eve@gmail.com', emailLinkGrade: 'strong', linkedVia: 'created' });
    user({ web3authVerifier: LEGACY_GOOGLE, web3authVerifierId: 'eve@gmail.com' });
    // An old pair already migrated to another account (web3auth_legacy identity).
    const migrated = user({});
    prisma.store.authIdentity.push({ id: 'i3', userId: migrated.id, provider: 'web3auth_legacy', subject: `${LEGACY_EMAIL}|fay@example.com`, email: null, emailLinkGrade: 'none', linkedVia: 'network_migration' });
    user({ web3authVerifier: LEGACY_EMAIL, web3authVerifierId: 'fay@example.com' });
    user({ web3authVerifier: LEGACY_EMAIL, web3authVerifierId: 'org@example.com', userType: 'organization' });

    const done = await backfill.backfillIdentities({ db: prisma, cfg, write: true });
    assert.deepEqual(done.created, { email: 0, x: 0 });
    assert.deepEqual(done.skipped, { ambiguous: 3, identity_owned_elsewhere: 1, strong_email_owned_elsewhere: 1, organization: 1 });
    assert.equal(prisma.store.authIdentity.length, 3);
  });

  it('counts a unique race instead of failing', async () => {
    user({ web3authVerifier: LEGACY_EMAIL, web3authVerifierId: 'race@example.com' });
    const realCreate = prisma.authIdentity.create;
    prisma.authIdentity.create = async () => {
      const err = new Error('unique');
      err.code = 'P2002';
      throw err;
    };
    try {
      const done = await backfill.backfillIdentities({ db: prisma, cfg, write: true });
      assert.equal(done.races, 1);
    } finally {
      prisma.authIdentity.create = realCreate;
    }
  });

  it('prints counts only and does nothing without legacy verifier lists', async () => {
    user({ web3authVerifier: LEGACY_EMAIL, web3authVerifierId: 'secret-person@example.com' });
    const summary = await backfill.backfillIdentities({ db: prisma, cfg, write: false });
    assert.equal(JSON.stringify(summary).includes('secret-person'), false);
    const none = await backfill.backfillIdentities({ db: prisma, cfg: readNativeAuthConfig({}), write: true });
    assert.match(none.note, /all empty/);
    assert.equal(prisma.store.authIdentity.length, 0);
  });

  it('safeError never repeats a Prisma message (it quotes query arguments)', () => {
    const err = new Error('Invalid `prisma.user.findMany()` invocation: where: { email: "ann@example.com" }');
    err.name = 'PrismaClientValidationError';
    assert.equal(backfill.safeError(err), 'PrismaClientValidationError');
    const known = Object.assign(new Error('Unique constraint failed on ann@example.com'), { code: 'P2002' });
    assert.equal(backfill.safeError(known), 'Error P2002');
  });

  it('rejects unknown arguments and defaults to a dry run', () => {
    assert.equal(backfill.parseArgs([]).write, false);
    assert.equal(backfill.parseArgs(['--write']).write, true);
    assert.throws(() => backfill.parseArgs(['--apply']), /unknown argument/);
    assert.throws(() => backfill.parseArgs(['--batch-size=0']), /batch-size/);
  });
});

// ---------------------------------------------------------------------------------------------
describe('scripts/nativeAuthWalletMigration', () => {
  function seedAccounts() {
    const legacy = user({ walletAddress: addr(), web3authVerifier: LEGACY_EMAIL, web3authVerifierId: 'leg@example.com', email: 'leg@example.com' });
    const devnetNative = user({ walletAddress: addr(), web3authVerifier: 'ddc-jwt-devnet' });
    devnetNative.web3authVerifierId = devnetNative.id;
    const subject = crypto.randomUUID();
    prisma.store.nativeWalletBinding.push({ id: 'b-native', userId: devnetNative.id, connection: 'ddc-jwt-devnet', network: 'sapphire_devnet', subject, address: devnetNative.walletAddress, boundAt: new Date() });
    const external = user({ walletAddress: addr(), web3authVerifier: 'external-wallet', web3authVerifierId: 'wallet' });
    const unpaired = user({ walletAddress: addr() });
    const org = user({ walletAddress: addr(), web3authVerifier: LEGACY_EMAIL, web3authVerifierId: 'org@example.com', isOrganization: true });
    const noWallet = user({ web3authVerifier: LEGACY_EMAIL, web3authVerifierId: 'nowallet@example.com' });
    return { legacy, devnetNative, subject, external, unpaired, org, noWallet };
  }

  it('refuses illegal targets', () => {
    assert.throws(() => migration.assertTarget({ network: 'mainnet', connection: 'x' }, cfg), /--network/);
    assert.throws(() => migration.assertTarget({ network: 'sapphire_mainnet', connection: '' }, cfg), /--connection/);
    assert.throws(() => migration.assertTarget({ network: 'sapphire_mainnet', connection: 'ddc-jwt-devnet' }, cfg), /devnet/);
    assert.throws(() => migration.assertTarget({ network: 'sapphire_mainnet', connection: 'ddc-jwt-test' }, cfg), /devnet\/test/);
    assert.throws(() => migration.assertTarget({ network: 'sapphire_devnet', connection: LEGACY_EMAIL }, cfg), /legacy verifier/);
    assert.throws(() => migration.assertTarget({ network: 'sapphire_devnet', connection: 'external-wallet' }, cfg), /external-wallet/);
    assert.doesNotThrow(() => migration.assertTarget(MAINNET, cfg));
    assert.doesNotThrow(() => migration.assertTarget({ network: 'sapphire_devnet', connection: 'ddc-jwt-devnet-2' }, cfg, { nodeEnv: 'development' }));
  });

  it('on production refuses any non-mainnet or devnet/test target unless explicitly overridden', () => {
    const prodCfg = readNativeAuthConfig({ DDC_AUTH_ENV: 'prod', DDC_AUTH_LEGACY_EMAIL_VERIFIERS: LEGACY_EMAIL });
    const devnet = { network: 'sapphire_devnet', connection: 'ddc-jwt-devnet' };
    assert.throws(() => migration.assertTarget(devnet, prodCfg, { nodeEnv: 'development' }), /production .* --allow-non-prod-target/);
    assert.throws(() => migration.assertTarget({ network: 'sapphire_devnet', connection: 'ddc-jwt-other' }, prodCfg, { nodeEnv: '' }), /production/);
    assert.throws(() => migration.assertTarget(devnet, cfg, { nodeEnv: 'production' }), /production/, 'NODE_ENV=production counts too');
    assert.doesNotThrow(() => migration.assertTarget(MAINNET, prodCfg, { nodeEnv: 'production' }));
    assert.doesNotThrow(() => migration.assertTarget(devnet, prodCfg, { allowNonProd: true, nodeEnv: 'production' }));
    // The override never relaxes the mainnet rule itself.
    assert.throws(() => migration.assertTarget({ network: 'sapphire_mainnet', connection: 'ddc-jwt-devnet' }, prodCfg, { allowNonProd: true }), /devnet/);
    assert.equal(migration.isProduction(cfg, 'test'), false);
    // A DDC_AUTH_ENV that config does not know (e.g. 'production') fails safe as production.
    const typo = readNativeAuthConfig({ DDC_AUTH_ENV: 'production' });
    assert.equal(migration.isProduction(typo, ''), true);
    assert.throws(() => migration.assertTarget(devnet, typo, { nodeEnv: '' }), /production/);
    assert.equal(migration.isProduction(readNativeAuthConfig({ DDC_AUTH_ENV: 'local' }), ''), false);
    assert.equal(migration.isProduction(readNativeAuthConfig({ DDC_AUTH_ENV: 'test' }), ''), false);
    assert.equal(migration.parseArgs(['--apply', '--allow-non-prod-target']).allowNonProd, true);
    assert.equal(migration.parseArgs(['--apply']).allowNonProd, false);
  });

  it('parses exactly one mode; dry run unless --write; --export is read-only', () => {
    const plan = migration.parseArgs(['--plan', '--network', 'sapphire_mainnet', '--connection=ddc-jwt-mainnet']);
    assert.deepEqual([plan.modes, plan.write, plan.network, plan.connection], [['plan'], false, 'sapphire_mainnet', 'ddc-jwt-mainnet']);
    assert.equal(migration.parseArgs(['--apply', '--write']).write, true);
    assert.equal(migration.parseArgs(['--export', 'out.csv']).exportFile, 'out.csv');
    assert.throws(() => migration.parseArgs(['--plan', '--apply']), /exactly one/);
    assert.throws(() => migration.parseArgs([]), /exactly one/);
    assert.throws(() => migration.parseArgs(['--export=out.csv', '--write']), /read-only/);
    assert.throws(() => migration.parseArgs(['--plan', '--concurrency=0']), /concurrency/);
    assert.throws(() => migration.parseArgs(['--plan', '--yes']), /unknown argument/);
  });

  it('--plan dry run classifies without a single lookup or write', async () => {
    seedAccounts();
    const lookup = async () => assert.fail('a dry run must not ask the nodes');
    const summary = await migration.planMigration({ target: MAINNET, db: prisma, lookup, batchSize: 2 });
    assert.equal(summary.mode, 'dry-run');
    assert.deepEqual(summary.classes, { legacy: 1, native: 1, external: 1, unpaired: 1, organization: 1 });
    assert.equal(prisma.store.walletAddressHistory.length, 0);
    assert.equal(prisma.store.nativeWalletBinding.length, 1);
  });

  it('--plan --write needs the target client id', async () => {
    await assert.rejects(migration.planMigration({ target: MAINNET, db: prisma, write: true, lookup: async () => addr() }), /client id/);
  });

  it('--plan --write: binding + planned row for legacy, same subject for native, not_needed for external; reruns are no-ops', async () => {
    const s = seedAccounts();
    const nodes = fakeLookup();
    const summary = await migration.planMigration({ target: MAINNET, clientId: 'cid-main', write: true, db: prisma, lookup: nodes.lookup, batchSize: 2, concurrency: 2 });
    assert.deepEqual(summary.outcomes, { planned_legacy: 1, planned_native: 1, planned_external: 1 });

    // Legacy: a new binding on the target with a fresh opaque subject (never the user id).
    const legacyBinding = prisma.store.nativeWalletBinding.find((b) => b.userId === s.legacy.id);
    assert.equal(legacyBinding.connection, 'ddc-jwt-mainnet');
    assert.equal(legacyBinding.network, 'sapphire_mainnet');
    assert.notEqual(legacyBinding.subject, s.legacy.id);
    assert.match(legacyBinding.subject, /^[0-9a-f-]{36}$/);
    const legacyRow = prisma.store.walletAddressHistory.find((r) => r.userId === s.legacy.id);
    assert.deepEqual(
      [legacyRow.oldAddress, legacyRow.oldVerifier, legacyRow.oldVerifierId, legacyRow.oldNetwork, legacyRow.newAddress, legacyRow.newVerifier, legacyRow.newSubjectRef, legacyRow.newNetwork, legacyRow.reason, legacyRow.status, legacyRow.chainStatus],
      [s.legacy.walletAddress, LEGACY_EMAIL, 'leg@example.com', 'sapphire_devnet', legacyBinding.address, 'ddc-jwt-mainnet', legacyBinding.id, 'sapphire_mainnet', 'network_migration', 'planned', 'pending'],
    );
    assert.equal(s.legacy.walletAddress !== legacyBinding.address, true, 'the account keeps its old wallet until --apply');

    // Native: looked up for the SAME subject on the target; the live binding is untouched.
    const nativeCall = nodes.calls.find((c) => c.subject === s.subject);
    assert.deepEqual(nativeCall, { connection: 'ddc-jwt-mainnet', subject: s.subject, network: 'sapphire_mainnet', clientId: 'cid-main' });
    const nativeBinding = prisma.store.nativeWalletBinding.find((b) => b.id === 'b-native');
    assert.deepEqual([nativeBinding.connection, nativeBinding.address], ['ddc-jwt-devnet', s.devnetNative.walletAddress]);
    const nativeRow = prisma.store.walletAddressHistory.find((r) => r.userId === s.devnetNative.id);
    assert.deepEqual([nativeRow.oldVerifier, nativeRow.oldVerifierId, nativeRow.oldNetwork, nativeRow.newSubjectRef], ['ddc-jwt-devnet', null, 'sapphire_devnet', 'b-native']);

    // External wallet: address unchanged, nothing for the chain team.
    const extRow = prisma.store.walletAddressHistory.find((r) => r.userId === s.external.id);
    assert.deepEqual([extRow.newAddress, extRow.chainStatus, extRow.newVerifier, extRow.newSubjectRef], [s.external.walletAddress, 'not_needed', 'external-wallet', 'none']);

    // No subject anywhere outside the binding table.
    const everythingElse = JSON.stringify([prisma.store.walletAddressHistory, prisma.store.user, summary]);
    for (const b of prisma.store.nativeWalletBinding) assert.equal(everythingElse.includes(b.subject), false);

    const again = await migration.planMigration({ target: MAINNET, clientId: 'cid-main', write: true, db: prisma, lookup: nodes.lookup });
    assert.deepEqual(again.outcomes, {});
    assert.equal(again.classes.already_planned, 3);
    assert.equal(prisma.store.walletAddressHistory.length, 3);
    assert.equal(nodes.calls.length, 2);
  });

  it('a failed lookup writes nothing for that account and the next run retries it', async () => {
    const s = seedAccounts();
    const nodes = fakeLookup();
    const { NativeAuthError } = require('../../src/controllers/nativeAuth/respond');
    const flaky = async (args) => {
      if (args.subject !== s.subject) throw new NativeAuthError('W3A_LOOKUP_UNAVAILABLE');
      return nodes.lookup(args);
    };
    const first = await migration.planMigration({ target: MAINNET, clientId: 'c', write: true, db: prisma, lookup: flaky });
    assert.deepEqual(first.outcomes, { lookup_failed: 1, planned_native: 1, planned_external: 1 });
    assert.equal(prisma.store.nativeWalletBinding.some((b) => b.userId === s.legacy.id), false);
    const second = await migration.planMigration({ target: MAINNET, clientId: 'c', write: true, db: prisma, lookup: nodes.lookup });
    assert.deepEqual(second.outcomes, { planned_legacy: 1 });
  });

  it('--limit caps the accounts planned per run', async () => {
    seedAccounts();
    const nodes = fakeLookup();
    const summary = await migration.planMigration({ target: MAINNET, clientId: 'c', write: true, db: prisma, lookup: nodes.lookup, limit: 1 });
    assert.equal(Object.values(summary.outcomes).reduce((a, b) => a + b, 0), 1);
  });

  it('--export: the four columns only, sorted, never a subject', async () => {
    seedAccounts();
    const nodes = fakeLookup();
    await migration.planMigration({ target: MAINNET, clientId: 'c', write: true, db: prisma, lookup: nodes.lookup });
    const { csv, count } = await migration.exportRows({ target: MAINNET, db: prisma });
    const lines = csv.trim().split('\n');
    assert.equal(count, 3);
    assert.equal(lines[0], 'userId,oldAddress,newAddress,chainStatus');
    assert.equal(lines.length, 4);
    for (const line of lines.slice(1)) assert.match(line, /^[0-9a-f-]{36},0x[0-9a-fA-F]{40},0x[0-9a-fA-F]{40},(pending|not_needed)$/);
    for (const b of prisma.store.nativeWalletBinding) assert.equal(csv.includes(b.subject), false);
    const other = await migration.exportRows({ target: { network: 'sapphire_mainnet', connection: 'ddc-jwt-other' }, db: prisma });
    assert.equal(other.count, 1, 'another target sees only the external-wallet rows of that network');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'be9-export-'));
    try {
      const file = path.join(dir, 'm.csv');
      migration.writeExport(file, csv);
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      assert.throws(() => migration.writeExport(file, csv), /EEXIST/);
      migration.writeExport(file, csv, { force: true });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    assert.equal(migration.csvCell('=cmd'), "'=cmd");
  });

  it('--apply dry run checks every row and writes nothing', async () => {
    const s = seedAccounts();
    await migration.planMigration({ target: MAINNET, clientId: 'c', write: true, db: prisma, lookup: fakeLookup().lookup });
    const before = JSON.stringify(prisma.store);
    const summary = await migration.applyMigration({ target: MAINNET, db: prisma, cfg });
    assert.deepEqual(summary.outcomes, { would_apply_legacy: 1, would_apply_native: 1, would_apply_external: 1 });
    assert.equal(JSON.stringify(prisma.store), before);
    assert.ok(s.legacy.walletAddress);
  });

  it('--apply --write moves wallet, binding and pair, keeps the old pair, backfills, and is idempotent', async () => {
    const s = seedAccounts();
    const oldLegacyWallet = s.legacy.walletAddress;
    await migration.planMigration({ target: MAINNET, clientId: 'c', write: true, db: prisma, lookup: fakeLookup().lookup });
    const legacyBinding = prisma.store.nativeWalletBinding.find((b) => b.userId === s.legacy.id);
    const nativeRow = prisma.store.walletAddressHistory.find((r) => r.userId === s.devnetNative.id);
    const now = new Date('2026-12-01T00:00:00Z');

    const summary = await migration.applyMigration({ target: MAINNET, db: prisma, cfg, write: true, now, batchSize: 2 });
    assert.deepEqual(summary.outcomes, { applied_legacy_identity_backfilled: 1, applied_native: 1, applied_external: 1 });

    const legacy = prisma.store.user.find((u) => u.id === s.legacy.id);
    assert.deepEqual([legacy.walletAddress, legacy.web3authVerifier, legacy.web3authVerifierId], [legacyBinding.address, 'ddc-jwt-mainnet', s.legacy.id]);
    const ids = prisma.store.authIdentity.filter((r) => r.userId === s.legacy.id).map((r) => [r.provider, r.subject, r.linkedVia]).sort();
    assert.deepEqual(ids, [
      ['email', 'leg@example.com', 'backfill_legacy_email'],
      ['web3auth_legacy', `${LEGACY_EMAIL}|leg@example.com`, 'network_migration'],
    ]);
    assert.notEqual(legacy.walletAddress, oldLegacyWallet);

    const native = prisma.store.user.find((u) => u.id === s.devnetNative.id);
    const binding = prisma.store.nativeWalletBinding.find((b) => b.id === 'b-native');
    assert.deepEqual([binding.connection, binding.network, binding.address, binding.subject], ['ddc-jwt-mainnet', 'sapphire_mainnet', nativeRow.newAddress, s.subject]);
    assert.deepEqual([native.walletAddress, native.web3authVerifier], [nativeRow.newAddress, 'ddc-jwt-mainnet']);

    const external = prisma.store.user.find((u) => u.id === s.external.id);
    assert.equal(external.walletAddress, s.external.walletAddress);
    assert.ok(prisma.store.walletAddressHistory.every((r) => r.status === 'applied' && r.appliedAt.getTime() === now.getTime()));

    const again = await migration.applyMigration({ target: MAINNET, db: prisma, cfg, write: true, now });
    assert.equal(again.scanned, 0);
    const replan = await migration.planMigration({ target: MAINNET, clientId: 'c', write: true, db: prisma, lookup: async () => assert.fail('no lookup after apply') });
    assert.deepEqual(replan.outcomes, {});
  });

  it('--apply skips rows whose account changed since the plan, and wallets held by others', async () => {
    const s = seedAccounts();
    await migration.planMigration({ target: MAINNET, clientId: 'c', write: true, db: prisma, lookup: fakeLookup().lookup });
    s.legacy.walletAddress = addr(); // changed after the plan
    const nativeRow = prisma.store.walletAddressHistory.find((r) => r.userId === s.devnetNative.id);
    user({ walletAddress: nativeRow.newAddress.toLowerCase() }); // someone holds the new address
    const summary = await migration.applyMigration({ target: MAINNET, db: prisma, cfg, write: true });
    assert.deepEqual(summary.outcomes, { skipped_stale: 1, skipped_wallet_in_use: 1, applied_external: 1 });
    assert.equal(prisma.store.walletAddressHistory.filter((r) => r.status === 'planned').length, 2);
    assert.equal(prisma.store.nativeWalletBinding.find((b) => b.id === 'b-native').connection, 'ddc-jwt-devnet');
  });

  it('--apply skips a legacy account whose pair changed since the plan (same wallet)', async () => {
    const s = seedAccounts();
    await migration.planMigration({ target: MAINNET, clientId: 'c', write: true, db: prisma, lookup: fakeLookup().lookup });
    const wallet = s.legacy.walletAddress;
    s.legacy.web3authVerifierId = 'someone-else@example.com'; // re-linked after the plan, wallet unchanged
    const summary = await migration.applyMigration({ target: MAINNET, db: prisma, cfg, write: true });
    assert.deepEqual(summary.outcomes, { skipped_stale: 1, applied_native: 1, applied_external: 1 });
    const legacy = prisma.store.user.find((u) => u.id === s.legacy.id);
    assert.deepEqual([legacy.walletAddress, legacy.web3authVerifier], [wallet, LEGACY_EMAIL]);
    assert.equal(prisma.store.authIdentity.some((r) => r.userId === s.legacy.id), false, 'nothing backfilled for a stale row');
    assert.equal(prisma.store.walletAddressHistory.find((r) => r.userId === s.legacy.id).status, 'planned');

    const verifierChanged = seedAccounts();
    const replan = await migration.planMigration({ target: MAINNET, clientId: 'c', write: true, db: prisma, lookup: fakeLookup().lookup });
    assert.equal(replan.superseded, 1, 'the first stale row is superseded by this plan');
    verifierChanged.legacy.web3authVerifier = LEGACY_GOOGLE;
    const again = await migration.applyMigration({ target: MAINNET, db: prisma, cfg, write: true });
    assert.equal(again.outcomes.skipped_stale, 1);
    assert.equal(prisma.store.walletAddressHistory.find((r) => r.userId === verifierChanged.legacy.id).status, 'planned');
    assert.equal(prisma.store.walletAddressHistory.find((r) => r.userId === s.legacy.id).status, 'applied');
  });

  it('a legacy row skipped as stale (wallet changed) is superseded by the next plan and then applied', async () => {
    const s = seedAccounts();
    const nodes = fakeLookup();
    await migration.planMigration({ target: MAINNET, clientId: 'c', write: true, db: prisma, lookup: nodes.lookup });
    const binding = prisma.store.nativeWalletBinding.find((b) => b.userId === s.legacy.id);
    const oldRowId = prisma.store.walletAddressHistory.find((r) => r.userId === s.legacy.id).id;
    const changed = addr();
    s.legacy.walletAddress = changed;
    const skipped = await migration.applyMigration({ target: MAINNET, db: prisma, cfg, write: true });
    assert.deepEqual(skipped.outcomes, { skipped_stale: 1, applied_native: 1, applied_external: 1 });

    // A dry run shows the re-plan and changes nothing.
    const before = JSON.stringify(prisma.store);
    const dry = await migration.planMigration({ target: MAINNET, db: prisma, lookup: async () => assert.fail('no lookup in a dry run') });
    assert.equal(dry.superseded, 1);
    assert.equal(dry.classes.binding_repair, 1);
    assert.equal(JSON.stringify(prisma.store), before);

    const callsBefore = nodes.calls.length;
    const replan = await migration.planMigration({ target: MAINNET, clientId: 'c', write: true, db: prisma, lookup: nodes.lookup });
    assert.equal(replan.superseded, 1);
    assert.deepEqual(replan.outcomes, { planned_repaired: 1 });
    assert.equal(nodes.calls.length, callsBefore, 'the planned-only binding is reused, no new key assignment');
    const rows = prisma.store.walletAddressHistory.filter((r) => r.userId === s.legacy.id);
    assert.equal(rows.length, 1, 'the superseded row is gone');
    assert.notEqual(rows[0].id, oldRowId);
    assert.deepEqual(
      [rows[0].status, rows[0].oldAddress, rows[0].oldVerifier, rows[0].oldVerifierId, rows[0].newAddress, rows[0].newSubjectRef],
      ['planned', changed, LEGACY_EMAIL, 'leg@example.com', binding.address, binding.id],
    );
    const { csv } = await migration.exportRows({ target: MAINNET, db: prisma });
    const lines = csv.split('\n').filter((l) => l.startsWith(`${s.legacy.id},`));
    assert.deepEqual(lines, [`${s.legacy.id},${changed},${binding.address},pending`], 'the export lists only the current plan');

    const applied = await migration.applyMigration({ target: MAINNET, db: prisma, cfg, write: true });
    assert.deepEqual(applied.outcomes, { applied_legacy_identity_backfilled: 1 });
    const legacy = prisma.store.user.find((u) => u.id === s.legacy.id);
    assert.deepEqual([legacy.walletAddress, legacy.web3authVerifier, legacy.web3authVerifierId], [binding.address, 'ddc-jwt-mainnet', s.legacy.id]);
    const settled = await migration.planMigration({ target: MAINNET, clientId: 'c', write: true, db: prisma, lookup: nodes.lookup });
    assert.deepEqual([settled.superseded, settled.outcomes], [0, {}], 'an applied row is never superseded');
  });

  it('a legacy row skipped as stale (pair changed, same wallet) is re-planned with the current pair', async () => {
    const s = seedAccounts();
    await migration.planMigration({ target: MAINNET, clientId: 'c', write: true, db: prisma, lookup: fakeLookup().lookup });
    s.legacy.web3authVerifier = LEGACY_GOOGLE;
    s.legacy.web3authVerifierId = 'relinked@gmail.com';
    assert.equal((await migration.applyMigration({ target: MAINNET, db: prisma, cfg, write: true })).outcomes.skipped_stale, 1);
    const replan = await migration.planMigration({ target: MAINNET, clientId: 'c', write: true, db: prisma, lookup: async () => assert.fail('reuses the binding') });
    assert.deepEqual([replan.superseded, replan.outcomes], [1, { planned_repaired: 1 }]);
    const row = prisma.store.walletAddressHistory.find((r) => r.userId === s.legacy.id);
    assert.deepEqual([row.oldVerifier, row.oldVerifierId], [LEGACY_GOOGLE, 'relinked@gmail.com']);
    const applied = await migration.applyMigration({ target: MAINNET, db: prisma, cfg, write: true });
    assert.deepEqual(applied.outcomes, { applied_legacy_identity_backfilled: 1 });
    assert.ok(prisma.store.authIdentity.some((r) => r.provider === 'web3auth_legacy' && r.subject === `${LEGACY_GOOGLE}|relinked@gmail.com`));
  });

  it('an external row skipped as stale is superseded by a fresh external row', async () => {
    const s = seedAccounts();
    await migration.planMigration({ target: MAINNET, clientId: 'c', write: true, db: prisma, lookup: fakeLookup().lookup });
    const other = addr();
    s.external.walletAddress = other; // switched to another external wallet
    assert.equal((await migration.applyMigration({ target: MAINNET, db: prisma, cfg, write: true })).outcomes.skipped_stale, 1);
    const replan = await migration.planMigration({ target: MAINNET, clientId: 'c', write: true, db: prisma, lookup: fakeLookup().lookup });
    assert.deepEqual([replan.superseded, replan.outcomes], [1, { planned_external: 1 }]);
    const rows = prisma.store.walletAddressHistory.filter((r) => r.userId === s.external.id);
    assert.deepEqual(rows.map((r) => [r.status, r.oldAddress, r.newAddress, r.chainStatus]), [['planned', other, other, 'not_needed']]);
    assert.deepEqual((await migration.applyMigration({ target: MAINNET, db: prisma, cfg, write: true })).outcomes, { applied_external: 1 });
    assert.equal(prisma.store.user.find((u) => u.id === s.external.id).walletAddress, other);
  });

  it('a planned legacy account that moved to an external wallet is re-planned as external, never onto the binding', async () => {
    const s = seedAccounts();
    await migration.planMigration({ target: MAINNET, clientId: 'c', write: true, db: prisma, lookup: fakeLookup().lookup });
    const external = addr();
    Object.assign(s.legacy, { walletAddress: external, web3authVerifier: 'external-wallet', web3authVerifierId: 'wallet' });
    const replan = await migration.planMigration({ target: MAINNET, clientId: 'c', write: true, db: prisma, lookup: fakeLookup().lookup });
    assert.deepEqual([replan.superseded, replan.outcomes], [1, { planned_external: 1 }]);
    const applied = await migration.applyMigration({ target: MAINNET, db: prisma, cfg, write: true });
    assert.deepEqual(applied.outcomes, { applied_external: 2, applied_native: 1 }, 'the moved account and the seeded external one');
    const after = prisma.store.user.find((u) => u.id === s.legacy.id);
    assert.deepEqual([after.walletAddress, after.web3authVerifier], [external, 'external-wallet']);
    assert.equal(prisma.store.authIdentity.some((r) => r.userId === s.legacy.id), false);
  });

  it('a planned row whose binding is gone is superseded and the account is planned afresh', async () => {
    const s = seedAccounts();
    const nodes = fakeLookup();
    await migration.planMigration({ target: MAINNET, clientId: 'c', write: true, db: prisma, lookup: nodes.lookup });
    const gone = prisma.store.nativeWalletBinding.findIndex((b) => b.userId === s.legacy.id);
    prisma.store.nativeWalletBinding.splice(gone, 1);
    assert.equal((await migration.applyMigration({ target: MAINNET, db: prisma, cfg })).outcomes.skipped_binding_missing, 1);
    const replan = await migration.planMigration({ target: MAINNET, clientId: 'c', write: true, db: prisma, lookup: nodes.lookup });
    assert.deepEqual([replan.superseded, replan.outcomes], [1, { planned_legacy: 1 }]);
    const binding = prisma.store.nativeWalletBinding.find((b) => b.userId === s.legacy.id);
    const rows = prisma.store.walletAddressHistory.filter((r) => r.userId === s.legacy.id);
    assert.deepEqual(rows.map((r) => r.newSubjectRef), [binding.id]);
  });

  it('a superseded row that a concurrent apply claimed first keeps counting', async () => {
    const s = seedAccounts();
    await migration.planMigration({ target: MAINNET, clientId: 'c', write: true, db: prisma, lookup: fakeLookup().lookup });
    s.legacy.walletAddress = addr();
    const realDeleteMany = prisma.walletAddressHistory.deleteMany;
    prisma.walletAddressHistory.deleteMany = async () => ({ count: 0 });
    try {
      const replan = await migration.planMigration({ target: MAINNET, clientId: 'c', write: true, db: prisma, lookup: async () => assert.fail('nothing to plan') });
      assert.deepEqual([replan.superseded, replan.classes.already_planned, replan.outcomes], [0, 3, {}]);
    } finally {
      prisma.walletAddressHistory.deleteMany = realDeleteMany;
    }
    assert.equal(prisma.store.walletAddressHistory.length, 3);
  });

  it('classify never moves a non-legacy pair onto a binding that is not its wallet', () => {
    const b = { id: 'b', userId: 'u', connection: MAINNET.connection, network: MAINNET.network, address: addr() };
    const base = { id: 'u', walletAddress: addr() };
    const kind = (u) => migration.classify({ user: { ...base, ...u }, binding: b, rows: [], target: MAINNET });
    assert.equal(kind({ web3authVerifier: LEGACY_EMAIL, web3authVerifierId: 'a@b.c' }), 'binding_repair');
    assert.equal(kind({ web3authVerifier: 'external-wallet', web3authVerifierId: 'w' }), 'external');
    assert.equal(kind({ web3authVerifier: 'ddc-jwt-devnet', web3authVerifierId: 'u' }), 'native_binding_not_live');
    assert.equal(kind({}), 'unpaired');
    assert.equal(migration.classify({ user: { ...base, web3authVerifier: LEGACY_EMAIL, web3authVerifierId: 'a' }, binding: { ...b, connection: 'ddc-jwt-other' }, rows: [], target: MAINNET }), 'planned_elsewhere');
  });

  it('--apply writes nothing when another run claimed the row first', async () => {
    const s = seedAccounts();
    await migration.planMigration({ target: MAINNET, clientId: 'c', write: true, db: prisma, lookup: fakeLookup().lookup });
    const oldWallet = s.legacy.walletAddress;
    const realUpdateMany = prisma.walletAddressHistory.updateMany;
    // A concurrent apply won the claim between this run's check and its claim.
    prisma.walletAddressHistory.updateMany = async () => ({ count: 0 });
    try {
      const summary = await migration.applyMigration({ target: MAINNET, db: prisma, cfg, write: true });
      assert.deepEqual(summary.outcomes, { skipped_already_applied: 3 });
    } finally {
      prisma.walletAddressHistory.updateMany = realUpdateMany;
    }
    assert.equal(prisma.store.user.find((u) => u.id === s.legacy.id).walletAddress, oldWallet);
    assert.equal(prisma.store.authIdentity.length, 0);
    assert.equal(prisma.store.nativeWalletBinding.find((b) => b.id === 'b-native').connection, 'ddc-jwt-devnet');
  });

  it('--apply for a legacy account without a linkable pair says so (an orphan)', async () => {
    const apple = user({ walletAddress: addr(), web3authVerifier: LEGACY_APPLE, web3authVerifierId: 'apple-sub' });
    await migration.planMigration({ target: MAINNET, clientId: 'c', write: true, db: prisma, lookup: fakeLookup().lookup });
    const summary = await migration.applyMigration({ target: MAINNET, db: prisma, cfg, write: true });
    assert.deepEqual(summary.outcomes, { applied_legacy_no_native_identity: 1 });
    assert.deepEqual(prisma.store.authIdentity.map((r) => [r.userId, r.provider, r.subject]), [[apple.id, 'web3auth_legacy', `${LEGACY_APPLE}|apple-sub`]]);
  });

  it('a planned-only binding for another target blocks a second plan instead of being overwritten', async () => {
    const s = seedAccounts();
    await migration.planMigration({ target: MAINNET, clientId: 'c', write: true, db: prisma, lookup: fakeLookup().lookup });
    const other = await migration.planMigration({ target: { network: 'sapphire_mainnet', connection: 'ddc-jwt-mainnet-2' }, clientId: 'c', write: true, db: prisma, lookup: fakeLookup().lookup });
    assert.equal(other.classes.planned_elsewhere, 1);
    assert.equal(prisma.store.nativeWalletBinding.filter((b) => b.userId === s.legacy.id).length, 1);
  });

  it('keeps the audit network of the legacy verifier', () => {
    assert.equal(migration.legacyNetwork('web3auth-google-sapphire-devnet'), 'sapphire_devnet');
    assert.equal(migration.legacyNetwork('x-sapphire_mainnet'), 'sapphire_mainnet');
    assert.equal(migration.legacyNetwork('something'), 'unknown');
    assert.equal(getAddress(addr()).length, 42);
  });
});

// ---------------------------------------------------------------------------------------------
describe('scripts/nativeAuthOrphanReport', () => {
  it('counts every orphan reason and never counts a findable account', async () => {
    const orphanIds = [];
    const expect = {};
    const mk = (reason, data, identities = []) => {
      const u = user(data);
      for (const i of identities) prisma.store.authIdentity.push({ id: crypto.randomUUID(), userId: u.id, email: null, emailLinkGrade: 'none', linkedVia: 'x', ...i });
      if (reason) {
        orphanIds.push([u.id, reason]);
        expect[reason] = (expect[reason] || 0) + 1;
      }
      return u;
    };
    // findable
    mk(null, { web3authVerifier: LEGACY_EMAIL, web3authVerifierId: 'a@example.com' }); // needs_backfill
    mk(null, { web3authVerifier: LEGACY_GOOGLE, web3authVerifierId: 'b@gmail.com' }); // needs_backfill
    mk(null, { web3authVerifier: LEGACY_X, web3authVerifierId: 'twitter|1', xid: '1' }); // needs_backfill
    mk(null, { web3authVerifier: 'ddc-jwt-mainnet' }, [{ provider: 'email', subject: 'c@example.com', email: 'c@example.com', emailLinkGrade: 'strong' }]);
    mk(null, { web3authVerifier: 'external-wallet', web3authVerifierId: '0x1' });
    mk(null, { web3authVerifier: LEGACY_APPLE, web3authVerifierId: 'apl-2' }, [{ provider: 'email', subject: 'd@example.com' }]); // linked a native method
    mk(null, { authType: 'traditional' }); // password_only
    mk(null, { web3authVerifier: LEGACY_APPLE, web3authVerifierId: 'apl-org', isOrganization: true });
    mk(null, { web3authVerifier: LEGACY_APPLE, web3authVerifierId: 'apl-off', disabledAt: new Date() });
    // orphans
    mk('legacy_apple', { web3authVerifier: LEGACY_APPLE, web3authVerifierId: 'apl-1', email: 'x@privaterelay.appleid.com' });
    mk('legacy_google_non_gmail', { web3authVerifier: LEGACY_GOOGLE, web3authVerifierId: 'e@corp.example' });
    mk('legacy_x_malformed', { web3authVerifier: LEGACY_X, web3authVerifierId: 'x-handle' });
    mk('x_without_legacy_pair', { authType: 'traditional', xid: '42' });
    mk('apple_relay_email', { email: 'y@privaterelay.appleid.com' });
    mk('web3auth_unpaired', {});
    mk('backfill_missing', { web3authVerifier: 'ddc-jwt-mainnet' }, [{ provider: 'web3auth_legacy', subject: `${LEGACY_EMAIL}|f@example.com` }]);
    mk('legacy_unknown_verifier', { web3authVerifier: 'web3auth-line-sapphire-devnet', web3authVerifierId: 'l1' });
    mk('native_without_identity', { web3authVerifier: 'ddc-jwt-devnet', web3authVerifierId: 'self' });

    const listed = [];
    const before = JSON.stringify(prisma.store);
    const report = await orphans.orphanReport({ db: prisma, cfg, batchSize: 3, onOrphan: (id, reason) => listed.push([id, reason]) });
    assert.equal(report.scanned, 18);
    assert.equal(report.orphanTotal, 9);
    for (const reason of orphans.ORPHAN_REASONS) assert.equal(report.orphans[reason], expect[reason] || 0, reason);
    assert.deepEqual(listed.sort(), orphanIds.sort());
    assert.deepEqual(report.statuses, { needs_backfill: 3, native: 2, external_wallet: 1, password_only: 1, organization: 1, disabled: 1, orphan: 9 });
    assert.deepEqual(report.flags, { x_without_legacy_pair: 1, apple_relay_email: 2 });
    assert.equal(JSON.stringify(report).includes('@'), false, 'counts only');
    assert.equal(JSON.stringify(prisma.store), before, 'read-only');
  });

  it('counts a linkable pair the backfill would skip as an orphan (backfill_blocked)', async () => {
    // Two legacy pairs for one address: the backfill skips both as ambiguous.
    user({ web3authVerifier: LEGACY_EMAIL, web3authVerifierId: 'twin@gmail.com' });
    user({ web3authVerifier: LEGACY_GOOGLE, web3authVerifierId: 'twin@gmail.com' });
    // Another account holds a strong identity for this address.
    const holder = user({});
    prisma.store.authIdentity.push({ id: 'h1', userId: holder.id, provider: 'google', subject: 'g-9', email: 'held@example.com', emailLinkGrade: 'strong', linkedVia: 'created' });
    const blocked = user({ web3authVerifier: LEGACY_EMAIL, web3authVerifierId: 'held@example.com' });
    const fine = user({ web3authVerifier: LEGACY_EMAIL, web3authVerifierId: 'fine@example.com' });
    const listed = [];
    const report = await orphans.orphanReport({ db: prisma, cfg, onOrphan: (id, reason) => listed.push([id, reason]) });
    assert.equal(report.orphans.backfill_blocked, 3);
    assert.deepEqual(report.backfillBlocked, { ambiguous: 2, strong_email_owned_elsewhere: 1 });
    assert.equal(report.statuses.needs_backfill, 1);
    assert.ok(listed.some(([id, reason]) => id === blocked.id && reason === 'backfill_blocked'));
    assert.equal(listed.some(([id]) => id === fine.id), false);
    assert.equal(JSON.stringify(report).includes('@'), false, 'counts only');
  });

  it('warns when no legacy verifier is configured', async () => {
    user({ web3authVerifier: LEGACY_EMAIL, web3authVerifierId: 'a@example.com' });
    const report = await orphans.orphanReport({ db: prisma, cfg: readNativeAuthConfig({}) });
    assert.match(report.warning, /all empty/);
    assert.equal(report.orphans.legacy_unknown_verifier, 1);
  });

  it('parses its flags', () => {
    assert.deepEqual(orphans.parseArgs(['--json', '--list=o.csv']).list, 'o.csv');
    assert.throws(() => orphans.parseArgs(['--write']), /unknown argument/);
    assert.deepEqual(orphans.splitLegacySubject(`${LEGACY_X}|twitter|5`), { verifier: LEGACY_X, verifierId: 'twitter|5' });
  });
});
