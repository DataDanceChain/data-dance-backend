/**
 * Demo seed for B-end Orders / Invoices / Payments.
 * Safe to re-run: deletes previous rows tagged [demo-seed], then inserts a fresh set.
 *
 *   docker compose exec ddc-backend-api node scripts/seedCommerceDemo.js
 */

require('dotenv').config();
const prisma = require('../src/utils/prisma');
const { nextNumber } = require('../src/services/commerceService');

const SEED_TAG = '[demo-seed]';
const BUYER_EMAIL = 'test-buyer@datadance.io';
const SELLER_OFFICIAL = 'official@datadance.io';
const SELLER_ASIA = 'merchant-asia-electronics@datadance.io';
const SELLER_NA = 'merchant-north-america-electronics@datadance.io';

function daysAgo(days, hours = 10) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  date.setHours(hours, 15, 0, 0);
  return date;
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function partySnapshot(entity, user) {
  return {
    userId: user.id,
    companyName: entity.companyName,
    taxId: entity.taxId || '',
    address: entity.address || '',
    country: entity.country || '',
    email: entity.email || user.email,
    bankName: entity.bankName || '',
    bankAccount: entity.bankAccount || '',
    currency: entity.currency || 'USD',
  };
}

async function upsertEntity(user, data) {
  return prisma.legalEntity.upsert({
    where: { userId: user.id },
    update: data,
    create: { userId: user.id, ...data },
  });
}

async function requireUser(email) {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    throw new Error(`Missing organization user: ${email}`);
  }
  return user;
}

async function clearPreviousSeed() {
  const seeded = await prisma.purchaseOrder.findMany({
    where: { notes: { contains: SEED_TAG } },
    select: { id: true },
  });
  const orderIds = seeded.map((row) => row.id);
  const seededPayments = await prisma.payment.findMany({
    where: {
      OR: [
        { notes: { contains: SEED_TAG } },
        { orderId: { in: orderIds } },
      ],
    },
    select: { id: true, organizationTransactionId: true },
  });

  await prisma.payment.deleteMany({
    where: { id: { in: seededPayments.map((row) => row.id) } },
  });
  const txIds = seededPayments
    .map((row) => row.organizationTransactionId)
    .filter(Boolean);
  if (txIds.length) {
    await prisma.organizationTransaction.deleteMany({
      where: { id: { in: txIds } },
    });
  }
  if (orderIds.length) {
    await prisma.invoice.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.purchaseOrder.deleteMany({ where: { id: { in: orderIds } } });
  }
}

