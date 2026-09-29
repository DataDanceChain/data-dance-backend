/**
 * BE9 ops scripts on REAL Postgres (`npm run test:db`; needs TEST_DATABASE_URL pointing at a
 * throwaway, migrated database whose name contains "test"). The unit tests prove the logic on the
 * in-memory stand-in; this file proves the queries themselves against the real schema and client:
 * case-insensitive pair and wallet filters, cursor paging, the plan transaction, the apply
 * transaction's claim and rollback, and the cleanup deletes. The Web3Auth nodes are a fake; nothing
 * here reaches the network. Fixture rows use a per-run prefix and are removed afterwards.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const path = require('path');
const { Wallet } = require('ethers');

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required for test:db (a throwaway, migrated database)');
if (!/\/[^/?]*test[^/?]*(\?|$)/.test(url)) throw new Error('TEST_DATABASE_URL must name a database containing "test" — refusing to write fixtures anywhere else');
Object.assign(process.env, { DATABASE_URL: url, LOG_LEVEL: 'error' });

const prisma = require(path.join(__dirname, '../../src/utils/prisma.js'));
const { readNativeAuthConfig } = require(path.join(__dirname, '../../src/services/nativeAuth/config.js'));
const { cleanupNative } = require('../../scripts/cleanupSso');
const backfill = require('../../scripts/nativeAuthBackfillIdentities');
const migration = require('../../scripts/nativeAuthWalletMigration');
const orphans = require('../../scripts/nativeAuthOrphanReport');

const RUN = `be9${crypto.randomBytes(3).toString('hex')}`;
const LEGACY_EMAIL = `${RUN}-web3auth-email-passwordless-sapphire-devnet`;
const LEGACY_X = `${RUN}-web3auth-twitter-sapphire-devnet`;
const cfg = readNativeAuthConfig({ DDC_AUTH_LEGACY_EMAIL_VERIFIERS: LEGACY_EMAIL, DDC_AUTH_LEGACY_X_VERIFIERS: LEGACY_X });
const TARGET = { network: 'sapphire_mainnet', connection: `${RUN}-ddc-jwt-mainnet` };

const userIds = [];
async function mkUser(data) {
  const id = crypto.randomUUID();
  userIds.push(id);
  return prisma.user.create({ data: { id, email: `${RUN}-${id}@example.test`, name: 'u', authType: 'web3auth', referralCode: `${RUN}${userIds.length}`.slice(0, 20), ...data } });
}

/**
 * The scripts scan whole tables; other dbtest files run in parallel against the same database, so
 * every scan and bulk delete here is narrowed to this run's rows (AND-ed into the script's own
 * where). Row-level reads and writes, and $transaction, go to the real client untouched.
 */
function scoped(scopes) {
  return new Proxy(prisma, {
    get(target, model) {
      const scope = scopes[model];
      if (!scope) return target[model];
      const delegate = target[model];
      const wrap = (method) => (args = {}) => delegate[method]({ ...args, where: { AND: [args.where || {}, scope()] } });
      return new Proxy(delegate, {
        get(d, method) {
          return ['findMany', 'count', 'deleteMany'].includes(method) ? wrap(method) : d[method];
        },
      });
    },
  });
}
const db = scoped({
  user: () => ({ id: { in: userIds } }),
  walletAddressHistory: () => ({ userId: { in: userIds } }),
  authEmailChallenge: () => ({ email: { startsWith: RUN } }),
  authLoginAttempt: () => ({ subject: { startsWith: RUN } }),
  authFlowState: () => ({ kind: RUN }),
});

function fakeLookup() {
  const derived = new Map();
  return async ({ connection, subject, network }) => {
    const key = `${network}|${connection}|${subject}`;
    if (!derived.has(key)) derived.set(key, Wallet.createRandom().address);
    return derived.get(key);
  };
}

