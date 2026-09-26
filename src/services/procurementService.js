const crypto = require('crypto');
const prisma = require('../utils/prisma');
const commerceService = require('./commerceService');
const { normalizeEmail, isValidEmail, maskEmail, stripEmail } = require('../utils/emailMask');

const DEFAULT_POINTS_PRICE = 0.01;

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function asNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function getSettings() {
  return prisma.commerceSettings.upsert({
    where: { id: 'default' },
    update: {},
    create: { id: 'default', pointsUnitPriceUsd: DEFAULT_POINTS_PRICE },
  });
}

async function updateSettings(pointsUnitPriceUsd) {
  const price = asNumber(pointsUnitPriceUsd, DEFAULT_POINTS_PRICE);
  if (price < 0) {
    throw Object.assign(new Error('Points unit price must be zero or greater'), { statusCode: 400 });
  }
  return prisma.commerceSettings.upsert({
    where: { id: 'default' },
    update: { pointsUnitPriceUsd: price },
    create: { id: 'default', pointsUnitPriceUsd: price },
  });
}

async function resolveUnitPrice(order) {
  if (order?.pointsUnitPriceUsd != null) return asNumber(order.pointsUnitPriceUsd);
  const settings = await getSettings();
  return asNumber(settings.pointsUnitPriceUsd, DEFAULT_POINTS_PRICE);
}

async function resolveIdentity(email) {
  const emailNormalized = normalizeEmail(email);
  if (!isValidEmail(emailNormalized)) {
    throw Object.assign(new Error('A valid email is required'), { statusCode: 400 });
  }
  const user = await prisma.user.findUnique({
    where: { email: emailNormalized },
    select: { id: true, email: true },
  });
  return {
    email: emailNormalized,
    emailNormalized,
    userId: user?.id || null,
    claimStatus: user ? 'claimable' : 'reserved',
  };
}

function orderVisibleWhere(userId) {
  return { OR: [{ buyerId: userId }, { sellerId: userId }] };
}

async function requireOrder(user, orderId) {
  const order = await prisma.purchaseOrder.findUnique({ where: { id: orderId } });
  if (!order) {
    throw Object.assign(new Error('Order not found'), { statusCode: 404 });
  }
  if (!commerceService.canAccessRecord(user, order)) {
    throw Object.assign(new Error('Not authorized to manage this order'), { statusCode: 403 });
  }
  return order;
}

async function upsertCostItem({ orderId, kind, description, points, unitPriceUsd, sourceType, sourceId }) {
  const amountUsd = Number((asNumber(points) * asNumber(unitPriceUsd)).toFixed(4));
  const existing = sourceId
    ? await prisma.procurementCostItem.findFirst({
      where: { orderId, sourceType, sourceId },
    })
    : null;
  const data = {
    orderId,
    kind,
    description,
    points: asNumber(points),
    unitPriceUsd: asNumber(unitPriceUsd),
    amountUsd,
    sourceType,
    sourceId,
  };
  if (existing) {
    return prisma.procurementCostItem.update({ where: { id: existing.id }, data });
  }
  return prisma.procurementCostItem.create({ data });
}

async function syncAllocationCost(order, allocation, unitPriceUsd) {
  const label = allocation.kind === 'referral' ? 'Referral points' : 'User points';
  return upsertCostItem({
    orderId: order.id,
    kind: 'points_issue',
    description: `${label} reserved for ${maskEmail(allocation.email)}`,
    points: allocation.points,
    unitPriceUsd,
    sourceType: 'allocation',
    sourceId: allocation.id,
  });
}

async function syncRedemptionCost(orderId, redemption) {
  if (!orderId) return null;
  return upsertCostItem({
    orderId,
    kind: 'points_redeem',
    description: `Points redeemed to ${redemption.asset}${redemption.vendor ? ` via ${redemption.vendor}` : ''}`,
    points: redemption.points,
    unitPriceUsd: redemption.points > 0 ? Number((redemption.amount / redemption.points).toFixed(6)) : 0,
    sourceType: 'redemption',
    sourceId: redemption.id,
  });
}

function publicAllocation(row) {
  return stripEmail(row);
}

