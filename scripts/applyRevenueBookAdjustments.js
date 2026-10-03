/**
 * Adjust the live 2026 revenue book without reseeding.
 *
 * Second-cut orders (PO-RB-…-2) become reauthorizations: the contributor
 * reward stays, the referral payment is removed, and the order margin lands
 * between 50% and 70%. Revenue on those orders does not change.
 *
 * Gift-card redemptions are replaced by the 30 September purchase batch
 * (8 Amazon orders, 137 cards, $2,000). That batch redeems issued points.
 * It is not a second cost, and it does not settle the whole September outflow.
 *
 *   node scripts/applyRevenueBookAdjustments.js
 */

const crypto = require('crypto');
const { PrismaClient } = require('@prisma/client');
const {
  GIFT_CARD_BATCH,
  GIFT_CARD_PURCHASES,
  purchaseTotal,
  assertGiftCardBatch,
} = require('./revenueBookGiftCards');

const TAG = '[revenue-book-2026]';
const REAUTH_MARK = 'Reauthorization of already collected';
const PAID_AT = new Date('2026-09-30T02:15:00.000Z');

function money(value) {
  return Math.round(Number(value) * 100) / 100;
}

function monthKey(orderNumber) {
  return `${orderNumber.slice(6, 10)}-${orderNumber.slice(10, 12)}`;
}

async function applyReauthorization(prisma) {
  const orders = await prisma.purchaseOrder.findMany({
    where: { orderNumber: { startsWith: 'PO-RB-' }, notes: { contains: TAG } },
    select: { id: true, orderNumber: true, total: true, notes: true },
  });
  const reauth = orders.filter((order) => order.orderNumber.endsWith('-2'));
  if (reauth.length !== 10) throw new Error(`expected 10 second-cut orders, found ${reauth.length}`);
  const pending = reauth.filter((order) => !order.notes.includes(REAUTH_MARK));
  if (pending.length === 0) {
    console.log('Reauthorization already applied');
    return;
  }

  for (const order of pending) {
    const [dataItem, referralItem, contributors] = await Promise.all([
      prisma.procurementCostItem.findFirst({
        where: { orderId: order.id, kind: 'points_issue', description: { contains: 'Contributor points' } },
      }),
      prisma.procurementCostItem.findFirst({
        where: { orderId: order.id, kind: 'points_issue', description: { contains: 'Referral-node points' } },
      }),
      prisma.procurementAllocation.findMany({
        where: { orderId: order.id, kind: 'user' },
        select: { userId: true },
      }),
    ]);
    if (!dataItem || !referralItem) throw new Error(`${order.orderNumber} is missing a cost line`);
    const profit = money(order.total - dataItem.amountUsd);
    const margin = profit / order.total;
    if (margin < 0.5 || margin > 0.7) {
      throw new Error(`${order.orderNumber} margin ${(margin * 100).toFixed(1)}% is outside 50–70%`);
    }
    const contributorIds = contributors.map((row) => row.userId);
    await prisma.point.deleteMany({
      where: { source: 'revenue_book_referral', sourceId: { in: contributorIds } },
    });
    await prisma.procurementAllocation.deleteMany({
      where: { orderId: order.id, kind: 'referral' },
    });
    await prisma.procurementCostItem.delete({ where: { id: referralItem.id } });
    const pct = (margin * 100).toFixed(1);
    await prisma.purchaseOrder.update({
      where: { id: order.id },
      data: {
        serviceFeeAmount: profit,
        notes: `${TAG} ${REAUTH_MARK} data on ${order.orderNumber}. Contributor reward $${money(dataItem.amountUsd).toFixed(2)}. No second referral payment. Gross profit $${profit.toFixed(2)}, margin ${pct}%.`,
      },
    });
    console.log(`  ${order.orderNumber}  revenue $${money(order.total).toFixed(2)}  margin ${pct}%`);
  }

  const nodes = await prisma.user.findMany({
    where: { email: { startsWith: 'rb26.node.', endsWith: '@book.datadance.test' } },
    select: { id: true },
  });
  const sums = await prisma.point.groupBy({
    by: ['userId'],
    where: { userId: { in: nodes.map((row) => row.id) } },
    _sum: { amount: true },
  });
  const byUser = new Map(sums.map((row) => [row.userId, row._sum.amount || 0]));
  for (const node of nodes) {
    await prisma.user.update({
      where: { id: node.id },
      data: { totalPoints: byUser.get(node.id) || 0 },
    });
  }
  console.log(`Reauthorization applied on ${pending.length} orders`);
}

