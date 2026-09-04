const prisma = require('../utils/prisma');
const { BUYER_LICENCE_VERSION, BUYER_LICENCE_TERMS, hasAcceptedBuyerLicence } = require('../constants/buyerLicence');

const { maskEmail, stripEmail } = require('../utils/emailMask');

const ORDER_INCLUDE = {
  lineItems: true,
  buyer: { select: { id: true, name: true, email: true } },
  seller: { select: { id: true, name: true, email: true } },
  invoices: {
    include: { lineItems: true, payments: true },
    orderBy: { createdAt: 'desc' },
  },
  payments: { orderBy: { createdAt: 'desc' } },
  allocations: { orderBy: { createdAt: 'asc' } },
  costItems: { orderBy: { createdAt: 'asc' } },
  redemptions: { orderBy: { createdAt: 'desc' } },
};

const INVOICE_INCLUDE = {
  lineItems: true,
  order: { select: { id: true, orderNumber: true, status: true, contractFile: true, contractStatus: true } },
  buyer: { select: { id: true, name: true, email: true } },
  seller: { select: { id: true, name: true, email: true } },
  payments: { orderBy: { createdAt: 'desc' } },
};

const PAYMENT_INCLUDE = {
  order: { select: { id: true, orderNumber: true, status: true } },
  invoice: { select: { id: true, invoiceNumber: true, status: true, total: true, currency: true } },
  payer: { select: { id: true, name: true, email: true } },
  payee: { select: { id: true, name: true, email: true } },
};

function nextNumber(prefix) {
  const ymd = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `${prefix}-${ymd}-${rand}`;
}

function dueDateFromTerms(paymentTerms, issueDate = new Date()) {
  const terms = String(paymentTerms || 'Due on receipt').toLowerCase();
  const date = new Date(issueDate);
  if (terms.includes('15')) {
    date.setDate(date.getDate() + 15);
    return date;
  }
  if (terms.includes('30')) {
    date.setDate(date.getDate() + 30);
    return date;
  }
  if (terms.includes('60')) {
    date.setDate(date.getDate() + 60);
    return date;
  }
  return date;
}

function canAccessRecord(user, record) {
  if (!user || !record) return false;
  const userId = user.id;
  return (
    record.buyerId === userId ||
    record.sellerId === userId ||
    record.payerId === userId ||
    record.payeeId === userId
  );
}

function normalizeLineItems(lineItems = []) {
  return lineItems
    .map((item) => {
      const quantity = Math.max(0, Number(item.quantity) || 0);
      const unitPrice = Number(item.unitPrice) || 0;
      return {
        description: String(item.description || '').trim(),
        category: item.category ? String(item.category).trim() : null,
        quantity,
        unit: item.unit ? String(item.unit).trim() : 'license',
        unitPrice,
        total: Number((quantity * unitPrice).toFixed(2)),
      };
    })
    .filter((item) => item.description && item.quantity > 0);
}

function totalsFromLineItems(lineItems, taxRate = 0) {
  const subtotal = Number(lineItems.reduce((sum, item) => sum + item.total, 0).toFixed(2));
  const rate = Math.max(0, Number(taxRate) || 0);
  const taxAmount = Number((subtotal * rate).toFixed(2));
  return {
    subtotal,
    taxAmount,
    total: Number((subtotal + taxAmount).toFixed(2)),
  };
}

async function snapshotParty(db, userId) {
  const user = await db.user.findUnique({
    where: { id: userId },
    include: { legalEntity: true },
  });
  if (!user) {
    throw Object.assign(new Error('Party not found'), { statusCode: 404 });
  }
  const entity = user.legalEntity;
  return {
    userId: user.id,
    companyName: entity?.companyName || user.name || user.email,
    taxId: entity?.taxId || entity?.brNumber || '',
    brNumber: entity?.brNumber || entity?.taxId || '',
    address: entity?.address || '',
    country: entity?.country || '',
    email: entity?.email || user.email || '',
    bankName: entity?.bankName || '',
    bankAccount: entity?.bankAccount || '',
    currency: 'USD',
  };
}

