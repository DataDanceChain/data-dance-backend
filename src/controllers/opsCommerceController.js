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
  return {
    ...order,
    ...publicAttestation(order),
  };
}

function asInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function asMoney(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
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

exports.confirmPayment = async (req, res) => {
  try {
    const payment = await commerceService.confirmPaymentByOps(
      req.params.id,
      req.opsAdmin?.username || 'ops',
    );
    const orderId = payment?.orderId || payment?.order?.id;
    if (orderId) {
      const commerceAttest = require('../services/commerceAttest');
      await commerceAttest.attestPaidOrderSafe(orderId);
    }
    return res.json({ status: 'success', data: payment });
  } catch (error) {
    const code = error.statusCode || 500;
    return res.status(code).json({ status: code >= 500 ? 'error' : 'fail', message: error.message });
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
    const code = error.statusCode || 500;
    return res.status(code).json({ status: code >= 500 ? 'error' : 'fail', message: error.message });
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
      users.map(async (user) => presentMerchantRow(user, await orgBalance(user.id))),
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
    return res.json({
      status: 'success',
      data: {
        user: { ...merchant, kyc: listed.kyc, companyName: listed.companyName },
        legalEntity: presentLegalEntity(legalEntity),
        kyc: listed.kyc,
        balance: listed.balance,
        currency: 'USD',
        companyName: listed.companyName,
        transactions,
        pendingPayments,
        orders: orders.map(presentOpsOrder),
      },
    });
  } catch (error) {
    console.error('Ops merchant detail error:', error);
    return res.status(500).json({ status: 'error', message: 'Server error' });
  }
};

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
    const user = await prisma.user.findUnique({
      where: { id: req.params.userId },
      select: { id: true, isOrganization: true },
    });
    if (!user || !user.isOrganization) {
      return res.status(404).json({ status: 'fail', message: 'Merchant not found' });
    }
    const transaction = await prisma.organizationTransaction.create({
      data: {
        userId: user.id,
        amount,
        type: 'DEPOSIT',
        status: 'COMPLETED',
        description: note,
        metadata: {
          source: 'ops_credit',
          operator: req.opsAdmin?.username || 'ops',
        },
      },
    });
    return res.json({
      status: 'success',
      data: { transaction, balance: await orgBalance(user.id) },
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
    const where = {
      ...(req.query.status ? { status: String(req.query.status) } : {}),
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
        select: ORDER_ATTEST_SELECT,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.purchaseOrder.count({ where }),
    ]);
    return res.json({
      status: 'success',
      data: {
        items: items.map(presentOpsOrder),
        pagination: { total, page, limit, pages: Math.ceil(total / limit) || 1 },
      },
    });
  } catch (error) {
    console.error('Ops orders error:', error);
    return res.status(500).json({ status: 'error', message: 'Server error' });
  }
};

exports.attestOrder = async (req, res) => {
  try {
    const commerceAttest = require('../services/commerceAttest');
    const data = await commerceAttest.attestPaidOrder(req.params.id, {
      txHash: req.body?.txHash,
    });
    return res.json({ status: 'success', data });
  } catch (error) {
    const code = error.statusCode || 500;
    return res.status(code).json({ status: code >= 500 ? 'error' : 'fail', message: error.message });
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