async function replaceGiftCards(prisma) {
  const { slots } = assertGiftCardBatch();
  const seller = await prisma.user.findUnique({ where: { email: 'official@datadance.io' } });
  const desk = await prisma.user.findUnique({ where: { email: 'amazon-giftcards-overseas@datadance.io' } });
  if (!seller) throw new Error('official@datadance.io is missing');
  if (!desk) throw new Error('amazon gift-card desk is missing');

  const pool = await prisma.point.findMany({
    where: {
      source: 'revenue_book_data',
      amount: 500,
      user: { email: { endsWith: '@book.datadance.test' } },
    },
    orderBy: { user: { email: 'asc' } },
    select: { userId: true, user: { select: { email: true } } },
    take: 400,
  });
  if (pool.length !== 400) throw new Error(`need 400 contributors at $5.00, found ${pool.length}`);
  const allocations = await prisma.procurementAllocation.findMany({
    where: { kind: 'user', userId: { in: pool.map((row) => row.userId) } },
    select: { userId: true, orderId: true },
  });
  const orderByUser = new Map(allocations.map((row) => [row.userId, row.orderId]));

  await prisma.pointsRedemption.deleteMany({
    where: {
      OR: [
        { notes: { contains: 'overseas gift card' } },
        { notes: { contains: GIFT_CARD_BATCH } },
      ],
    },
  });
  await prisma.procurementCostItem.deleteMany({
    where: { kind: 'points_redeem', order: { notes: { contains: TAG } } },
  });
  const oldPayments = await prisma.payment.findMany({
    where: {
      OR: [
        { paymentNumber: { startsWith: 'PAY-RB-20260930-' } },
        { paymentNumber: { startsWith: 'PAY-RB-GC-' } },
      ],
    },
    select: { id: true, organizationTransactionId: true },
  });
  const txIds = oldPayments.map((row) => row.organizationTransactionId).filter(Boolean);
  if (oldPayments.length) {
    await prisma.payment.deleteMany({ where: { id: { in: oldPayments.map((row) => row.id) } } });
  }
  if (txIds.length) {
    await prisma.organizationTransaction.deleteMany({ where: { id: { in: txIds } } });
  }

  const redemptions = slots.map((slot, index) => {
    const person = pool[index];
    const brand = slot.brand === 'apple' ? 'Apple' : 'Amazon';
    return {
      id: crypto.randomUUID(),
      orderId: orderByUser.get(person.userId) || null,
      createdById: seller.id,
      email: person.user.email,
      emailNormalized: person.user.email,
      userId: person.userId,
      points: 500,
      asset: slot.brand === 'apple' ? 'APPLE_GIFT_CARD' : 'AMAZON_GIFT_CARD',
      amount: 5,
      vendor: brand,
      vendorReference: slot.reference,
      status: 'paid',
      paidAt: PAID_AT,
      notes: `${TAG} ${GIFT_CARD_BATCH} Redeemed 500 points ($5.00) toward ${brand} $${slot.face} gift card ${slot.index} of ${slot.qty} on Amazon order ${slot.reference}.`,
      createdAt: PAID_AT,
      updatedAt: PAID_AT,
    };
  });
  await prisma.pointsRedemption.createMany({ data: redemptions });

  for (const purchase of GIFT_CARD_PURCHASES) {
    const amount = purchaseTotal(purchase);
    const lines = purchase.lines
      .map((line) => `${line.brand === 'apple' ? 'Apple' : 'Amazon'} $${line.face} x ${line.qty}`)
      .join('; ');
    const ledger = await prisma.organizationTransaction.create({
      data: {
        amount,
        type: 'WITHDRAW',
        status: 'COMPLETED',
        description: `${TAG} Gift cards on Amazon order ${purchase.reference}`,
        userId: seller.id,
        metadata: { source: 'revenue_book_2026', batch: GIFT_CARD_BATCH, reference: purchase.reference, lines },
        createdAt: PAID_AT,
        updatedAt: PAID_AT,
      },
    });
    await prisma.payment.create({
      data: {
        paymentNumber: `PAY-RB-GC-${purchase.reference}`,
        payerId: seller.id,
        payeeId: desk.id,
        amount,
        currency: 'USD',
        method: 'gift_card',
        status: 'confirmed',
        matchStatus: 'matched',
        paidAt: PAID_AT,
        reference: purchase.reference,
        notes: `${TAG} ${GIFT_CARD_BATCH} Amazon order ${purchase.reference}: ${lines}. Total $${amount}. Redeems issued points. Not a second cost.`,
        organizationTransactionId: ledger.id,
        createdAt: PAID_AT,
        updatedAt: PAID_AT,
      },
    });
  }
  console.log(`Gift cards: ${redemptions.length} redemptions, $${GIFT_CARD_PURCHASES.reduce((sum, row) => sum + purchaseTotal(row), 0)}`);
}