async function getOrCreateLegalEntity(db, user) {
  const existing = await db.legalEntity.findUnique({ where: { userId: user.id } });
  if (existing) return existing;
  return db.legalEntity.create({
    data: {
      userId: user.id,
      companyName: user.name && user.name !== user.email ? user.name : '',
      email: user.email,
      currency: 'USD',
      kycStatus: 'incomplete',
    },
  });
}

async function findDefaultSellerId(db, fallbackUserId) {
  if (process.env.INVOICE_SELLER_USER_ID) {
    const configured = await db.user.findUnique({
      where: { id: process.env.INVOICE_SELLER_USER_ID },
      select: { id: true },
    });
    if (configured) return configured.id;
  }
  if (process.env.INVOICE_SELLER_EMAIL) {
    const byEmail = await db.user.findUnique({
      where: { email: process.env.INVOICE_SELLER_EMAIL },
      select: { id: true },
    });
    if (byEmail) return byEmail.id;
  }
  const official = await db.user.findFirst({
    where: {
      isOrganization: true,
      OR: [
        { email: { contains: 'official' } },
        { name: { contains: 'DataDance' } },
        { email: { contains: 'datadance' } },
      ],
    },
    select: { id: true },
  });
  return official?.id || fallbackUserId;
}

function computeMatchStatus(invoiceTotal, confirmedPaid, incomingAmount) {
  const remaining = Number((invoiceTotal - confirmedPaid).toFixed(2));
  if (incomingAmount <= 0) return 'unmatched';
  if (Math.abs(incomingAmount - remaining) < 0.01) return 'matched';
  if (incomingAmount < remaining) return 'partial';
  return 'amount_mismatch';
}

async function confirmedPaidForInvoice(db, invoiceId, excludePaymentId) {
  const payments = await db.payment.findMany({
    where: {
      invoiceId,
      status: 'confirmed',
      ...(excludePaymentId ? { id: { not: excludePaymentId } } : {}),
    },
  });
  return payments.reduce((sum, payment) => sum + Number(payment.amount), 0);
}

async function refreshInvoiceSettlement(db, invoiceId) {
  const invoice = await db.invoice.findUnique({
    where: { id: invoiceId },
    include: { payments: true, order: true },
  });
  if (!invoice) return null;
  const confirmedPaid = invoice.payments
    .filter((payment) => payment.status === 'confirmed')
    .reduce((sum, payment) => sum + Number(payment.amount), 0);
  let status = invoice.status;
  let paidAt = invoice.paidAt;
  let orderStatus = invoice.order?.status;
  if (invoice.status !== 'void') {
    if (confirmedPaid <= 0) {
      status = 'issued';
      paidAt = null;
      orderStatus = orderStatus === 'cancelled' ? orderStatus : 'invoiced';
    } else if (confirmedPaid + 0.009 >= invoice.total) {
      status = 'paid';
      paidAt = paidAt || new Date();
      orderStatus = 'paid';
    } else {
      status = 'partial';
      paidAt = null;
      orderStatus = 'invoiced';
    }
  }
  const updated = await db.invoice.update({
    where: { id: invoiceId },
    data: { status, paidAt },
  });
  if (invoice.orderId && orderStatus && invoice.order?.status !== 'cancelled') {
    await db.purchaseOrder.update({
      where: { id: invoice.orderId },
      data: { status: orderStatus },
    });
  }
  return updated;
}

function maskParty(party) {
  if (!party) return party;
  return {
    ...party,
    email: party.email ? maskEmail(party.email) : party.email,
  };
}