async function createDeal({
  buyer,
  seller,
  buyerEntity,
  sellerEntity,
  createdAt,
  paymentTerms,
  status,
  invoiceStatus,
  lineItems,
  extraNote,
  payments = [],
  taxRate = 0,
}) {
  const items = lineItems.map((item) => ({
    description: item.description,
    category: item.category,
    quantity: item.quantity,
    unit: item.unit,
    unitPrice: item.unitPrice,
    total: Number((item.quantity * item.unitPrice).toFixed(2)),
  }));
  const subtotal = Number(items.reduce((sum, item) => sum + item.total, 0).toFixed(2));
  const taxAmount = Number((subtotal * taxRate).toFixed(2));
  const total = Number((subtotal + taxAmount).toFixed(2));
  const issueDate = createdAt;
  const dueDate = addDays(issueDate, paymentTerms.includes('30') ? 30 : paymentTerms.includes('15') ? 15 : 0);

  const order = await prisma.purchaseOrder.create({
    data: {
      orderNumber: nextNumber('PO'),
      buyerId: buyer.id,
      sellerId: seller.id,
      status,
      currency: 'USD',
      subtotal,
      taxAmount,
      total,
      paymentTerms,
      notes: `${SEED_TAG} ${extraNote}`,
      contractStatus: status === 'paid' ? 'uploaded' : 'none',
      createdAt,
      updatedAt: createdAt,
      lineItems: { create: items },
    },
  });

  const invoice = await prisma.invoice.create({
    data: {
      invoiceNumber: nextNumber('INV'),
      orderId: order.id,
      buyerId: buyer.id,
      sellerId: seller.id,
      status: invoiceStatus,
      currency: 'USD',
      subtotal,
      taxAmount,
      total,
      paymentTerms,
      issueDate,
      dueDate,
      paidAt: invoiceStatus === 'paid' ? addDays(issueDate, 2) : null,
      sellerSnapshot: partySnapshot(sellerEntity, seller),
      buyerSnapshot: partySnapshot(buyerEntity, buyer),
      createdAt,
      updatedAt: createdAt,
      lineItems: {
        create: items.map((item) => ({
          description: item.description,
          category: item.category,
          quantity: item.quantity,
          unit: item.unit,
          unitPrice: item.unitPrice,
          total: item.total,
        })),
      },
    },
  });

  for (const payment of payments) {
    const paidAt = payment.paidAt || addDays(createdAt, payment.daysAfter || 1);
    let organizationTransactionId = null;
    if (payment.createLedger) {
      const ledger = await prisma.organizationTransaction.create({
        data: {
          amount: payment.amount,
          type: payment.ledgerType || 'WITHDRAW',
          status: payment.status === 'confirmed' ? 'COMPLETED' : 'PENDING',
          description: `${SEED_TAG} ${payment.notes || extraNote}`,
          userId: buyer.id,
          metadata: { source: 'commerce_demo', reference: payment.reference || null },
          createdAt: paidAt,
          updatedAt: paidAt,
        },
      });
      organizationTransactionId = ledger.id;
    }

    await prisma.payment.create({
      data: {
        paymentNumber: nextNumber('PAY'),
        orderId: order.id,
        invoiceId: invoice.id,
        payerId: buyer.id,
        payeeId: seller.id,
        amount: payment.amount,
        currency: 'USD',
        method: payment.method,
        status: payment.status,
        matchStatus: payment.matchStatus,
        paidAt: payment.status === 'confirmed' ? paidAt : payment.paidAt || null,
        reference: payment.reference || null,
        notes: `${SEED_TAG} ${payment.notes || extraNote}`,
        organizationTransactionId,
        createdAt: paidAt,
        updatedAt: paidAt,
      },
    });
  }

  return { order, invoice };
}

async function seedAllocation(order, row) {
  const email = String(row.email).toLowerCase();
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  const allocation = await prisma.procurementAllocation.create({
    data: {
      orderId: order.id,
      kind: row.kind,
      email,
      emailNormalized: email,
      displayName: row.displayName,
      role: row.role || (row.kind === 'referral' ? 'referrer' : 'data_contributor'),
      points: row.points,
      userId: user?.id || null,
      claimStatus: user ? 'claimable' : 'reserved',
      note: row.note || `${SEED_TAG} reserved for later DDC claim`,
    },
  });
  const unitPrice = row.unitPrice || 0.01;
  await prisma.procurementCostItem.create({
    data: {
      orderId: order.id,
      kind: 'points_issue',
      description: `${row.kind === 'referral' ? 'Referral points' : 'User points'} reserved for ${email.replace(/^(.{2}).+@/, '$1***@')}`,
      points: row.points,
      unitPriceUsd: unitPrice,
      amountUsd: Number((row.points * unitPrice).toFixed(4)),
      sourceType: 'allocation',
      sourceId: allocation.id,
    },
  });
  return allocation;
}

