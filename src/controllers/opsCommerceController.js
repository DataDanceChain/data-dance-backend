const { Prisma } = require('@prisma/client');
const prisma = require('../utils/prisma');
const commerceService = require('../services/commerceService');
const { publicAttestation } = require('../services/commerceAttest');
const { kycComplete, presentKyc, presentLegalEntity } = require('../services/merchantKyc');

const ORDER_ATTEST_SELECT = {
  id: true,
  orderNumber: true,
  status: true,
  total: true,
  currency: true,
  purchaseId: true,
  dataNFTId: true,
  attestationHash: true,
  attestationTxHash: true,
  attestedAt: true,
  createdAt: true,
};

function presentOpsOrder(order) {
  if (!order) return order;
  const { buyer, ...rest } = order;
  const view = {
    ...rest,
    ...publicAttestation(order),
  };
  if (buyer) {
    view.buyerName = buyer.legalEntity?.companyName || buyer.name || null;
  }
  if (view.attestationTxHash) {
    view.explorerUrl = `https://testnet.datadance.ai/tx/${view.attestationTxHash}`;
  }
  return view;
}

async function withProducts(orders) {
  const ids = [...new Set(orders.map((order) => order.dataNFTId).filter(Boolean))];
  if (!ids.length) return orders.map(presentOpsOrder);
  const packs = await prisma.$queryRaw`
    SELECT id::text AS id, name, ("dataRecords"->>'recordCount') AS "recordCount"
    FROM "DataNFT"
    WHERE id::text IN (${Prisma.join(ids)})
  `;
  const byId = new Map(packs.map((pack) => [pack.id, pack]));
  return orders.map((order) => {
    const view = presentOpsOrder(order);
    const pack = byId.get(order.dataNFTId);
    view.productName = pack?.name || null;
    const count = Number(pack?.recordCount);
    view.recordCount = Number.isFinite(count) && count > 0 ? count : null;
    return view;
  });
}

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,128}$/;

/**
 * The optional Idempotency-Key header of a merchant credit: null when absent or empty; a 400
 * (INVALID_IDEMPOTENCY_KEY) when it is not 8 to 128 letters, digits, dots, colons, dashes or
 * underscores.
 */
function idempotencyKeyOf(req) {
  const raw = req.get('Idempotency-Key');
  if (raw === undefined || String(raw).trim() === '') return null;
  const key = String(raw).trim();
  if (!IDEMPOTENCY_KEY.test(key)) {
    throw Object.assign(new Error('Idempotency-Key must be 8 to 128 letters, digits, dots, colons, dashes or underscores.'), {
      statusCode: 400,
      code: 'INVALID_IDEMPOTENCY_KEY',
    });
  }
  return key;
}

/**
 * The answer to a credit whose key a merchant's earlier credit already holds: that credit
 * (`replayed`), when the amount and the note are the same; otherwise 409 IDEMPOTENCY_KEY_REUSED.
 */
function replayCredit(earlier, amount, note) {
  if (Number(earlier.amount) !== amount || String(earlier.description || '') !== note) {
    throw Object.assign(new Error('This Idempotency-Key was already used for a different credit.'), {
      statusCode: 409,
      code: 'IDEMPOTENCY_KEY_REUSED',
    });
  }
  return { transaction: earlier, replayed: true };
}

function keyedCredit(userId, idempotencyKey) {
  return prisma.organizationTransaction.findUnique({
    where: { userId_idempotencyKey: { userId, idempotencyKey } },
  });
}

/**
 * Writes the merchant's DEPOSIT row, once per Idempotency-Key. The database holds one row per
 * merchant and key (a unique index): a credit whose key is taken, also by a request running at
 * the same moment, writes nothing and answers the row that holds it (replayCredit).
 */
async function creditOnce({ userId, amount, note, operator, idempotencyKey }) {
  if (idempotencyKey) {
    const earlier = await keyedCredit(userId, idempotencyKey);
    if (earlier) return replayCredit(earlier, amount, note);
  }
  try {
    const transaction = await prisma.organizationTransaction.create({
      data: {
        userId,
        amount,
        type: 'DEPOSIT',
        status: 'COMPLETED',
        description: note,
        idempotencyKey,
        metadata: {
          source: 'ops_credit',
          operator,
        },
      },
    });
    return { transaction, replayed: false };
  } catch (error) {
    if (idempotencyKey && error && error.code === 'P2002') {
      const earlier = await keyedCredit(userId, idempotencyKey);
      if (earlier) return replayCredit(earlier, amount, note);
    }
    throw error;
  }
}

function asInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function asMoney(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function isDemo(req) {
  return req.opsAdmin?.role === 'demo';
}

function maskEmail(value) {
  const email = String(value || '').trim();
  const at = email.indexOf('@');
  if (at < 1) return email ? '••••' : '';
  if (email.includes('•')) return email;
  const local = email.slice(0, at);
  const keep = Math.min(3, local.length);
  return `${local.slice(0, keep)}${'•'.repeat(Math.max(3, Math.min(6, local.length - keep)))}@••••`;
}

function maskHash(value) {
  const hash = String(value || '');
  if (hash.length < 16 || hash.includes('…')) return hash;
  return `${hash.slice(0, 6)}…${hash.slice(-4)}`;
}

function cleanNote(value) {
  return String(value || '')
    .replace(/\[[^\]]{0,80}\]\s*/g, '')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, (email) => maskEmail(email))
    .trim();
}

function redactMerchant(row) {
  if (!row) return row;
  const next = { ...row, email: maskEmail(row.email) };
  if (String(next.name || '').includes('@')) next.name = maskEmail(next.name);
  if (next.kyc) next.kyc = { ...next.kyc, note: null, reviewedBy: null };
  return next;
}

function redactLegalEntity(entity) {
  if (!entity) return entity;
  return {
    companyName: entity.companyName || '',
    country: entity.country || '',
    currency: entity.currency || 'USD',
    email: maskEmail(entity.email),
    kyc: entity.kyc ? { ...entity.kyc, note: null, reviewedBy: null } : entity.kyc,
  };
}

function redactDemoOrder(view) {
  if (!view) return view;
  view.productDescription = null;
  view.grossProfit = null;
  view.contributorCost = null;
  view.referralCost = null;
  if (view.attestationTxHash) view.attestationTxHash = maskHash(view.attestationTxHash);
  if (view.attestationHash) view.attestationHash = maskHash(view.attestationHash);
  return view;
}

/** Same USD wallet as merchant Account: completed ledger, withdrawals subtract. */
async function orgBalance(userId) {
  const rows = await prisma.organizationTransaction.findMany({
    where: { userId, status: 'COMPLETED' },
    select: { amount: true, type: true },
  });
  return rows.reduce((acc, tx) => {
    const amount = asMoney(tx.amount);
    return tx.type === 'WITHDRAW' ? acc - amount : acc + amount;
  }, 0);
}

function presentMerchantRow(user, balance) {
  const { legalEntity, ...rest } = user;
  const companyName = String(legalEntity?.companyName || '').trim() || null;
  return {
    ...rest,
    balance: asMoney(balance),
    currency: 'USD',
    companyName,
    kyc: {
      ...presentKyc(legalEntity),
      companyName,
    },
  };
}

exports.overview = async (req, res) => {
  try {
    const [pendingTopUps, merchants, pendingCredits, pendingAttestations] = await Promise.all([
      prisma.payment.count({ where: { method: 'top_up', status: 'pending' } }),
      prisma.user.count({ where: { isOrganization: true } }),
      prisma.organizationTransaction.count({ where: { type: 'DEPOSIT', status: 'PENDING' } }),
      prisma.purchaseOrder.count({
        where: { attestationHash: { not: null }, attestationTxHash: null },
      }),
    ]);
    let openPrivacyRequests = 0;
    try {
      openPrivacyRequests = await prisma.privacyRequest.count({ where: { status: 'open' } });
    } catch (error) {
      console.warn('Privacy request count skipped:', error.message);
    }
    return res.json({
      status: 'success',
      data: { pendingTopUps, pendingCredits, merchants, openPrivacyRequests, pendingAttestations },
    });
  } catch (error) {
    console.error('Ops overview error:', error);
    return res.status(500).json({ status: 'error', message: 'Server error' });
  }
};