function serializeOrder(order) {
  if (!order) return null;
  const latestInvoice = order.invoices?.[0] || null;
  const confirmedPaid = (order.payments || [])
    .filter((payment) => payment.status === 'confirmed')
    .reduce((sum, payment) => sum + Number(payment.amount), 0);
  const allocations = (order.allocations || []).map(stripEmail);
  const users = allocations.filter((row) => row.kind === 'user');
  const referrals = allocations.filter((row) => row.kind === 'referral');
  const costItems = order.costItems || [];
  return {
    ...order,
    buyer: maskParty(order.buyer),
    seller: maskParty(order.seller),
    allocations,
    users,
    referrals,
    redemptions: (order.redemptions || []).map(stripEmail),
    paidAmount: Number(confirmedPaid.toFixed(2)),
    outstandingAmount: Number((order.total - confirmedPaid).toFixed(2)),
    latestInvoice,
    userCount: users.length,
    referralCount: referrals.length,
    pointsReserved: users.reduce((sum, row) => sum + Number(row.points || 0), 0),
    referralPointsReserved: referrals.reduce((sum, row) => sum + Number(row.points || 0), 0),
    costIssuedUsd: Number(costItems.filter((row) => row.kind === 'points_issue').reduce((sum, row) => sum + Number(row.amountUsd || 0), 0).toFixed(2)),
    costRedeemedUsd: Number(costItems.filter((row) => row.kind === 'points_redeem').reduce((sum, row) => sum + Number(row.amountUsd || 0), 0).toFixed(2)),
    attested: Boolean(order.attestationHash),
    licenceAccepted: hasAcceptedBuyerLicence(order),
    buyerLicenceVersion: BUYER_LICENCE_VERSION,
    buyerLicenceTerms: BUYER_LICENCE_TERMS,
  };
}

async function createInvoiceForOrder(db, order, { buyerSnapshot, sellerSnapshot }) {
  const issueDate = new Date();
  const invoice = await db.invoice.create({
    data: {
      invoiceNumber: nextNumber('INV'),
      orderId: order.id,
      buyerId: order.buyerId,
      sellerId: order.sellerId,
      status: 'issued',
      currency: order.currency,
      subtotal: order.subtotal,
      taxAmount: order.taxAmount,
      total: order.total,
      paymentTerms: order.paymentTerms,
      issueDate,
      dueDate: dueDateFromTerms(order.paymentTerms, issueDate),
      sellerSnapshot,
      buyerSnapshot,
      lineItems: {
        create: order.lineItems.map((item) => ({
          description: item.description,
          category: item.category,
          quantity: item.quantity,
          unit: item.unit,
          unitPrice: item.unitPrice,
          total: item.total,
        })),
      },
    },
    include: INVOICE_INCLUDE,
  });
  await db.purchaseOrder.update({
    where: { id: order.id },
    data: { status: 'invoiced' },
  });
  return invoice;
}

async function createOrderBundle(db, {
  buyerId,
  sellerId,
  currency = 'USD',
  paymentTerms = 'Due on receipt',
  taxRate = 0,
  notes,
  dataNFTId,
  purchaseId,
  lineItems,
  paidFromBalance = false,
  organizationTransactionId,
  pointsUnitPriceUsd,
  serviceFeeAmount = 0,
}) {
  const items = normalizeLineItems(lineItems);
  if (!items.length) {
    throw Object.assign(new Error('At least one valid line item is required'), { statusCode: 400 });
  }
  if (!sellerId) {
    throw Object.assign(new Error('Seller is required'), { statusCode: 400 });
  }
  if (sellerId === buyerId) {
    throw Object.assign(new Error('Buyer and seller must be different parties'), { statusCode: 400 });
  }

  const [buyer, seller] = await Promise.all([
    db.user.findUnique({ where: { id: buyerId } }),
    db.user.findUnique({ where: { id: sellerId } }),
  ]);
  if (!buyer || !seller) {
    throw Object.assign(new Error('Buyer or seller not found'), { statusCode: 404 });
  }

  await Promise.all([
    getOrCreateLegalEntity(db, buyer),
    getOrCreateLegalEntity(db, seller),
  ]);

  const [buyerSnapshot, sellerSnapshot] = await Promise.all([
    snapshotParty(db, buyerId),
    snapshotParty(db, sellerId),
  ]);
  const totals = totalsFromLineItems(items, taxRate);
  const bookCurrency = 'USD';

  const order = await db.purchaseOrder.create({
    data: {
      orderNumber: nextNumber('PO'),
      buyerId,
      sellerId,
      status: paidFromBalance ? 'paid' : 'confirmed',
      currency: bookCurrency,
      subtotal: totals.subtotal,
      taxAmount: totals.taxAmount,
      total: totals.total,
      paymentTerms,
      notes: notes || null,
      dataNFTId: dataNFTId || null,
      purchaseId: purchaseId || null,
      pointsUnitPriceUsd: pointsUnitPriceUsd != null ? Number(pointsUnitPriceUsd) : null,
      serviceFeeAmount: Number(serviceFeeAmount || 0),
      lineItems: { create: items },
    },
    include: { lineItems: true },
  });

  const invoice = await createInvoiceForOrder(db, order, { buyerSnapshot, sellerSnapshot });

  let payment = null;
  if (paidFromBalance) {
    payment = await db.payment.create({
      data: {
        paymentNumber: nextNumber('PAY'),
        orderId: order.id,
        invoiceId: invoice.id,
        payerId: buyerId,
        payeeId: sellerId,
        amount: totals.total,
        currency: bookCurrency,
        method: 'account_balance',
        status: 'confirmed',
        matchStatus: 'matched',
        paidAt: new Date(),
        notes: 'Paid from organization wallet balance',
        organizationTransactionId: organizationTransactionId || null,
      },
      include: PAYMENT_INCLUDE,
    });
    await refreshInvoiceSettlement(db, invoice.id);
  }

  const fullOrder = await db.purchaseOrder.findUnique({
    where: { id: order.id },
    include: ORDER_INCLUDE,
  });
  const fullInvoice = await db.invoice.findUnique({
    where: { id: invoice.id },
    include: INVOICE_INCLUDE,
  });

  return {
    order: serializeOrder(fullOrder),
    invoice: fullInvoice,
    payment,
  };
}

