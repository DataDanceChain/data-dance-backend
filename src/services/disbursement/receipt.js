const crypto = require('crypto');
const {
  RECEIPT_SCHEMA,
  ORIGIN_PARTNER_VOLUME,
  recordClassForOrigin,
  assertSeparateFromDataUploads,
} = require('./classify');

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function isoTime(value) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function buildDisbursementReceipt({
  payoutId,
  origin,
  partnerSlug = null,
  email,
  walletAddress,
  amount,
  asset = 'USDT',
  chainId,
  tokenAddress,
  bscTxHash,
  paidAt,
  reason = null,
}) {
  const recordClass = recordClassForOrigin(origin);
  const receipt = {
    schema: RECEIPT_SCHEMA,
    version: 1,
    payoutId,
    origin,
    recordClass,
    purpose: origin === ORIGIN_PARTNER_VOLUME ? 'partner_volume' : 'internal_reward',
    countsAsDataUpload: false,
    countsAsDataTrade: false,
    partnerSlug: partnerSlug || null,
    emailHash: sha256Hex(String(email || '').trim().toLowerCase()),
    walletAddress,
    amount: Number(amount) || 0,
    asset: asset || 'USDT',
    chainId: Number(chainId),
    tokenAddress,
    bscTxHash,
    reason: reason || null,
    paidAt: isoTime(paidAt),
    datasetBytesExcluded: true,
  };
  assertSeparateFromDataUploads(receipt);
  return receipt;
}

function hashDisbursementReceipt(receipt) {
  return sha256Hex(JSON.stringify(receipt));
}

module.exports = {
  sha256Hex,
  buildDisbursementReceipt,
  hashDisbursementReceipt,
};