exports.listPayments = async (req, res) => {
  try {
    const page = asInt(req.query.page, 1);
    const limit = Math.min(asInt(req.query.limit, 20), 100);
    const where = {
      ...(req.query.status ? { status: String(req.query.status) } : {}),
      ...(req.query.method ? { method: String(req.query.method) } : {}),
    };
    const [items, total] = await Promise.all([
      prisma.payment.findMany({
        where,
        include: {
          order: { select: ORDER_ATTEST_SELECT },
          invoice: { select: { id: true, invoiceNumber: true, status: true, total: true, currency: true } },
          payer: {
            select: {
              id: true,
              name: true,
              email: true,
              isOrganization: true,
              legalEntity: true,
            },
          },
          payee: { select: { id: true, name: true, email: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.payment.count({ where }),
    ]);
    return res.json({
      status: 'success',
      data: {
        items: items.map((item) => ({
          ...item,
          currency: 'USD',
          order: presentOpsOrder(item.order),
          payer: item.payer
            ? {
                id: item.payer.id,
                name: item.payer.name,
                email: item.payer.email,
                isOrganization: item.payer.isOrganization,
                kyc: presentKyc(item.payer.legalEntity),
              }
            : item.payer,
        })),
        pagination: { total, page, limit, pages: Math.ceil(total / limit) || 1 },
      },
    });
  } catch (error) {
    console.error('Ops payments error:', error);
    return res.status(500).json({ status: 'error', message: 'Server error' });
  }
};

/** A refused ops payment decision: its status, and its code when it has one (409s carry one). */
function sendPaymentDecisionError(res, error) {
  const code = error.statusCode || 500;
  return res.status(code).json({
    status: code >= 500 ? 'error' : 'fail',
    ...(error.code && code < 500 ? { code: error.code } : {}),
    message: error.message,
  });
}

/**
 * Only the call that confirmed the payment attests its order. A repeat confirm changes nothing and
 * attests nothing; a failed attestation is retried with POST /orders/:id/attest.
 */
exports.confirmPayment = async (req, res) => {
  try {
    const { payment, changed } = await commerceService.confirmPaymentByOps(
      req.params.id,
      req.opsAdmin?.username || 'ops',
    );
    const orderId = payment?.orderId || payment?.order?.id;
    if (changed && orderId) {
      const commerceAttest = require('../services/commerceAttest');
      await commerceAttest.attestPaidOrderSafe(orderId);
    }
    return res.json({ status: 'success', data: payment });
  } catch (error) {
    return sendPaymentDecisionError(res, error);
  }
};

exports.rejectPayment = async (req, res) => {
  try {
    const payment = await commerceService.rejectPaymentByOps(
      req.params.id,
      req.body?.notes,
      req.opsAdmin?.username || 'ops',
    );
    return res.json({ status: 'success', data: payment });
  } catch (error) {
    return sendPaymentDecisionError(res, error);
  }
};

exports.listMerchants = async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const page = asInt(req.query.page, 1);
    const limit = Math.min(asInt(req.query.limit, 20), 100);
    const where = {
      isOrganization: true,
      ...(q.length >= 2
        ? {
            OR: [
              { email: { contains: q, mode: 'insensitive' } },
              { name: { contains: q, mode: 'insensitive' } },
              { id: q },
            ],
          }
        : {}),
    };
    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        select: {
          id: true,
          email: true,
          name: true,
          createdAt: true,
          isOrganization: true,
          legalEntity: true,
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.user.count({ where }),
    ]);
    const items = await Promise.all(
      users.map(async (user) => {
        const row = presentMerchantRow(user, await orgBalance(user.id));
        return isDemo(req) ? redactMerchant(row) : row;
      }),
    );
    return res.json({
      status: 'success',
      data: {
        items,
        pagination: { total, page, limit, pages: Math.ceil(total / limit) || 1 },
      },
    });
  } catch (error) {
    console.error('Ops merchants error:', error);
    return res.status(500).json({ status: 'error', message: 'Server error' });
  }
};

exports.getMerchant = async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.params.userId },
      select: {
        id: true,
        email: true,
        name: true,
        createdAt: true,
        isOrganization: true,
        legalEntity: true,
      },
    });
    if (!user || !user.isOrganization) {
      return res.status(404).json({ status: 'fail', message: 'Merchant not found' });
    }
    const { legalEntity, ...merchant } = user;
    const [balance, transactions, pendingPayments, orders] = await Promise.all([
      orgBalance(user.id),
      prisma.organizationTransaction.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: 'desc' },
        take: 30,
      }),
      prisma.payment.findMany({
        where: { payerId: user.id, method: 'top_up' },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
      prisma.purchaseOrder.findMany({
        where: { OR: [{ buyerId: user.id }, { sellerId: user.id }] },
        select: ORDER_ATTEST_SELECT,
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
    ]);
    const listed = presentMerchantRow(user, balance);
    const demo = isDemo(req);
    const account = demo ? redactMerchant({ ...merchant, kyc: listed.kyc, companyName: listed.companyName }) : { ...merchant, kyc: listed.kyc, companyName: listed.companyName };
    return res.json({
      status: 'success',
      data: {
        user: account,
        legalEntity: demo ? redactLegalEntity(presentLegalEntity(legalEntity)) : presentLegalEntity(legalEntity),
        kyc: account.kyc,
        balance: listed.balance,
        currency: 'USD',
        companyName: listed.companyName,
        transactions: demo
          ? transactions.map(({ metadata, ...tx }) => ({ ...tx, description: cleanNote(tx.description) }))
          : transactions,
        pendingPayments: demo ? [] : pendingPayments,
        orders: orders.map(presentOpsOrder),
      },
    });
  } catch (error) {
    console.error('Ops merchant detail error:', error);
    return res.status(500).json({ status: 'error', message: 'Server error' });
  }
};