async function createOrderFromPurchase(db, {
  buyerId,
  sellerId,
  dataNFT,
  purchase,
  quantity,
  totalAmount,
  paidFromBalance,
  organizationTransactionId,
}) {
  const recordHint = Array.isArray(dataNFT.dataRecords) ? dataNFT.dataRecords.length : null;
  const description = recordHint
    ? `Dataset license: ${dataNFT.name} (${recordHint} records)`
    : `Dataset license: ${dataNFT.name}`;

  return createOrderBundle(db, {
    buyerId,
    sellerId,
    currency: 'USD',
    paymentTerms: 'Due on receipt',
    notes: `Created from DataNFT purchase ${purchase.id}`,
    dataNFTId: dataNFT.id,
    purchaseId: purchase.id,
    paidFromBalance,
    organizationTransactionId,
    lineItems: [
      {
        description,
        category: 'dataset_license',
        quantity,
        unit: 'license',
        unitPrice: dataNFT.price,
        total: totalAmount,
      },
    ],
  });
}

async function listOrders(userId, { page = 1, limit = 10, status, role = 'all' } = {}) {
  const where = {
    ...(status ? { status } : {}),
    ...(role === 'buyer'
      ? { buyerId: userId }
      : role === 'seller'
        ? { sellerId: userId }
        : { OR: [{ buyerId: userId }, { sellerId: userId }] }),
  };
  const skip = (Number(page) - 1) * Number(limit);
  const [orders, total] = await Promise.all([
    prisma.purchaseOrder.findMany({
      where,
      include: ORDER_INCLUDE,
      orderBy: { createdAt: 'desc' },
      skip,
      take: Number(limit),
    }),
    prisma.purchaseOrder.count({ where }),
  ]);
  return {
    items: orders.map(serializeOrder),
    pagination: {
      total,
      page: Number(page),
      limit: Number(limit),
      pages: Math.ceil(total / Number(limit)) || 1,
    },
  };
}

async function getOrderById(id, user) {
  const order = await prisma.purchaseOrder.findUnique({
    where: { id },
    include: ORDER_INCLUDE,
  });
  if (!order) {
    throw Object.assign(new Error('Order not found'), { statusCode: 404 });
  }
  if (!canAccessRecord(user, order)) {
    throw Object.assign(new Error('Not authorized to view this order'), { statusCode: 403 });
  }
  return serializeOrder(order);
}

async function listInvoices(userId, { page = 1, limit = 10, status } = {}) {
  const where = {
    OR: [{ buyerId: userId }, { sellerId: userId }],
    ...(status ? { status } : {}),
  };
  const skip = (Number(page) - 1) * Number(limit);
  const [items, total] = await Promise.all([
    prisma.invoice.findMany({
      where,
      include: INVOICE_INCLUDE,
      orderBy: { createdAt: 'desc' },
      skip,
      take: Number(limit),
    }),
    prisma.invoice.count({ where }),
  ]);
  return {
    items: items.map((invoice) => ({
      ...invoice,
      buyer: maskParty(invoice.buyer),
      seller: maskParty(invoice.seller),
      buyerSnapshot: maskParty(invoice.buyerSnapshot),
      sellerSnapshot: maskParty(invoice.sellerSnapshot),
    })),
    pagination: {
      total,
      page: Number(page),
      limit: Number(limit),
      pages: Math.ceil(total / Number(limit)) || 1,
    },
  };
}

