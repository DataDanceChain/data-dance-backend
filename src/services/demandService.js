const prisma = require('../utils/prisma');
const { assertMerchantKyc } = require('./merchantKyc');
const { purchasePublishedPack } = require('./packPurchase');

const OPEN_STATUSES = ['submitted', 'quoted', 'accepted', 'assembling'];
const DEMAND_INCLUDE = {
  events: { orderBy: { createdAt: 'asc' } },
  dataNFT: { select: { id: true, name: true, price: true, image: true, isPublished: true } },
  buyer: { select: { id: true, email: true, name: true } },
};

function httpError(statusCode, code, message) {
  return Object.assign(new Error(message), { statusCode, code });
}

function asMoney(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
}

function asCount(value) {
  const n = Number(value);
  return Number.isInteger(n) ? n : NaN;
}

function presentDemand(row) {
  if (!row) return row;
  const { buyer, events, dataNFT, ...rest } = row;
  return {
    ...rest,
    buyer: buyer
      ? { id: buyer.id, email: buyer.email, name: buyer.name || null }
      : undefined,
    pack: dataNFT || null,
    events: Array.isArray(events)
      ? events.map((event) => ({
          id: event.id,
          actor: event.actor,
          action: event.action,
          fromStatus: event.fromStatus,
          toStatus: event.toStatus,
          note: event.note,
          createdAt: event.createdAt,
        }))
      : [],
  };
}

function validateCreate(body = {}) {
  const recordCount = asCount(body.recordCount);
  const bidUsd = asMoney(body.bidUsd);
  const description = String(body.description || '').trim();
  const category = String(body.category || '').trim();
  if (!category) {
    throw httpError(400, 'invalid_category', 'Choose a category.');
  }
  if (!Number.isInteger(recordCount) || recordCount < 1) {
    throw httpError(400, 'invalid_count', 'Record count must be at least 1.');
  }
  if (!Number.isFinite(bidUsd) || bidUsd <= 0) {
    throw httpError(400, 'invalid_bid', 'Bid must be a positive USD amount.');
  }
  if (description.length < 8) {
    throw httpError(400, 'invalid_description', 'Describe the pack you need in a bit more detail.');
  }
  let deadline = null;
  if (body.deadline) {
    deadline = new Date(body.deadline);
    if (Number.isNaN(deadline.getTime())) {
      throw httpError(400, 'invalid_deadline', 'Deadline is not a valid date.');
    }
  }
  return {
    category,
    region: String(body.region || '').trim() || null,
    recordCount,
    description,
    bidUsd,
    deadline,
    similarPackId: String(body.similarPackId || '').trim() || null,
  };
}

async function addEvent(db, { demandId, actor, actorId, action, fromStatus, toStatus, note }) {
  return db.demandEvent.create({
    data: { demandId, actor, actorId: actorId || null, action, fromStatus, toStatus, note: note || null },
  });
}

async function createDemand(buyerId, body) {
  await assertMerchantKyc(prisma, buyerId);
  const data = validateCreate(body);
  const created = await prisma.$transaction(async (tx) => {
    const demand = await tx.dataDemand.create({
      data: { ...data, buyerId, status: 'submitted' },
    });
    await addEvent(tx, {
      demandId: demand.id,
      actor: 'merchant',
      actorId: buyerId,
      action: 'submit',
      fromStatus: null,
      toStatus: 'submitted',
    });
    return tx.dataDemand.findUnique({ where: { id: demand.id }, include: DEMAND_INCLUDE });
  });
  return presentDemand(created);
}

async function listMine(buyerId) {
  const items = await prisma.dataDemand.findMany({
    where: { buyerId },
    include: DEMAND_INCLUDE,
    orderBy: { createdAt: 'desc' },
  });
  return items.map(presentDemand);
}

async function getMine(buyerId, id) {
  const demand = await prisma.dataDemand.findFirst({
    where: { id, buyerId },
    include: DEMAND_INCLUDE,
  });
  if (!demand) throw httpError(404, 'demand_not_found', 'Request not found.');
  return presentDemand(demand);
}