/**
 * Credit a merchant's USD balance. An optional Idempotency-Key header makes a repeat of the same
 * credit (a double submit, a retry after a lost answer) answer the first one instead of crediting
 * again (creditOnce): 200 with that credit and `replayed: true`, and no new row. The same key with
 * another amount or note is refused: 409 IDEMPOTENCY_KEY_REUSED. Without the header every call
 * credits.
 */
exports.creditMerchant = async (req, res) => {
  try {
    const amount = Number(req.body?.amount);
    const note = String(req.body?.note || '').trim();
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ status: 'fail', message: 'Enter a positive amount' });
    }
    if (note.length < 2) {
      return res.status(400).json({ status: 'fail', message: 'Note is required' });
    }
    const idempotencyKey = idempotencyKeyOf(req);
    const user = await prisma.user.findUnique({
      where: { id: req.params.userId },
      select: { id: true, isOrganization: true },
    });
    if (!user || !user.isOrganization) {
      return res.status(404).json({ status: 'fail', message: 'Merchant not found' });
    }
    const { transaction, replayed } = await creditOnce({
      userId: user.id,
      amount,
      note,
      operator: req.opsAdmin?.username || 'ops',
      idempotencyKey,
    });
    return res.json({
      status: 'success',
      data: { transaction, balance: await orgBalance(user.id), ...(replayed ? { replayed: true } : {}) },
    });
  } catch (error) {
    const status = error.statusCode || 500;
    if (status < 500) {
      return res.status(status).json({ status: 'fail', code: error.code, message: error.message });
    }
    console.error('Ops credit error:', error);
    return res.status(500).json({ status: 'error', message: 'Server error' });
  }
};