async function getInvoiceById(id, user) {
  const invoice = await prisma.invoice.findUnique({
    where: { id },
    include: INVOICE_INCLUDE,
  });
  if (!invoice) {
    throw Object.assign(new Error('Invoice not found'), { statusCode: 404 });
  }
  if (!canAccessRecord(user, invoice)) {
    throw Object.assign(new Error('Not authorized to view this invoice'), { statusCode: 403 });
  }
  const confirmedPaid = (invoice.payments || [])
    .filter((payment) => payment.status === 'confirmed')
    .reduce((sum, payment) => sum + Number(payment.amount), 0);
  return {
    ...invoice,
    buyer: maskParty(invoice.buyer),
    seller: maskParty(invoice.seller),
    buyerSnapshot: maskParty(invoice.buyerSnapshot),
    sellerSnapshot: maskParty(invoice.sellerSnapshot),
    paidAmount: Number(confirmedPaid.toFixed(2)),
    outstandingAmount: Number((invoice.total - confirmedPaid).toFixed(2)),
  };
}

async function listPayments(userId, { page = 1, limit = 10, status } = {}) {
  const where = {
    OR: [{ payerId: userId }, { payeeId: userId }],
    ...(status ? { status } : {}),
  };
  const skip = (Number(page) - 1) * Number(limit);
  const [items, total] = await Promise.all([
    prisma.payment.findMany({
      where,
      include: PAYMENT_INCLUDE,
      orderBy: { createdAt: 'desc' },
      skip,
      take: Number(limit),
    }),
    prisma.payment.count({ where }),
  ]);
  return {
    items: items.map((payment) => ({
      ...payment,
      payer: maskParty(payment.payer),
      payee: maskParty(payment.payee),
    })),
    pagination: {
      total,
      page: Number(page),
      limit: Number(limit),
      pages: Math.ceil(total / Number(limit)) || 1,
    },
  };
}

async function getPaymentById(id, user) {
  const payment = await prisma.payment.findUnique({
    where: { id },
    include: PAYMENT_INCLUDE,
  });
  if (!payment) {
    throw Object.assign(new Error('Payment not found'), { statusCode: 404 });
  }
  if (!canAccessRecord(user, payment)) {
    throw Object.assign(new Error('Not authorized to view this payment'), { statusCode: 403 });
  }
  return {
    ...payment,
    payer: maskParty(payment.payer),
    payee: maskParty(payment.payee),
  };
}

async function recordPayment(user, {
  invoiceId,
  orderId,
  amount,
  currency,
  method = 'bank_transfer',
  reference,
  notes,
  slipPath,
  paidAt,
}) {
  const parsedAmount = Number(amount);
  if (!parsedAmount || parsedAmount <= 0) {
    throw Object.assign(new Error('A positive payment amount is required'), { statusCode: 400 });
  }

  let invoice = null;
  let order = null;
  if (invoiceId) {
    invoice = await prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: { order: true },
    });
    if (!invoice) {
      throw Object.assign(new Error('Invoice not found'), { statusCode: 404 });
    }
    if (!canAccessRecord(user, invoice)) {
      throw Object.assign(new Error('Not authorized to record payment for this invoice'), { statusCode: 403 });
    }
    order = invoice.order;
  } else if (orderId) {
    order = await prisma.purchaseOrder.findUnique({ where: { id: orderId } });
    if (!order) {
      throw Object.assign(new Error('Order not found'), { statusCode: 404 });
    }
    if (!canAccessRecord(user, order)) {
      throw Object.assign(new Error('Not authorized to record payment for this order'), { statusCode: 403 });
    }
  }

  const isTopUp = method === 'top_up';
  const payerId = user.id;
  let payeeId = invoice?.sellerId || order?.sellerId;
  if (isTopUp) {
    payeeId = await findDefaultSellerId(prisma, payerId);
  }
  if (!payeeId) {
    throw Object.assign(new Error('Payee could not be determined'), { statusCode: 400 });
  }

  let organizationTransactionId = null;
  if (isTopUp) {
    const deposit = await prisma.organizationTransaction.create({
      data: {
        amount: parsedAmount,
        type: 'DEPOSIT',
        status: 'PENDING',
        description: notes || 'Wallet top-up',
        userId: payerId,
        metadata: { reference: reference || null, source: 'commerce_top_up' },
      },
    });
    organizationTransactionId = deposit.id;
  }

  const confirmedPaid = invoice
    ? await confirmedPaidForInvoice(prisma, invoice.id)
    : 0;
  const matchStatus = invoice
    ? computeMatchStatus(invoice.total, confirmedPaid, parsedAmount)
    : (isTopUp ? 'unmatched' : 'unmatched');

  const payment = await prisma.payment.create({
    data: {
      paymentNumber: nextNumber('PAY'),
      orderId: order?.id || null,
      invoiceId: invoice?.id || null,
      payerId,
      payeeId,
      amount: parsedAmount,
      currency: 'USD',
      method,
      status: 'pending',
      matchStatus,
      paidAt: paidAt ? new Date(paidAt) : null,
      reference: reference || null,
      slipPath: slipPath || null,
      notes: notes || null,
      organizationTransactionId,
    },
    include: PAYMENT_INCLUDE,
  });

  return payment;
}