async function cancelMine(buyerId, id) {
  const demand = await prisma.dataDemand.findFirst({ where: { id, buyerId } });
  if (!demand) throw httpError(404, 'demand_not_found', 'Request not found.');
  if (!['submitted', 'quoted'].includes(demand.status)) {
    throw httpError(400, 'not_cancellable', 'This request can no longer be cancelled.');
  }
  const updated = await prisma.$transaction(async (tx) => {
    const next = await tx.dataDemand.update({
      where: { id },
      data: { status: 'cancelled' },
      include: DEMAND_INCLUDE,
    });
    await addEvent(tx, {
      demandId: id,
      actor: 'merchant',
      actorId: buyerId,
      action: 'cancel',
      fromStatus: demand.status,
      toStatus: 'cancelled',
    });
    return next;
  });
  return presentDemand(updated);
}

async function acceptQuote(buyerId, id) {
  const demand = await prisma.dataDemand.findFirst({ where: { id, buyerId } });
  if (!demand) throw httpError(404, 'demand_not_found', 'Request not found.');
  if (demand.status !== 'quoted') {
    throw httpError(400, 'not_quoted', 'There is no open quote to accept.');
  }
  if (demand.quoteExpiresAt && new Date(demand.quoteExpiresAt).getTime() < Date.now()) {
    throw httpError(400, 'quote_expired', 'This quote has expired.');
  }
  const updated = await prisma.$transaction(async (tx) => {
    const next = await tx.dataDemand.update({
      where: { id },
      data: { status: 'accepted' },
      include: DEMAND_INCLUDE,
    });
    await addEvent(tx, {
      demandId: id,
      actor: 'merchant',
      actorId: buyerId,
      action: 'accept',
      fromStatus: 'quoted',
      toStatus: 'accepted',
    });
    return next;
  });
  return presentDemand(updated);
}

async function listOps({ status, page = 1, limit = 30 }) {
  const take = Math.min(Math.max(Number(limit) || 30, 1), 100);
  const skip = (Math.max(Number(page) || 1, 1) - 1) * take;
  const where = status ? { status: String(status) } : {};
  const [items, total, openCount] = await Promise.all([
    prisma.dataDemand.findMany({
      where,
      include: DEMAND_INCLUDE,
      orderBy: { createdAt: 'desc' },
      skip,
      take,
    }),
    prisma.dataDemand.count({ where }),
    prisma.dataDemand.count({ where: { status: { in: OPEN_STATUSES } } }),
  ]);
  return {
    items: items.map(presentDemand),
    openCount,
    pagination: { total, page: Math.max(Number(page) || 1, 1), limit: take },
  };
}

async function getOps(id) {
  const demand = await prisma.dataDemand.findUnique({
    where: { id },
    include: DEMAND_INCLUDE,
  });
  if (!demand) throw httpError(404, 'demand_not_found', 'Request not found.');
  return presentDemand(demand);
}

async function quoteDemand(id, actorId, body = {}) {
  const demand = await prisma.dataDemand.findUnique({ where: { id } });
  if (!demand) throw httpError(404, 'demand_not_found', 'Request not found.');
  if (!['submitted', 'quoted'].includes(demand.status)) {
    throw httpError(400, 'not_quotable', 'This request cannot take a new quote.');
  }
  const quotedPriceUsd = asMoney(body.quotedPriceUsd ?? body.priceUsd ?? demand.bidUsd);
  const quotedCount = asCount(body.quotedCount ?? demand.recordCount);
  if (!Number.isFinite(quotedPriceUsd) || quotedPriceUsd <= 0) {
    throw httpError(400, 'invalid_quote', 'Quoted price must be a positive USD amount.');
  }
  if (!Number.isInteger(quotedCount) || quotedCount < 1) {
    throw httpError(400, 'invalid_quote_count', 'Quoted count must be at least 1.');
  }
  let quoteExpiresAt = null;
  if (body.expiresAt) {
    quoteExpiresAt = new Date(body.expiresAt);
    if (Number.isNaN(quoteExpiresAt.getTime())) {
      throw httpError(400, 'invalid_expiry', 'Quote expiry is not a valid date.');
    }
  }
  const updated = await prisma.$transaction(async (tx) => {
    const next = await tx.dataDemand.update({
      where: { id },
      data: {
        status: 'quoted',
        quotedPriceUsd,
        quotedCount,
        quoteNote: String(body.note || '').trim() || null,
        quoteExpiresAt,
      },
      include: DEMAND_INCLUDE,
    });
    await addEvent(tx, {
      demandId: id,
      actor: 'ops',
      actorId,
      action: 'quote',
      fromStatus: demand.status,
      toStatus: 'quoted',
      note: next.quoteNote,
    });
    return next;
  });
  return presentDemand(updated);
}