function publicRedemption(row) {
  return stripEmail(row);
}

function summarizeOrder(order) {
  const allocations = order.allocations || [];
  const users = allocations.filter((row) => row.kind === 'user');
  const referrals = allocations.filter((row) => row.kind === 'referral');
  const costItems = order.costItems || [];
  const redemptions = order.redemptions || [];
  const issued = costItems.filter((row) => row.kind === 'points_issue');
  const redeemed = costItems.filter((row) => row.kind === 'points_redeem');
  return {
    userCount: users.length,
    referralCount: referrals.length,
    pointsReserved: users.reduce((sum, row) => sum + asNumber(row.points), 0),
    referralPointsReserved: referrals.reduce((sum, row) => sum + asNumber(row.points), 0),
    costIssuedUsd: Number(issued.reduce((sum, row) => sum + asNumber(row.amountUsd), 0).toFixed(2)),
    costRedeemedUsd: Number(redeemed.reduce((sum, row) => sum + asNumber(row.amountUsd), 0).toFixed(2)),
    redemptionCount: redemptions.length,
    attested: Boolean(order.attestationHash),
  };
}

async function addAllocations(user, orderId, rows = []) {
  const order = await requireOrder(user, orderId);
  const unitPrice = await resolveUnitPrice(order);
  const created = [];
  for (const row of rows) {
    const kind = row.kind === 'referral' ? 'referral' : 'user';
    const identity = await resolveIdentity(row.email);
    const allocation = await prisma.procurementAllocation.create({
      data: {
        orderId: order.id,
        kind,
        email: identity.email,
        emailNormalized: identity.emailNormalized,
        displayName: row.displayName ? String(row.displayName).trim() : null,
        role: row.role ? String(row.role).trim() : (kind === 'referral' ? 'referrer' : 'data_contributor'),
        points: Math.max(0, asNumber(row.points)),
        userId: identity.userId,
        claimStatus: identity.claimStatus,
        note: row.note ? String(row.note).trim() : null,
      },
    });
    await syncAllocationCost(order, allocation, unitPrice);
    created.push(publicAllocation(allocation));
  }
  return created;
}

async function listAllocations(userId, { page = 1, limit = 20, kind, orderId } = {}) {
  const where = {
    order: orderVisibleWhere(userId),
    ...(kind ? { kind } : {}),
    ...(orderId ? { orderId } : {}),
  };
  const skip = (Number(page) - 1) * Number(limit);
  const [items, total] = await Promise.all([
    prisma.procurementAllocation.findMany({
      where,
      include: { order: { select: { id: true, orderNumber: true, currency: true } } },
      orderBy: { createdAt: 'desc' },
      skip,
      take: Number(limit),
    }),
    prisma.procurementAllocation.count({ where }),
  ]);
  return {
    items: items.map(publicAllocation),
    pagination: {
      total,
      page: Number(page),
      limit: Number(limit),
      pages: Math.ceil(total / Number(limit)) || 1,
    },
  };
}

async function deleteAllocation(user, allocationId) {
  const allocation = await prisma.procurementAllocation.findUnique({
    where: { id: allocationId },
    include: { order: true },
  });
  if (!allocation) {
    throw Object.assign(new Error('Allocation not found'), { statusCode: 404 });
  }
  if (!commerceService.canAccessRecord(user, allocation.order)) {
    throw Object.assign(new Error('Not authorized to delete this allocation'), { statusCode: 403 });
  }
  await prisma.procurementCostItem.deleteMany({
    where: { sourceType: 'allocation', sourceId: allocation.id },
  });
  await prisma.procurementAllocation.delete({ where: { id: allocation.id } });
  return { id: allocation.id };
}