async function seedRedemption(order, createdById, row) {
  const email = String(row.email).toLowerCase();
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  const redemption = await prisma.pointsRedemption.create({
    data: {
      orderId: order.id,
      createdById,
      email,
      emailNormalized: email,
      userId: user?.id || null,
      points: row.points,
      asset: row.asset || 'USDT',
      amount: row.amount,
      vendor: row.vendor || 'External payout desk',
      vendorReference: row.vendorReference,
      status: row.status || 'paid',
      paidAt: row.paidAt || new Date(),
      notes: `${SEED_TAG} ${row.notes || 'Vendor payout voucher'}`,
    },
  });
  await prisma.procurementCostItem.create({
    data: {
      orderId: order.id,
      kind: 'points_redeem',
      description: `Points redeemed to ${redemption.asset} via ${redemption.vendor}`,
      points: redemption.points,
      unitPriceUsd: Number((redemption.amount / redemption.points).toFixed(6)),
      amountUsd: redemption.amount,
      sourceType: 'redemption',
      sourceId: redemption.id,
    },
  });
  return redemption;
}

async function seedTopUp(buyer, payee, amount, status, days) {
  const createdAt = daysAgo(days, 9);
  const ledger = await prisma.organizationTransaction.create({
    data: {
      amount,
      type: 'DEPOSIT',
      status: status === 'confirmed' ? 'COMPLETED' : 'PENDING',
      description: `${SEED_TAG} Wallet top-up`,
      userId: buyer.id,
      metadata: { source: 'commerce_demo', method: 'top_up' },
      createdAt,
      updatedAt: createdAt,
    },
  });
  return prisma.payment.create({
    data: {
      paymentNumber: nextNumber('PAY'),
      payerId: buyer.id,
      payeeId: payee.id,
      amount,
      currency: 'USD',
      method: 'top_up',
      status,
      matchStatus: status === 'confirmed' ? 'matched' : 'unmatched',
      paidAt: status === 'confirmed' ? createdAt : null,
      reference: `TT-NW-${String(days).padStart(3, '0')}`,
      notes: `${SEED_TAG} Wallet top-up from Northwind operating account`,
      organizationTransactionId: ledger.id,
      createdAt,
      updatedAt: createdAt,
    },
  });
}