async function confirmPayment(user, paymentId) {
  const payment = await prisma.payment.findUnique({
    where: { id: paymentId },
    include: { invoice: true },
  });
  if (!payment) {
    throw Object.assign(new Error('Payment not found'), { statusCode: 404 });
  }
  if (payment.status === 'confirmed') {
    return getPaymentById(paymentId, user);
  }

  const isTopUp = payment.method === 'top_up';
  if (isTopUp) {
    throw Object.assign(new Error('Top-ups are confirmed by DataDance ops'), { statusCode: 403 });
  }
  const canConfirm = payment.payeeId === user.id;
  if (!canConfirm) {
    throw Object.assign(new Error('Only the receiving party can confirm this payment'), { statusCode: 403 });
  }

  if (payment.invoiceId) {
    const confirmedPaid = await confirmedPaidForInvoice(prisma, payment.invoiceId, payment.id);
    payment.matchStatus = computeMatchStatus(payment.invoice.total, confirmedPaid, payment.amount);
  } else if (isTopUp) {
    payment.matchStatus = 'matched';
  }

  const updated = await prisma.payment.update({
    where: { id: paymentId },
    data: {
      status: 'confirmed',
      matchStatus: payment.matchStatus,
      paidAt: payment.paidAt || new Date(),
    },
  });

  if (payment.organizationTransactionId) {
    await prisma.organizationTransaction.update({
      where: { id: payment.organizationTransactionId },
      data: { status: 'COMPLETED' },
    });
  }

  if (payment.invoiceId) {
    await refreshInvoiceSettlement(prisma, payment.invoiceId);
  }

  return getPaymentById(updated.id, user);
}

async function loadOpsPayment(paymentId) {
  const payment = await prisma.payment.findUnique({
    where: { id: paymentId },
    include: PAYMENT_INCLUDE,
  });
  if (!payment) {
    throw Object.assign(new Error('Payment not found'), { statusCode: 404 });
  }
  return payment;
}

function mergeLedgerMeta(existing, extra) {
  const base = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {};
  return { ...base, ...extra };
}