function buildAttestationPayload(order, allocations) {
  const emailsHash = sha256(
    allocations.map((row) => row.emailNormalized).sort().join('|'),
  );
  return {
    type: 'datadance.procurement.metadata.v1',
    orderNumber: order.orderNumber,
    currency: order.currency,
    subtotal: order.subtotal,
    taxAmount: order.taxAmount,
    total: order.total,
    serviceFeeAmount: order.serviceFeeAmount || 0,
    buyerId: order.buyerId,
    sellerId: order.sellerId,
    lineItems: (order.lineItems || []).map((item) => ({
      description: item.description,
      category: item.category,
      quantity: item.quantity,
      unit: item.unit,
      unitPrice: item.unitPrice,
      total: item.total,
    })),
    allocationCount: allocations.filter((row) => row.kind === 'user').length,
    referralCount: allocations.filter((row) => row.kind === 'referral').length,
    allocationEmailsHash: emailsHash,
    datasetBytesExcluded: true,
    note: 'On-chain attestation stores order metadata only. The AI dataset itself is not written to the chain.',
  };
}

async function attestOrder(user, orderId, { txHash } = {}) {
  const order = await requireOrder(user, orderId);
  const commerceAttest = require('./commerceAttest');
  if (order.purchaseId || order.dataNFTId) {
    const attested = await commerceAttest.attestPaidOrder(order.id, { txHash });
    return {
      id: order.id,
      orderNumber: attested.orderNumber || order.orderNumber,
      ...attested,
    };
  }
  const full = await prisma.purchaseOrder.findUnique({
    where: { id: order.id },
    include: { lineItems: true, allocations: true },
  });
  const existing = full.attestationPayload && full.attestationPayload.type === 'datadance.procurement.metadata.v1'
    ? full.attestationPayload
    : null;
  const payload = existing || buildAttestationPayload(full, full.allocations || []);
  const attestationHash = sha256(JSON.stringify(payload));
  let attestationTxHash = txHash && /^0x[0-9a-fA-F]{64}$/.test(String(txHash).trim())
    ? String(txHash).trim()
    : (full.attestationTxHash && /^0x[0-9a-fA-F]{64}$/.test(full.attestationTxHash) ? full.attestationTxHash : null);
  if (!attestationTxHash) {
    const { attestHashOnChain } = require('../utils/commerceAttestChain');
    const chain = await attestHashOnChain(attestationHash);
    if (chain.ok && chain.txHash) attestationTxHash = chain.txHash;
  }
  const updated = await prisma.purchaseOrder.update({
    where: { id: order.id },
    data: {
      attestationPayload: payload,
      attestationHash,
      attestationTxHash,
      attestedAt: new Date(),
    },
  });
  return {
    id: updated.id,
    orderNumber: updated.orderNumber,
    ...commerceAttest.publicAttestation(updated),
  };
}

async function listCostItems(userId, { page = 1, limit = 20, kind, orderId } = {}) {
  const where = {
    order: orderVisibleWhere(userId),
    ...(kind ? { kind } : {}),
    ...(orderId ? { orderId } : {}),
  };
  const skip = (Number(page) - 1) * Number(limit);
  const [items, total] = await Promise.all([
    prisma.procurementCostItem.findMany({
      where,
      include: { order: { select: { id: true, orderNumber: true, currency: true } } },
      orderBy: { createdAt: 'desc' },
      skip,
      take: Number(limit),
    }),
    prisma.procurementCostItem.count({ where }),
  ]);
  const allForTotals = await prisma.procurementCostItem.findMany({
    where,
    select: { kind: true, amountUsd: true, points: true },
  });
  return {
    items,
    totals: {
      issuedUsd: Number(allForTotals.filter((row) => row.kind === 'points_issue').reduce((sum, row) => sum + row.amountUsd, 0).toFixed(2)),
      redeemedUsd: Number(allForTotals.filter((row) => row.kind === 'points_redeem').reduce((sum, row) => sum + row.amountUsd, 0).toFixed(2)),
      issuedPoints: Number(allForTotals.filter((row) => row.kind === 'points_issue').reduce((sum, row) => sum + row.points, 0).toFixed(2)),
      redeemedPoints: Number(allForTotals.filter((row) => row.kind === 'points_redeem').reduce((sum, row) => sum + row.points, 0).toFixed(2)),
    },
    pagination: {
      total,
      page: Number(page),
      limit: Number(limit),
      pages: Math.ceil(total / Number(limit)) || 1,
    },
  };
}

