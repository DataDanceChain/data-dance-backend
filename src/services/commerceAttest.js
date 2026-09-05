const crypto = require('crypto');
const prisma = require('../utils/prisma');
const { BUYER_LICENCE_VERSION } = require('../constants/buyerLicence');
const { attestHashOnChain } = require('../utils/commerceAttestChain');

const LICENCE_SCHEMA = 'datadance.commerce.licence.v1';
const LICENCE_VERSION = 1;
const LICENCE_PURPOSE = 'analysis-research';

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function soldRecordCount(dataNFT) {
  const raw = dataNFT?.dataRecords;
  if (Array.isArray(raw)) return raw.length;
  if (raw && typeof raw === 'object') {
    if (Array.isArray(raw.records)) return raw.records.length;
    const counted = Number(raw.recordCount);
    if (Number.isFinite(counted) && counted >= 0) return counted;
  }
  return 0;
}

function isoTime(value) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function buildLicenceReceipt({
  purchaseId,
  orderNumber,
  dataNFTId,
  sellerOrgId,
  buyerOrgId,
  amount,
  currency = 'USD',
  recordCount,
  licencePolicyVersion = BUYER_LICENCE_VERSION,
  paidAt,
  packTitle,
}) {
  const receipt = {
    schema: LICENCE_SCHEMA,
    version: LICENCE_VERSION,
    purchaseId: purchaseId || null,
    orderNumber: orderNumber || null,
    dataNFTId: dataNFTId || null,
    sellerOrgId: sellerOrgId || null,
    buyerOrgId: buyerOrgId || null,
    amount: Number(amount) || 0,
    currency: currency || 'USD',
    recordCount: Number(recordCount) || 0,
    licencePolicyVersion,
    purpose: LICENCE_PURPOSE,
    directMarketing: false,
    paidAt: isoTime(paidAt),
    datasetBytesExcluded: true,
  };
  const title = packTitle != null ? String(packTitle).trim() : '';
  if (title) receipt.packTitle = title;
  return receipt;
}

function hashLicenceReceipt(receipt) {
  return sha256Hex(JSON.stringify(receipt));
}

function isLicenceReceipt(payload) {
  return payload && typeof payload === 'object' && payload.schema === LICENCE_SCHEMA;
}

function attestationStatus(row) {
  if (row?.attestationTxHash) return 'on_chain';
  if (row?.attestationHash) return 'recorded';
  return 'pending';
}

function attestationLabelFor(status) {
  if (status === 'on_chain') return 'On-chain';
  if (status === 'recorded') return 'Recorded (hash)';
  return 'On-chain pending';
}

function omitAttestationPayload(row) {
  if (!row || typeof row !== 'object') return row;
  const { attestationPayload, ...rest } = row;
  return rest;
}

function publicAttestation(row) {
  const status = attestationStatus(row);
  return {
    attestationHash: row?.attestationHash || null,
    attestationTxHash: row?.attestationTxHash || null,
    attestedAt: row?.attestedAt || null,
    attested: Boolean(row?.attestationHash),
    attestationStatus: status,
    attestationLabel: attestationLabelFor(status),
    chainId: 44508,
    attesterName: 'CommerceAttester',
    chainLabel: row?.attestationTxHash || 'On-chain pending',
  };
}

function looksLikeTxHash(value) {
  return /^0x[0-9a-fA-F]{64}$/.test(String(value || '').trim());
}

async function loadOrderForAttest(orderId) {
  return prisma.purchaseOrder.findUnique({
    where: { id: orderId },
    include: {
      lineItems: true,
      payments: { orderBy: { paidAt: 'desc' } },
    },
  });
}

async function buildReceiptForOrder(order) {
  const dataNFT = order.dataNFTId
    ? await prisma.dataNFT.findUnique({
      where: { id: order.dataNFTId },
      select: { id: true, name: true, dataRecords: true },
    })
    : null;
  const paidPayment = (order.payments || []).find((row) => row.status === 'confirmed' && row.paidAt);
  return buildLicenceReceipt({
    purchaseId: order.purchaseId,
    orderNumber: order.orderNumber,
    dataNFTId: order.dataNFTId,
    sellerOrgId: order.sellerId,
    buyerOrgId: order.buyerId,
    amount: order.total,
    currency: order.currency || 'USD',
    recordCount: soldRecordCount(dataNFT),
    licencePolicyVersion: BUYER_LICENCE_VERSION,
    paidAt: paidPayment?.paidAt || order.updatedAt || order.createdAt,
    packTitle: dataNFT?.name,
  });
}

async function persistAttestation(orderId, {
  payload,
  attestationHash,
  attestationTxHash,
}) {
  const updated = await prisma.purchaseOrder.update({
    where: { id: orderId },
    data: {
      attestationPayload: payload,
      attestationHash,
      attestationTxHash: attestationTxHash || null,
      attestedAt: new Date(),
    },
  });
  return publicAttestation(updated);
}

async function attestPaidOrder(orderId, { txHash } = {}) {
  const order = await loadOrderForAttest(orderId);
  if (!order) {
    throw Object.assign(new Error('Order not found'), { statusCode: 404 });
  }

  const existingPayload = isLicenceReceipt(order.attestationPayload)
    ? order.attestationPayload
    : null;
  const payload = existingPayload || await buildReceiptForOrder(order);
  const attestationHash = hashLicenceReceipt(payload);
  const pasted = looksLikeTxHash(txHash) ? String(txHash).trim() : null;
  let attestationTxHash = pasted || (looksLikeTxHash(order.attestationTxHash) ? order.attestationTxHash : null);
  let chain = null;

  if (!attestationTxHash) {
    chain = await attestHashOnChain(attestationHash);
    if (chain.ok && looksLikeTxHash(chain.txHash)) {
      attestationTxHash = chain.txHash;
    }
  }

  const saved = await persistAttestation(order.id, {
    payload,
    attestationHash,
    attestationTxHash,
  });
  return {
    ...saved,
    orderId: order.id,
    orderNumber: order.orderNumber,
    chainPending: !saved.attestationTxHash,
    chainReason: chain && !chain.ok ? chain.reason : null,
  };
}

async function attestPaidOrderSafe(orderId, options) {
  try {
    return await attestPaidOrder(orderId, options);
  } catch (error) {
    console.error('commerce licence attest failed', {
      orderId,
      message: error.message,
    });
    return null;
  }
}

module.exports = {
  LICENCE_SCHEMA,
  LICENCE_VERSION,
  LICENCE_PURPOSE,
  sha256Hex,
  soldRecordCount,
  buildLicenceReceipt,
  hashLicenceReceipt,
  isLicenceReceipt,
  attestationStatus,
  attestationLabelFor,
  omitAttestationPayload,
  publicAttestation,
  attestPaidOrder,
  attestPaidOrderSafe,
};
