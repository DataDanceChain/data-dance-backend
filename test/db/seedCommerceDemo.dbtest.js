/**
 * scripts/seedCommerceDemo.js on REAL Postgres (`npm run test:db`; needs TEST_DATABASE_URL pointing at
 * a throwaway database that `prisma migrate deploy` has built — its name must contain "test").
 *
 * Issue #3: the seed traded between four organization accounts that no script created, so it failed
 * on an empty database with "Missing organization user". The script is run here twice as a child
 * process, exactly as an operator runs it: both runs must exit 0, the four accounts must exist once
 * each (organization type, hashed password, referral code), the second run must create nothing and
 * leave every row count where the first run put it, and the generated password must be printed only
 * by the run that created the accounts. The demo accounts and their rows are removed before and after.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required for test:db (a throwaway, migrated database)');
if (!/\/[^/?]*test[^/?]*(\?|$)/.test(url)) throw new Error('TEST_DATABASE_URL must name a database containing "test" — refusing to write fixtures anywhere else');
process.env.DATABASE_URL = url;
process.env.LOG_LEVEL = 'error';

const prisma = require('../../src/utils/prisma');

const SCRIPT = path.join(__dirname, '../../scripts/seedCommerceDemo.js');
const SEED_TAG = '[demo-seed]';
const EMAILS = [
  'test-buyer@datadance.io',
  'official@datadance.io',
  'merchant-asia-electronics@datadance.io',
  'merchant-north-america-electronics@datadance.io',
];

function runSeed() {
  const env = { ...process.env, DATABASE_URL: url };
  delete env.COMMERCE_DEMO_PASSWORD;
  const result = spawnSync(process.execPath, [SCRIPT], { env, encoding: 'utf8', timeout: 180_000 });
  return { status: result.status, out: `${result.stdout}\n${result.stderr}` };
}

async function counts() {
  const [accounts, entities, profiles, orders, invoices, payments, ledger] = await Promise.all([
    prisma.user.count({ where: { email: { in: EMAILS } } }),
    prisma.legalEntity.count({ where: { user: { email: { in: EMAILS } } } }),
    prisma.userProfile.count({ where: { user: { email: { in: EMAILS } } } }),
    prisma.purchaseOrder.count({ where: { notes: { contains: SEED_TAG } } }),
    prisma.invoice.count({ where: { order: { notes: { contains: SEED_TAG } } } }),
    prisma.payment.count({ where: { notes: { contains: SEED_TAG } } }),
    prisma.organizationTransaction.count({ where: { description: { contains: SEED_TAG } } }),
  ]);
  return { accounts, entities, profiles, orders, invoices, payments, ledger };
}

/** Remove the demo accounts and everything written against them (order children cascade). */
async function removeDemoState() {
  const users = await prisma.user.findMany({ where: { email: { in: EMAILS } }, select: { id: true } });
  const ids = users.map((row) => row.id);
  if (!ids.length) return;
  const orders = await prisma.purchaseOrder.findMany({
    where: { OR: [{ buyerId: { in: ids } }, { sellerId: { in: ids } }] },
    select: { id: true },
  });
  const orderIds = orders.map((row) => row.id);
  await prisma.payment.deleteMany({ where: { OR: [{ payerId: { in: ids } }, { payeeId: { in: ids } }] } });
  await prisma.invoice.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.purchaseOrder.deleteMany({ where: { id: { in: orderIds } } });
  await prisma.pointsRedemption.deleteMany({ where: { createdById: { in: ids } } });
  await prisma.organizationTransaction.deleteMany({ where: { userId: { in: ids } } });
  await prisma.legalEntity.deleteMany({ where: { userId: { in: ids } } });
  await prisma.userProfile.deleteMany({ where: { userId: { in: ids } } });
  await prisma.userRole.deleteMany({ where: { userId: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
}

describe('scripts/seedCommerceDemo.js on an empty database', () => {
  let first;
  let second;

  before(async () => {
    await removeDemoState();
    assert.equal((await counts()).accounts, 0, 'demo accounts must be absent before the first run');
  });

  after(async () => {
    await removeDemoState();
    await prisma.$disconnect();
  });

  it('first run creates the four organization accounts it needs and exits 0', async () => {
    const run = runSeed();
    assert.equal(run.status, 0, run.out);
    assert.doesNotMatch(run.out, /Missing organization user/);
    assert.match(run.out, /Organization accounts: 4 \(4 created this run\)/);
    assert.match(run.out, /Password for the 4 account\(s\) created this run \(generated, shown once, not stored\): demo-[A-Za-z0-9_-]{12}/);

    first = await counts();
    assert.equal(first.accounts, 4);
    assert.equal(first.entities, 4);
    assert.equal(first.profiles, 4);
    assert.ok(first.orders > 0 && first.invoices === first.orders, JSON.stringify(first));
    assert.ok(first.payments > 0, JSON.stringify(first));

    const users = await prisma.user.findMany({ where: { email: { in: EMAILS } } });
    for (const user of users) {
      assert.equal(user.isOrganization, true, user.email);
      assert.equal(user.userType, 'organization', user.email);
      assert.equal(user.authType, 'traditional', user.email);
      assert.match(user.password || '', /^\$2[aby]\$\d{2}\$/, `${user.email}: bcrypt hash expected`);
      assert.ok(user.referralCode, `${user.email}: referral code`);
    }
    const demo = users.filter((user) => user.email !== 'official@datadance.io');
    assert.equal(demo.length, 3);
    for (const user of demo) {
      assert.match(user.name, /Demo/, `${user.email}: name must mark a demo account`);
      assert.match(user.description || '', /Demo organization account/, `${user.email}: description must mark a demo account`);
    }
  });

  it('second run reuses the accounts, creates nothing, and leaves every count unchanged', async () => {
    const before = await prisma.user.findMany({
      where: { email: { in: EMAILS } },
      select: { id: true, email: true, password: true, referralCode: true, updatedAt: true },
      orderBy: { email: 'asc' },
    });

    const run = runSeed();
    assert.equal(run.status, 0, run.out);
    assert.match(run.out, /Organization accounts: 4 \(0 created this run\)/);
    assert.doesNotMatch(run.out, /Password for the/, 'nothing created, so no password to print');

    second = await counts();
    assert.deepEqual(second, first);

    const after = await prisma.user.findMany({
      where: { email: { in: EMAILS } },
      select: { id: true, email: true, password: true, referralCode: true, updatedAt: true },
      orderBy: { email: 'asc' },
    });
    assert.deepEqual(after, before, 'existing accounts (id, password, referral code) must be untouched');
  });

  it('refuses to trade through an existing account that is not an organization', async () => {
    await prisma.user.update({ where: { email: 'test-buyer@datadance.io' }, data: { isOrganization: false, userType: 'regular' } });
    try {
      const run = runSeed();
      assert.notEqual(run.status, 0);
      assert.match(run.out, /test-buyer@datadance\.io exists but is not an organization account/);
    } finally {
      await prisma.user.update({ where: { email: 'test-buyer@datadance.io' }, data: { isOrganization: true, userType: 'organization' } });
    }
  });
});