async function declineDemand(id, actorId, reason) {
  const demand = await prisma.dataDemand.findUnique({ where: { id } });
  if (!demand) throw httpError(404, 'demand_not_found', 'Request not found.');
  if (!OPEN_STATUSES.includes(demand.status)) {
    throw httpError(400, 'not_open', 'This request is already closed.');
  }
  const note = String(reason || '').trim();
  if (note.length < 3) {
    throw httpError(400, 'decline_reason', 'Add a short reason for the merchant.');
  }
  const updated = await prisma.$transaction(async (tx) => {
    const next = await tx.dataDemand.update({
      where: { id },
      data: { status: 'declined', declineReason: note },
      include: DEMAND_INCLUDE,
    });
    await addEvent(tx, {
      demandId: id,
      actor: 'ops',
      actorId,
      action: 'decline',
      fromStatus: demand.status,
      toStatus: 'declined',
      note,
    });
    return next;
  });
  return presentDemand(updated);
}

async function markAssembling(id, actorId, note) {
  const demand = await prisma.dataDemand.findUnique({ where: { id } });
  if (!demand) throw httpError(404, 'demand_not_found', 'Request not found.');
  if (!['accepted', 'submitted', 'quoted', 'assembling'].includes(demand.status)) {
    throw httpError(400, 'not_assemblable', 'This request cannot move to assembling.');
  }
  const updated = await prisma.$transaction(async (tx) => {
    const next = await tx.dataDemand.update({
      where: { id },
      data: { status: 'assembling' },
      include: DEMAND_INCLUDE,
    });
    await addEvent(tx, {
      demandId: id,
      actor: 'ops',
      actorId,
      action: 'assemble',
      fromStatus: demand.status,
      toStatus: 'assembling',
      note: String(note || '').trim() || null,
    });
    return next;
  });
  return presentDemand(updated);
}

async function fulfillDemand(id, actorId, { dataNFTId }) {
  const demand = await prisma.dataDemand.findUnique({ where: { id } });
  if (!demand) throw httpError(404, 'demand_not_found', 'Request not found.');
  if (!['submitted', 'quoted', 'accepted', 'assembling'].includes(demand.status)) {
    throw httpError(400, 'not_fulfillable', 'This request cannot be fulfilled.');
  }
  const packId = String(dataNFTId || demand.similarPackId || '').trim();
  if (!packId) {
    throw httpError(400, 'pack_required', 'Choose a published pack to fulfill this request.');
  }

  const pack = await prisma.dataNFT.findUnique({ where: { id: packId }, select: { id: true, price: true } });
  if (!pack) throw httpError(404, 'pack_not_found', 'Pack not found.');
  const ceiling = asMoney(demand.quotedPriceUsd != null ? demand.quotedPriceUsd : demand.bidUsd);
  if (Number.isFinite(ceiling) && pack.price > ceiling + 0.009) {
    throw httpError(
      400,
      'over_bid',
      `Pack price ${pack.price} USD is above the request ceiling ${ceiling} USD.`,
    );
  }

  const purchase = await purchasePublishedPack({
    buyerId: demand.buyerId,
    dataNFTId: packId,
    quantity: 1,
    metadata: { demandId: demand.id },
  });

  const updated = await prisma.$transaction(async (tx) => {
    const next = await tx.dataDemand.update({
      where: { id },
      data: {
        status: 'fulfilled',
        dataNFTId: packId,
        purchaseId: purchase.purchase.id,
        orderId: purchase.order?.id || null,
      },
      include: DEMAND_INCLUDE,
    });
    await addEvent(tx, {
      demandId: id,
      actor: 'ops',
      actorId,
      action: 'fulfill',
      fromStatus: demand.status,
      toStatus: 'fulfilled',
      note: packId,
    });
    return next;
  });

  return {
    demand: presentDemand(updated),
    purchase: purchase.purchase,
    order: purchase.order,
    invoice: purchase.invoice,
  };
}

function failToHttp(res, error) {
  if (error.statusCode && error.statusCode < 500) {
    return res.status(error.statusCode).json({
      status: 'fail',
      code: error.code,
      error: error.message,
      message: error.message,
    });
  }
  console.error('Demand error:', error);
  return res.status(500).json({ status: 'error', message: 'Server error' });
}

module.exports = {
  OPEN_STATUSES,
  presentDemand,
  validateCreate,
  createDemand,
  listMine,
  getMine,
  cancelMine,
  acceptQuote,
  listOps,
  getOps,
  quoteDemand,
  declineDemand,
  markAssembling,
  fulfillDemand,
  failToHttp,
};
