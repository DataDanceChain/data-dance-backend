/**
 * Move the 2026 revenue-book purchase orders off the single test buyer and
 * onto a handful of advertising-agency accounts. Re-running is safe: accounts
 * are matched by email, and only orders tagged [revenue-book-2026] are moved.
 *
 *   node scripts/assignRevenueBookClients.js
 */

const crypto = require('crypto');
const bcrypt = require('/app/node_modules/bcryptjs');
const { PrismaClient } = require('/app/node_modules/@prisma/client');

const PASSWORD = 'Buyer@123';
const SEED_TAG = '[revenue-book-2026]';

const CLIENTS = [
  {
    email: 'bluefocus@clients.datadance.test',
    name: 'BlueFocus',
    companyName: 'BlueFocus',
    address: '北京市朝阳区酒仙桥路10号',
    country: 'CN',
    orders: [
      'PO-RB-202604-ECOM',
      'PO-RB-202605-ECOM',
      'PO-RB-202606-ECOM',
      'PO-RB-202607-ECOM',
      'PO-RB-202608-ECOM',
      'PO-RB-202608-ECOM-2',
      'PO-RB-202609-ECOM',
      'PO-RB-202609-ECOM-2',
    ],
  },
  {
    email: 'uncle.media@clients.datadance.test',
    name: 'Uncle Media',
    companyName: 'Uncle Media',
    address: '上海市长宁区镇宁路465弄181号',
    country: 'CN',
    orders: [
      'PO-RB-202604-TRAVEL',
      'PO-RB-202605-TRAVEL',
      'PO-RB-202606-TRAVEL',
      'PO-RB-202607-TRAVEL',
      'PO-RB-202608-TRAVEL',
      'PO-RB-202609-TRAVEL',
    ],
  },
  {
    email: 'simei@clients.datadance.test',
    name: 'Simei Media',
    companyName: 'Simei Media',
    address: '杭州市西湖区教工路18号',
    country: 'CN',
    orders: [
      'PO-RB-202605-AUTO',
      'PO-RB-202607-AUTO',
      'PO-RB-202608-AUTO',
      'PO-RB-202609-AUTO',
    ],
  },
  {
    email: 'hylink@clients.datadance.test',
    name: 'Hylink',
    companyName: 'Hylink',
    address: '上海市徐汇区龙腾大道2879号',
    country: 'CN',
    orders: [
      'PO-RB-202605-BUILD',
      'PO-RB-202606-BUILD',
      'PO-RB-202608-BUILD',
      'PO-RB-202609-BUILD',
    ],
  },
  {
    email: 'leo.digital@clients.datadance.test',
    name: 'Leo Digital',
    companyName: 'Leo Digital',
    address: '上海市徐汇区',
    country: 'CN',
    orders: [
      'PO-RB-202606-ECOM-2',
      'PO-RB-202606-TRAVEL-2',
      'PO-RB-202608-TRAVEL-2',
      'PO-RB-202609-TRAVEL-2',
    ],
  },
  {
    email: 'joy.media@clients.datadance.test',
    name: 'Joy Media',
    companyName: 'Joy Media',
    address: '上海市徐汇区',
    country: 'CN',
    orders: [
      'PO-RB-202608-BUILD-2',
      'PO-RB-202609-AUTO-2',
      'PO-RB-202609-BUILD-2',
    ],
  },
  {
    email: 'inly@clients.datadance.test',
    name: 'Inly Media',
    companyName: 'Inly Media',
    address: '北京市朝阳区',
    country: 'CN',
    orders: [
      'PO-RB-202605-ECOM-2',
      'PO-RB-202606-AUTO',
    ],
  },
];

function referralCode() {
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  const bytes = crypto.randomBytes(6);
  let code = '';
  for (let i = 0; i < 6; i += 1) code += alphabet[bytes[i] % alphabet.length];
  return code;
}

async function ensureClient(prisma, client, passwordHash) {
  let user = await prisma.user.findUnique({ where: { email: client.email } });
  if (!user) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        user = await prisma.user.create({
          data: {
            email: client.email,
            name: client.name,
            description: 'Test advertising-agency buyer for the 2026 revenue book. Not the real company.',
            password: passwordHash,
            authType: 'traditional',
            userType: 'organization',
            isOrganization: true,
            referralCode: referralCode(),
          },
        });
        break;
      } catch (error) {
        if (attempt === 4 || !String(error.message || '').includes('referralCode')) throw error;
      }
    }
  } else {
    user = await prisma.user.update({
      where: { id: user.id },
      data: {
        name: client.name,
        password: passwordHash,
        userType: 'organization',
        isOrganization: true,
        authType: 'traditional',
      },
    });
  }

  const entity = {
    companyName: client.companyName,
    email: client.email,
    address: client.address,
    country: client.country,
    currency: 'USD',
  };
  await prisma.legalEntity.upsert({
    where: { userId: user.id },
    update: entity,
    create: { userId: user.id, ...entity },
  });
  return user;
}

async function main() {
  const expected = CLIENTS.reduce((sum, client) => sum + client.orders.length, 0);
  const seen = new Set(CLIENTS.flatMap((client) => client.orders));
  if (seen.size !== expected) throw new Error('an order is assigned twice');

  const prisma = new PrismaClient();
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  try {
    const tagged = await prisma.purchaseOrder.findMany({
      where: { notes: { contains: SEED_TAG } },
      select: { orderNumber: true },
    });
    const taggedNumbers = new Set(tagged.map((row) => row.orderNumber));
    const missing = [...seen].filter((orderNumber) => !taggedNumbers.has(orderNumber));
    if (missing.length) throw new Error(`missing orders: ${missing.join(', ')}`);

    for (const client of CLIENTS) {
      const user = await ensureClient(prisma, client, passwordHash);
      const orders = await prisma.purchaseOrder.findMany({
        where: { orderNumber: { in: client.orders } },
        select: { id: true },
      });
      const orderIds = orders.map((row) => row.id);
      await prisma.purchaseOrder.updateMany({
        where: { id: { in: orderIds } },
        data: { buyerId: user.id },
      });
      const invoices = await prisma.invoice.findMany({
        where: { orderId: { in: orderIds } },
      });
      for (const invoice of invoices) {
        const snapshot = invoice.buyerSnapshot && typeof invoice.buyerSnapshot === 'object'
          ? invoice.buyerSnapshot
          : {};
        await prisma.invoice.update({
          where: { id: invoice.id },
          data: {
            buyerId: user.id,
            buyerSnapshot: {
              ...snapshot,
              userId: user.id,
              companyName: client.companyName,
              email: client.email,
              address: client.address,
              country: client.country,
              taxId: snapshot.taxId || '',
              bankName: snapshot.bankName || '',
              bankAccount: snapshot.bankAccount || '',
              currency: 'USD',
            },
          },
        });
      }
      const payments = await prisma.payment.findMany({
        where: { orderId: { in: orderIds } },
        select: { id: true, organizationTransactionId: true },
      });
      await prisma.payment.updateMany({
        where: { id: { in: payments.map((row) => row.id) } },
        data: { payerId: user.id },
      });
      const ledgerIds = payments.map((row) => row.organizationTransactionId).filter(Boolean);
      if (ledgerIds.length) {
        await prisma.organizationTransaction.updateMany({
          where: { id: { in: ledgerIds } },
          data: { userId: user.id },
        });
      }
      console.log(`${client.name}  ${client.orders.length} orders`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