async function main() {
  const [buyer, official, asia, northAmerica] = await Promise.all([
    requireUser(BUYER_EMAIL),
    requireUser(SELLER_OFFICIAL),
    requireUser(SELLER_ASIA),
    requireUser(SELLER_NA),
  ]);

  const [buyerEntity, officialEntity, asiaEntity, naEntity] = await Promise.all([
    upsertEntity(buyer, {
      companyName: 'Northwind AI Research Ltd',
      taxId: 'SG-202400188B',
      address: '12 Marina Boulevard, #18-01, Singapore 018982',
      country: 'Singapore',
      email: 'ap@northwind-ai.example',
      bankName: 'DBS Bank',
      bankAccount: '072-123456-001',
      currency: 'USD',
    }),
    upsertEntity(official, {
      companyName: 'DataDance Technology Pte. Ltd.',
      taxId: '202312345M',
      address: '1 Raffles Place, #20-01, Singapore 048616',
      country: 'Singapore',
      email: 'billing@datadance.io',
      bankName: 'OCBC Bank',
      bankAccount: '501-889210-001',
      currency: 'USD',
    }),
    upsertEntity(asia, {
      companyName: 'Asia Electronics Data Desk',
      taxId: 'JP-88100234',
      address: '2-1-1 Nihonbashi, Chuo-ku, Tokyo 103-0027',
      country: 'Japan',
      email: 'sales@asia-electronics.example',
      bankName: 'MUFG Bank',
      bankAccount: '003-778821',
      currency: 'USD',
    }),
    upsertEntity(northAmerica, {
      companyName: 'North America Electronics Merchant LLC',
      taxId: '87-4412901',
      address: '548 Market Street, San Francisco, CA 94104',
      country: 'United States',
      email: 'billing@na-electronics.example',
      bankName: 'Silicon Valley Bank',
      bankAccount: '3300128890',
      currency: 'USD',
    }),
  ]);

  await clearPreviousSeed();

  await prisma.commerceSettings.upsert({
    where: { id: 'default' },
    update: { pointsUnitPriceUsd: 0.01 },
    create: { id: 'default', pointsUnitPriceUsd: 0.01 },
  });

  const firstDeal = await createDeal({
    buyer,
    seller: official,
    buyerEntity,
    sellerEntity: officialEntity,
    createdAt: daysAgo(21, 11),
    paymentTerms: 'Due on receipt',
    status: 'paid',
    invoiceStatus: 'paid',
    extraNote: 'Instruction-tuning dialogue corpus, delivered via secure download.',
    lineItems: [
      {
        description: 'Multilingual instruction-tuning dialogues (EN/ZH/JA)',
        category: 'dataset',
        quantity: 120000,
        unit: 'records',
        unitPrice: 0.08,
      },
      {
        description: 'Human QA review and PII redaction',
        category: 'data_service',
        quantity: 1,
        unit: 'project',
        unitPrice: 1800,
      },
    ],
    payments: [
      {
        amount: 11400,
        method: 'account_balance',
        status: 'confirmed',
        matchStatus: 'matched',
        notes: 'Paid from organization wallet',
        createLedger: true,
        daysAfter: 1,
      },
    ],
  });

  await prisma.purchaseOrder.update({
    where: { id: firstDeal.order.id },
    data: { pointsUnitPriceUsd: 0.01, serviceFeeAmount: 960 },
  });
  await seedAllocation(firstDeal.order, {
    kind: 'user',
    email: 'maya.chen@example.com',
    displayName: 'Maya Chen',
    points: 2400,
  });
  await seedAllocation(firstDeal.order, {
    kind: 'user',
    email: 'leo.park@example.com',
    displayName: 'Leo Park',
    points: 1800,
  });
  await seedAllocation(firstDeal.order, {
    kind: 'referral',
    email: 'nina.reyes@example.com',
    displayName: 'Nina Reyes',
    role: 'referrer',
    points: 420,
  });
  await seedRedemption(firstDeal.order, official.id, {
    email: 'maya.chen@example.com',
    points: 500,
    amount: 5,
    vendor: 'External payout desk',
    vendorReference: 'USDT-PAY-20260829-0041',
    notes: 'User redeemed 500 points to 5 USDT',
    paidAt: daysAgo(3, 16),
  });

  await createDeal({
    buyer,
    seller: official,
    buyerEntity,
    sellerEntity: officialEntity,
    createdAt: daysAgo(14, 10),
    paymentTerms: 'Net 15',
    status: 'paid',
    invoiceStatus: 'paid',
    extraNote: 'Vision labeling API monthly seat.',
    lineItems: [
      {
        description: 'Image labeling API — Aug 2026 reserved calls',
        category: 'api_usage',
        quantity: 500000,
        unit: 'calls',
        unitPrice: 0.012,
      },
    ],
    payments: [
      {
        amount: 6000,
        method: 'bank_transfer',
        status: 'confirmed',
        matchStatus: 'matched',
        reference: 'OCBC-20260813-4412',
        notes: 'TT matched invoice total',
        daysAfter: 3,
      },
    ],
  });

  await createDeal({
    buyer,
    seller: asia,
    buyerEntity,
    sellerEntity: asiaEntity,
    createdAt: daysAgo(9, 15),
    paymentTerms: 'Net 30',
    status: 'invoiced',
    invoiceStatus: 'partial',
    extraNote: 'Retail electronics catalog text, first installment received.',
    lineItems: [
      {
        description: 'Asia electronics product-title and spec corpus',
        category: 'dataset',
        quantity: 80000,
        unit: 'records',
        unitPrice: 0.045,
      },
    ],
    payments: [
      {
        amount: 1500,
        method: 'bank_transfer',
        status: 'confirmed',
        matchStatus: 'partial',
        reference: 'MUFG-20260818-2290',
        notes: 'First installment; remainder due Net 30',
        daysAfter: 2,
      },
    ],
  });

  await createDeal({
    buyer,
    seller: official,
    buyerEntity,
    sellerEntity: officialEntity,
    createdAt: daysAgo(6, 16),
    paymentTerms: 'Net 15',
    status: 'invoiced',
    invoiceStatus: 'issued',
    extraNote: 'Logged-in web snapshot collection for travel sites.',
    lineItems: [
      {
        description: 'Authorized login snapshot collection — Booking / Airbnb',
        category: 'collection_service',
        quantity: 3,
        unit: 'sites',
        unitPrice: 2200,
      },
      {
        description: 'Structured trip-history export',
        category: 'dataset',
        quantity: 15000,
        unit: 'records',
        unitPrice: 0.06,
      },
    ],
    payments: [
      {
        amount: 7500,
        method: 'bank_transfer',
        status: 'pending',
        matchStatus: 'unmatched',
        reference: 'DBS-PENDING-8821',
        notes: 'Buyer submitted slip; awaiting seller confirm',
        daysAfter: 1,
      },
    ],
  });

  await createDeal({
    buyer,
    seller: northAmerica,
    buyerEntity,
    sellerEntity: naEntity,
    createdAt: daysAgo(4, 13),
    paymentTerms: 'Due on receipt',
    status: 'invoiced',
    invoiceStatus: 'issued',
    extraNote: 'Overpayment recorded to show amount mismatch.',
    lineItems: [
      {
        description: 'US consumer-electronics review snippets',
        category: 'dataset',
        quantity: 25000,
        unit: 'records',
        unitPrice: 0.05,
      },
    ],
    payments: [
      {
        amount: 1600,
        method: 'bank_transfer',
        status: 'confirmed',
        matchStatus: 'amount_mismatch',
        reference: 'SVB-20260823-0199',
        notes: 'Wired 1600 against 1250 invoice — needs adjustment',
        daysAfter: 1,
      },
    ],
  });

  await createDeal({
    buyer,
    seller: official,
    buyerEntity,
    sellerEntity: officialEntity,
    createdAt: daysAgo(2, 11),
    paymentTerms: 'Net 30',
    status: 'invoiced',
    invoiceStatus: 'issued',
    extraNote: 'Speech fine-tuning set, unpaid.',
    taxRate: 0.09,
    lineItems: [
      {
        description: 'Call-center speech clips with transcripts (8 kHz, EN)',
        category: 'dataset',
        quantity: 400,
        unit: 'hours',
        unitPrice: 18,
      },
    ],
  });

  await createDeal({
    buyer,
    seller: official,
    buyerEntity,
    sellerEntity: officialEntity,
    createdAt: daysAgo(1, 17),
    paymentTerms: 'Due on receipt',
    status: 'confirmed',
    invoiceStatus: 'issued',
    extraNote: 'Rejected first transfer; replacement not yet sent.',
    lineItems: [
      {
        description: 'Safety-policy preference pairs for RLHF',
        category: 'dataset',
        quantity: 20000,
        unit: 'records',
        unitPrice: 0.15,
      },
    ],
    payments: [
      {
        amount: 3000,
        method: 'bank_transfer',
        status: 'rejected',
        matchStatus: 'unmatched',
        reference: 'DBS-DUP-1102',
        notes: 'Duplicate reference; seller rejected',
        daysAfter: 0,
      },
    ],
  });

  await seedTopUp(buyer, official, 20000, 'confirmed', 25);
  await seedTopUp(buyer, official, 5000, 'pending', 1);

  const [orders, invoices, payments] = await Promise.all([
    prisma.purchaseOrder.count({ where: { notes: { contains: SEED_TAG } } }),
    prisma.invoice.count({ where: { order: { notes: { contains: SEED_TAG } } } }),
    prisma.payment.count({ where: { notes: { contains: SEED_TAG } } }),
  ]);

  console.log('Commerce demo seed complete');
  console.log(`  Buyer login: ${BUYER_EMAIL} / Buyer@123`);
  console.log(`  Orders: ${orders}`);
  console.log(`  Invoices: ${invoices}`);
  console.log(`  Payments: ${payments}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