async function confirmPaymentByOps(paymentId, operator = 'ops') {
  const payment = await prisma.payment.findUnique({
    where: { id: paymentId },
    include: { invoice: true },
  });
  if (!payment) {
    throw Object.assign(new Error('Payment not found'), { statusCode: 404 });
  }
  if (payment.status === 'confirmed') {
    return loadOpsPayment(paymentId);
  }

  if (payment.invoiceId) {
    const confirmedPaid = await confirmedPaidForInvoice(prisma, payment.invoiceId, payment.id);
    payment.matchStatus = computeMatchStatus(payment.invoice.total, confirmedPaid, payment.amount);
  } else if (payment.method === 'top_up') {
    payment.matchStatus = 'matched';
  }

  const confirmedAt = new Date();
  await prisma.payment.update({
    where: { id: paymentId },
    data: {
      status: 'confirmed',
      matchStatus: payment.matchStatus,
      paidAt: payment.paidAt || confirmedAt,
    },
  });

  if (payment.organizationTransactionId) {
    const row = await prisma.organizationTransaction.findUnique({
      where: { id: payment.organizationTransactionId },
    });
    await prisma.organizationTransaction.update({
      where: { id: payment.organizationTransactionId },
      data: {
        status: 'COMPLETED',
        metadata: mergeLedgerMeta(row?.metadata, {
          confirmedBy: operator,
          confirmedAt: confirmedAt.toISOString(),
        }),
      },
    });
  }
  if (payment.invoiceId) {
    await refreshInvoiceSettlement(prisma, payment.invoiceId);
  }
  return loadOpsPayment(paymentId);
}

async function rejectPaymentByOps(paymentId, notes, operator = 'ops') {
  const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
  if (!payment) {
    throw Object.assign(new Error('Payment not found'), { statusCode: 404 });
  }
  await prisma.payment.update({
    where: { id: paymentId },
    data: {
      status: 'rejected',
      matchStatus: 'unmatched',
      notes: notes || payment.notes,
    },
  });
  if (payment.organizationTransactionId) {
    const row = await prisma.organizationTransaction.findUnique({
      where: { id: payment.organizationTransactionId },
    });
    await prisma.organizationTransaction.update({
      where: { id: payment.organizationTransactionId },
      data: {
        status: 'FAILED',
        metadata: mergeLedgerMeta(row?.metadata, {
          rejectedBy: operator,
          rejectedAt: new Date().toISOString(),
        }),
      },
    });
  }
  if (payment.invoiceId) {
    await refreshInvoiceSettlement(prisma, payment.invoiceId);
  }
  return loadOpsPayment(paymentId);
}

async function rejectPayment(user, paymentId, notes) {
  const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
  if (!payment) {
    throw Object.assign(new Error('Payment not found'), { statusCode: 404 });
  }
  if (payment.payeeId !== user.id) {
    throw Object.assign(new Error('Only the receiving party can reject this payment'), { statusCode: 403 });
  }
  await prisma.payment.update({
    where: { id: paymentId },
    data: {
      status: 'rejected',
      matchStatus: 'unmatched',
      notes: notes || payment.notes,
    },
  });
  if (payment.organizationTransactionId) {
    await prisma.organizationTransaction.update({
      where: { id: payment.organizationTransactionId },
      data: { status: 'FAILED' },
    });
  }
  if (payment.invoiceId) {
    await refreshInvoiceSettlement(prisma, payment.invoiceId);
  }
  return getPaymentById(paymentId, user);
}

async function attachContract(user, orderId, contractFile) {
  const order = await getOrderById(orderId, user);
  const updated = await prisma.purchaseOrder.update({
    where: { id: order.id },
    data: {
      contractFile,
      contractStatus: 'uploaded',
    },
    include: ORDER_INCLUDE,
  });
  return serializeOrder(updated);
}

async function listCounterparties(userId) {
  const users = await prisma.user.findMany({
    where: {
      id: { not: userId },
      OR: [{ isOrganization: true }, { userType: 'organization' }],
    },
    select: {
      id: true,
      name: true,
      email: true,
      legalEntity: { select: { companyName: true, taxId: true } },
    },
    orderBy: { name: 'asc' },
    take: 100,
  });
  return users.map((user) => ({
    id: user.id,
    name: user.legalEntity?.companyName || user.name || user.email,
    email: user.email,
    taxId: user.legalEntity?.taxId || '',
  }));
}

module.exports = {
  ORDER_INCLUDE,
  INVOICE_INCLUDE,
  PAYMENT_INCLUDE,
  nextNumber,
  canAccessRecord,
  findDefaultSellerId,
  createOrderBundle,
  createOrderFromPurchase,
  listOrders,
  getOrderById,
  listInvoices,
  getInvoiceById,
  listPayments,
  getPaymentById,
  recordPayment,
  confirmPayment,
  confirmPaymentByOps,
  rejectPayment,
  rejectPaymentByOps,
  attachContract,
  listCounterparties,
  getOrCreateLegalEntity,
  snapshotParty,
};