async function summarize(prisma) {
  const orders = await prisma.purchaseOrder.findMany({
    where: { notes: { contains: TAG } },
    select: { orderNumber: true, total: true, serviceFeeAmount: true, notes: true },
  });
  const costs = await prisma.procurementCostItem.findMany({
    where: { kind: 'points_issue', order: { notes: { contains: TAG } } },
    select: { amountUsd: true, description: true, order: { select: { orderNumber: true } } },
  });
  const months = {};
  for (const order of orders) {
    const key = monthKey(order.orderNumber);
    if (!months[key]) months[key] = { revenue: 0, profit: 0, outflow: 0, orders: 0, reauth: 0 };
    months[key].revenue = money(months[key].revenue + order.total);
    months[key].profit = money(months[key].profit + order.serviceFeeAmount);
    months[key].orders += 1;
    if (order.notes.includes(REAUTH_MARK)) months[key].reauth += 1;
  }
  for (const cost of costs) {
    const key = monthKey(cost.order.orderNumber);
    months[key].outflow = money(months[key].outflow + cost.amountUsd);
  }
  const nodes = await prisma.point.groupBy({
    by: ['userId'],
    where: { source: 'revenue_book_referral', user: { email: { startsWith: 'rb26.node.' } } },
    _sum: { amount: true },
    _count: true,
  });
  const nodeUsers = await prisma.user.findMany({
    where: { id: { in: nodes.map((row) => row.userId) } },
    select: { id: true, email: true },
  });
  const emailById = new Map(nodeUsers.map((row) => [row.id, row.email]));
  const cards = await prisma.pointsRedemption.groupBy({
    by: ['vendorReference', 'vendor'],
    where: { notes: { contains: GIFT_CARD_BATCH } },
    _sum: { amount: true },
    _count: true,
  });
  const summary = {
    months,
    nodes: nodes
      .map((row) => ({
        email: emailById.get(row.userId),
        people: typeof row._count === 'number' ? row._count : row._count._all,
        points: row._sum.amount,
        paid: money((row._sum.amount || 0) / 100),
      }))
      .sort((left, right) => right.points - left.points),
    cards: cards.map((row) => ({
      reference: row.vendorReference,
      vendor: row.vendor,
      redemptions: row._count,
      amount: money(row._sum.amount || 0),
    })),
    reauth: orders
      .filter((order) => order.notes.includes(REAUTH_MARK))
      .map((order) => ({
        orderNumber: order.orderNumber,
        revenue: money(order.total),
        profit: money(order.serviceFeeAmount),
        margin: Number(((order.serviceFeeAmount / order.total) * 100).toFixed(1)),
      }))
      .sort((left, right) => left.orderNumber.localeCompare(right.orderNumber)),
  };
  console.log(JSON.stringify(summary));
}

async function main() {
  const prisma = new PrismaClient();
  try {
    await applyReauthorization(prisma);
    await replaceGiftCards(prisma);
    await summarize(prisma);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