exports.listOrders = async (req, res) => {
  try {
    const page = asInt(req.query.page, 1);
    const limit = Math.min(asInt(req.query.limit, 20), 100);
    const attestation = String(req.query.attestation || '').trim();
    const productOnly = String(req.query.product || '') === '1';
    const where = {
      ...(req.query.status ? { status: String(req.query.status) } : {}),
      ...(productOnly ? { dataNFTId: { not: null } } : {}),
      ...(attestation === 'pending'
        ? { attestationHash: { not: null }, attestationTxHash: null }
        : attestation === 'on_chain'
          ? { attestationTxHash: { not: null } }
          : attestation === 'recorded'
            ? { attestationHash: { not: null }, attestationTxHash: null }
            : {}),
    };
    const [items, total] = await Promise.all([
      prisma.purchaseOrder.findMany({
        where,
        select: {
          ...ORDER_ATTEST_SELECT,
          buyer: { select: { name: true, legalEntity: { select: { companyName: true } } } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.purchaseOrder.count({ where }),
    ]);
    return res.json({
      status: 'success',
      data: {
        items: await withProducts(items),
        pagination: { total, page, limit, pages: Math.ceil(total / limit) || 1 },
      },
    });
  } catch (error) {
    console.error('Ops orders error:', error);
    return res.status(500).json({ status: 'error', message: 'Server error' });
  }
};

function costRole(item) {
  const text = `${item.kind || ''} ${item.description || ''}`;
  if (/referral/i.test(text)) return 'referral';
  if (/contributor/i.test(text)) return 'contributor';
  return null;
}

exports.getOrder = async (req, res) => {
  try {
    const order = await prisma.purchaseOrder.findUnique({
      where: { id: req.params.id },
      select: {
        ...ORDER_ATTEST_SELECT,
        subtotal: true,
        serviceFeeAmount: true,
        licenceAcceptedAt: true,
        licenceVersion: true,
        buyer: { select: { name: true, legalEntity: { select: { companyName: true } } } },
        lineItems: {
          select: { id: true, description: true, quantity: true, unitPrice: true, total: true },
          orderBy: { description: 'asc' },
        },
        invoices: {
          select: { invoiceNumber: true, status: true, total: true, currency: true, issueDate: true, paidAt: true },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
        payments: {
          where: { method: { not: 'gift_card' } },
          select: { paymentNumber: true, amount: true, currency: true, method: true, status: true, paidAt: true },
          orderBy: { paidAt: 'desc' },
          take: 1,
        },
        costItems: {
          where: { kind: 'points_issue' },
          select: { kind: true, description: true, amountUsd: true },
        },
      },
    });
    if (!order) {
      return res.status(404).json({ status: 'fail', message: 'Order not found' });
    }
    const [view] = await withProducts([order]);
    delete view.costItems;
    delete view.invoices;
    delete view.payments;
    if (order.dataNFTId) {
      const packs = await prisma.$queryRaw`
        SELECT description, image
        FROM "DataNFT"
        WHERE id::text = ${order.dataNFTId}
      `;
      view.productDescription = packs[0]?.description || null;
      view.image = packs[0]?.image || null;
    }
    const costs = { contributor: 0, referral: 0 };
    for (const item of order.costItems || []) {
      const role = costRole(item);
      if (role) costs[role] = asMoney(costs[role] + asMoney(item.amountUsd));
    }
    const invoice = order.invoices?.[0] || null;
    const payment = order.payments?.[0] || null;
    const data = {
      ...view,
      subtotal: order.subtotal,
      grossProfit: order.serviceFeeAmount,
      licenceAcceptedAt: order.licenceAcceptedAt,
      licenceVersion: order.licenceVersion,
      lineItems: order.lineItems,
      invoice,
      payment,
      contributorCost: costs.contributor || null,
      referralCost: costs.referral || null,
    };
    return res.json({
      status: 'success',
      data: isDemo(req) ? redactDemoOrder(data) : data,
    });
  } catch (error) {
    console.error('Ops order detail error:', error);
    return res.status(500).json({ status: 'error', message: 'Server error' });
  }
};

exports.attestOrder = async (req, res) => {
  try {
    const commerceAttest = require('../services/commerceAttest');
    const data = await commerceAttest.attestPaidOrder(req.params.id, {
      txHash: req.body?.txHash,
      submittedBy: `ops:${req.opsAdmin?.username || 'unknown'}`,
    });
    return res.json({ status: 'success', data });
  } catch (error) {
    const code = error.statusCode || 500;
    return res.status(code).json({
      status: code >= 500 ? 'error' : 'fail',
      ...(error.code ? { code: error.code } : {}),
      message: error.message,
    });
  }
};

exports.reviewMerchantKyc = async (req, res) => {
  try {
    const nextStatus = String(req.body?.status || '').trim();
    const note = String(req.body?.note || '').trim();
    if (!['approved', 'rejected'].includes(nextStatus)) {
      return res.status(400).json({ status: 'fail', message: 'Status must be approved or rejected' });
    }
    if (nextStatus === 'rejected' && note.length < 2) {
      return res.status(400).json({ status: 'fail', message: 'Add a note when rejecting KYC' });
    }
    const user = await prisma.user.findUnique({
      where: { id: req.params.userId },
      include: { legalEntity: true },
    });
    if (!user || !user.isOrganization) {
      return res.status(404).json({ status: 'fail', message: 'Merchant not found' });
    }
    if (!user.legalEntity) {
      return res.status(400).json({ status: 'fail', message: 'Merchant has not submitted company details' });
    }
    if (nextStatus === 'approved' && !kycComplete(user.legalEntity)) {
      return res.status(400).json({ status: 'fail', message: 'Required KYC fields are still missing' });
    }
    const legalEntity = await prisma.legalEntity.update({
      where: { userId: user.id },
      data: {
        kycStatus: nextStatus,
        kycReviewedAt: new Date(),
        kycReviewedBy: req.opsAdmin?.username || 'ops',
        kycNote: note || null,
      },
    });
    return res.json({
      status: 'success',
      data: {
        legalEntity: presentLegalEntity(legalEntity),
        kyc: presentKyc(legalEntity),
      },
    });
  } catch (error) {
    console.error('Ops KYC review error:', error);
    return res.status(500).json({ status: 'error', message: 'Server error' });
  }
};