async function createRedemption(user, {
  orderId,
  email,
  points,
  asset = 'USDT',
  amount,
  vendor,
  vendorReference,
  notes,
  proofPath,
}) {
  let order = null;
  if (orderId) {
    order = await requireOrder(user, orderId);
  }
  const identity = await resolveIdentity(email);
  const parsedPoints = Math.max(0, asNumber(points));
  const parsedAmount = Math.max(0, asNumber(amount));
  if (!parsedPoints || !parsedAmount) {
    throw Object.assign(new Error('Points and payout amount are required'), { statusCode: 400 });
  }
  const redemption = await prisma.pointsRedemption.create({
    data: {
      orderId: order?.id || null,
      createdById: user.id,
      email: identity.email,
      emailNormalized: identity.emailNormalized,
      userId: identity.userId,
      points: parsedPoints,
      asset: asset || 'USDT',
      amount: parsedAmount,
      vendor: vendor ? String(vendor).trim() : null,
      vendorReference: vendorReference ? String(vendorReference).trim() : null,
      notes: notes ? String(notes).trim() : null,
      proofPath: proofPath || null,
      status: 'pending',
    },
  });
  if (order) {
    await syncRedemptionCost(order.id, redemption);
  }
  return publicRedemption(redemption);
}

async function listRedemptions(userId, { page = 1, limit = 20, status, orderId } = {}) {
  const where = {
    OR: [
      { order: orderVisibleWhere(userId) },
      { createdById: userId },
    ],
    ...(status ? { status } : {}),
    ...(orderId ? { orderId } : {}),
  };
  const skip = (Number(page) - 1) * Number(limit);
  const [items, total] = await Promise.all([
    prisma.pointsRedemption.findMany({
      where,
      include: { order: { select: { id: true, orderNumber: true, currency: true } } },
      orderBy: { createdAt: 'desc' },
      skip,
      take: Number(limit),
    }),
    prisma.pointsRedemption.count({ where }),
  ]);
  return {
    items: items.map(publicRedemption),
    pagination: {
      total,
      page: Number(page),
      limit: Number(limit),
      pages: Math.ceil(total / Number(limit)) || 1,
    },
  };
}

async function attachRedemptionProof(user, redemptionId, proofPath) {
  const redemption = await prisma.pointsRedemption.findUnique({
    where: { id: redemptionId },
    include: { order: true },
  });
  if (!redemption) {
    throw Object.assign(new Error('Redemption not found'), { statusCode: 404 });
  }
  if (redemption.order && !commerceService.canAccessRecord(user, redemption.order)) {
    throw Object.assign(new Error('Not authorized to update this redemption'), { statusCode: 403 });
  }
  const updated = await prisma.pointsRedemption.update({
    where: { id: redemptionId },
    data: { proofPath },
  });
  return publicRedemption(updated);
}

async function confirmRedemption(user, redemptionId, { paidAt, vendorReference, notes } = {}) {
  const redemption = await prisma.pointsRedemption.findUnique({
    where: { id: redemptionId },
    include: { order: true },
  });
  if (!redemption) {
    throw Object.assign(new Error('Redemption not found'), { statusCode: 404 });
  }
  if (redemption.order && !commerceService.canAccessRecord(user, redemption.order)) {
    throw Object.assign(new Error('Not authorized to confirm this redemption'), { statusCode: 403 });
  }
  const updated = await prisma.pointsRedemption.update({
    where: { id: redemptionId },
    data: {
      status: 'paid',
      paidAt: paidAt ? new Date(paidAt) : new Date(),
      vendorReference: vendorReference || redemption.vendorReference,
      notes: notes || redemption.notes,
    },
  });
  if (updated.orderId) {
    await syncRedemptionCost(updated.orderId, updated);
  }
  return publicRedemption(updated);
}

module.exports = {
  getSettings,
  updateSettings,
  addAllocations,
  listAllocations,
  deleteAllocation,
  attestOrder,
  listCostItems,
  createRedemption,
  listRedemptions,
  attachRedemptionProof,
  confirmRedemption,
  syncRedemptionCost,
  publicAllocation,
  publicRedemption,
  summarizeOrder,
};