after(async () => {
  if (userIds.length) {
    await prisma.walletAddressHistory.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
  await prisma.authEmailChallenge.deleteMany({ where: { email: { startsWith: RUN } } });
  await prisma.authLoginAttempt.deleteMany({ where: { subject: { startsWith: RUN } } });
  await prisma.$disconnect();
});

describe('BE9 scripts on Postgres', () => {
  let legacy;
  let legacyUpper;
  let xUser;

  before(async () => {
    legacy = await mkUser({ walletAddress: Wallet.createRandom().address, web3authVerifier: LEGACY_EMAIL, web3authVerifierId: `${RUN}-leg@example.com` });
    // Legacy rows kept the provider's casing: the backfill must still normalise and match.
    legacyUpper = await mkUser({ web3authVerifier: LEGACY_EMAIL, web3authVerifierId: `${RUN}-Upper@Example.com` });
    xUser = await mkUser({ walletAddress: Wallet.createRandom().address, web3authVerifier: LEGACY_X, web3authVerifierId: 'twitter|98765' + RUN.length });
  });

  it('backfill writes lower-cased strong e-mail and X identities once', async () => {
    const dry = await backfill.backfillIdentities({ db, cfg, batchSize: 1 });
    assert.deepEqual(dry.create, { email: 2, x: 1 });
    const done = await backfill.backfillIdentities({ db, cfg, write: true, batchSize: 1 });
    assert.deepEqual(done.created, { email: 2, x: 1 });
    const upper = await prisma.authIdentity.findFirst({ where: { userId: legacyUpper.id } });
    assert.deepEqual([upper.provider, upper.subject, upper.emailLinkGrade], ['email', `${RUN}-upper@example.com`, 'strong']);
    const again = await backfill.backfillIdentities({ db, cfg, write: true });
    assert.equal(again.present, 3);
  });

  it('plan → export → apply on the real schema, idempotent', async () => {
    const lookup = fakeLookup();
    const planned = await migration.planMigration({ target: TARGET, clientId: 'cid', write: true, db, lookup, batchSize: 1, limit: 1000 });
    assert.deepEqual(planned.outcomes, { planned_legacy: 2 });
    const binding = await prisma.nativeWalletBinding.findUnique({ where: { userId: legacy.id } });
    assert.equal(binding.connection, TARGET.connection);

    const { csv } = await migration.exportRows({ target: TARGET, db });
    assert.ok(csv.includes(`${legacy.id},${legacy.walletAddress},${binding.address},pending`));
    assert.equal(csv.includes(binding.subject), false);

    const dry = await migration.applyMigration({ target: TARGET, db, cfg });
    assert.deepEqual(dry.outcomes, { would_apply_legacy: 2 });
    const applied = await migration.applyMigration({ target: TARGET, db, cfg, write: true, batchSize: 1 });
    assert.deepEqual(applied.outcomes, { applied_legacy_identity_present: 2 });

    const after = await prisma.user.findUnique({ where: { id: legacy.id } });
    assert.deepEqual([after.walletAddress, after.web3authVerifier, after.web3authVerifierId], [binding.address, TARGET.connection, legacy.id]);
    const kept = await prisma.authIdentity.findUnique({
      where: { provider_subject: { provider: 'web3auth_legacy', subject: `${LEGACY_EMAIL}|${legacy.web3authVerifierId}` } },
    });
    assert.equal(kept.userId, legacy.id);
    const row = await prisma.walletAddressHistory.findFirst({ where: { userId: legacy.id } });
    assert.deepEqual([row.status, row.newSubjectRef], ['applied', binding.id]);

    const again = await migration.applyMigration({ target: TARGET, db, cfg, write: true });
    assert.equal(again.scanned, 0);
  });

  it('a wallet held by another row (any case) rolls the account back', async () => {
    const victim = await mkUser({ walletAddress: Wallet.createRandom().address, web3authVerifier: LEGACY_EMAIL, web3authVerifierId: `${RUN}-v@example.com` });
    const target = { network: 'sapphire_devnet', connection: `${RUN}-ddc-jwt-devnet-b` };
    const one = scoped({ user: () => ({ id: victim.id }), walletAddressHistory: () => ({ userId: victim.id }) });
    await migration.planMigration({ target, clientId: 'cid', write: true, db: one, lookup: fakeLookup(), limit: 1000 });
    const row = await prisma.walletAddressHistory.findFirst({ where: { userId: victim.id, newVerifier: target.connection } });
    await mkUser({ walletAddress: row.newAddress.toLowerCase() });
    const out = await migration.applyMigration({ target, db: one, cfg, write: true });
    assert.deepEqual(out.outcomes, { skipped_wallet_in_use: 1 });
    const still = await prisma.walletAddressHistory.findUnique({ where: { id: row.id } });
    assert.equal(still.status, 'planned');
    const user = await prisma.user.findUnique({ where: { id: victim.id } });
    assert.equal(user.web3authVerifier, LEGACY_EMAIL);
  });

  it('orphan report runs read-only over the real table', async () => {
    const report = await orphans.orphanReport({ db, cfg, batchSize: 2 });
    assert.equal(report.scanned, userIds.length);
    assert.deepEqual(report.statuses, { native: 3, needs_backfill: 1, orphan: 1 }, 'backfilled accounts resolve natively; the victim still needs its backfill');
    assert.equal(report.orphans.web3auth_unpaired, 1);
    assert.ok(xUser.id);
  });

  it('cleanup --native deletes by the fixed retention', async () => {
    const now = new Date();
    const old = new Date(now.getTime() - 25 * 60 * 60 * 1000);
    await prisma.authEmailChallenge.create({ data: { email: `${RUN}-a@example.test`, codeHash: 'h', locale: 'en', expiresAt: old, createdAt: old } });
    await prisma.authEmailChallenge.create({ data: { email: `${RUN}-b@example.test`, codeHash: 'h', locale: 'en', expiresAt: now, createdAt: now } });
    await prisma.authLoginAttempt.create({
      data: { loginSecretHash: 'x', intent: 'login', method: 'email', provider: 'email', subject: `${RUN}-s`, resolution: 'create', expiresAt: new Date(now.getTime() - 8 * 86400000), createdAt: new Date(now.getTime() - 8 * 86400000) },
    });
    const dry = await cleanupNative({ dryRun: true, now, db });
    assert.deepEqual([dry.emailChallenges, dry.attemptsIncomplete], [1, 1]);
    await cleanupNative({ now, db });
    const left = await prisma.authEmailChallenge.findMany({ where: { email: { startsWith: RUN } } });
    assert.deepEqual(left.map((r) => r.email), [`${RUN}-b@example.test`]);
    assert.equal(await prisma.authLoginAttempt.count({ where: { subject: `${RUN}-s` } }), 0);
  });
});
