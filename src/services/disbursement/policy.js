const crypto = require('crypto');
const { ethers } = require('ethers');
const {
  ORIGIN_PARTNER_VOLUME,
  ORIGIN_INTERNAL_REWARD,
  recordClassForOrigin,
  assertSeparateFromDataUploads,
} = require('./classify');

const BSC_CHAIN_ID = 56;
const BSC_USDT = '0x55d398326f99059fF775485246999027B3197955';
const DEFAULT_PER_ITEM_MAX = 2000;
const DEFAULT_MONTHLY_MAX = 20000;
const MAX_BATCH_ITEMS = 100;

function envNumber(name, fallback) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function limits() {
  return {
    perItemMax: envNumber('DISBURSEMENT_PER_ITEM_MAX', DEFAULT_PER_ITEM_MAX),
    monthlyMax: envNumber('DISBURSEMENT_MONTHLY_MAX', DEFAULT_MONTHLY_MAX),
    maxBatchItems: MAX_BATCH_ITEMS,
  };
}

function isPaused() {
  return String(process.env.DISBURSEMENT_PAUSED || '').trim().toLowerCase() === 'true';
}

function roundAmount(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return Math.round(amount * 1e6) / 1e6;
}

function normalizeEmail(email) {
  const value = String(email || '').trim().toLowerCase();
  if (!value || !value.includes('@') || value.length > 320) return '';
  return value;
}

function normalizeWallet(address) {
  const value = String(address || '').trim();
  if (!ethers.isAddress(value)) return '';
  return ethers.getAddress(value);
}

function tokenAddress() {
  const configured = String(process.env.BSC_USDT_ADDRESS || BSC_USDT).trim();
  return ethers.isAddress(configured) ? ethers.getAddress(configured) : '';
}

function chainId() {
  const parsed = Number(process.env.BSC_CHAIN_ID);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : BSC_CHAIN_ID;
}

function evaluateSend({ amount, walletAddress, monthToDate = 0, token, chain } = {}) {
  const cap = limits();
  const rounded = roundAmount(amount);
  const wallet = normalizeWallet(walletAddress);
  if (isPaused()) {
    return { ok: false, code: 'disbursement_paused', message: 'Disbursement is paused' };
  }
  if (!rounded) {
    return { ok: false, code: 'invalid_amount', message: 'Amount must be greater than 0' };
  }
  if (rounded > cap.perItemMax) {
    return { ok: false, code: 'per_item_limit', message: `Amount exceeds the ${cap.perItemMax} USDT item limit` };
  }
  if (!wallet) {
    return { ok: false, code: 'invalid_wallet', message: 'A BSC wallet address is required' };
  }
  const spent = Number(monthToDate) || 0;
  if (spent + rounded > cap.monthlyMax) {
    return { ok: false, code: 'monthly_limit', message: `Amount exceeds the ${cap.monthlyMax} USDT monthly limit` };
  }
  const expectedToken = tokenAddress();
  const expectedChain = chainId();
  if (token && ethers.getAddress(token) !== expectedToken) {
    return { ok: false, code: 'unexpected_token', message: 'Payout token is not the configured BSC USDT contract' };
  }
  if (chain && Number(chain) !== expectedChain) {
    return { ok: false, code: 'unexpected_chain', message: 'Payout chain is not BSC' };
  }
  return { ok: true, amount: rounded, walletAddress: wallet, tokenAddress: expectedToken, chainId: expectedChain };
}

function validatePartnerItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return { ok: false, code: 'empty_batch', message: 'At least one payout item is required' };
  }
  if (items.length > MAX_BATCH_ITEMS) {
    return { ok: false, code: 'batch_too_large', message: `A batch can contain at most ${MAX_BATCH_ITEMS} items` };
  }
  const seen = new Set();
  const normalized = [];
  for (const raw of items) {
    const payoutId = String(raw?.payoutId || '').trim();
    if (!payoutId || payoutId.length > 128) {
      return { ok: false, code: 'invalid_payout_id', message: 'Each item needs a payoutId' };
    }
    if (seen.has(payoutId)) {
      return { ok: false, code: 'duplicate_payout_id', message: `Duplicate payoutId ${payoutId}` };
    }
    seen.add(payoutId);
    const email = normalizeEmail(raw?.email);
    if (!email) {
      return { ok: false, code: 'invalid_email', message: `Item ${payoutId} needs an email` };
    }
    const walletAddress = normalizeWallet(raw?.walletAddress);
    if (!walletAddress) {
      return { ok: false, code: 'invalid_wallet', message: `Item ${payoutId} needs a BSC address` };
    }
    const amount = roundAmount(raw?.amount);
    if (!amount) {
      return { ok: false, code: 'invalid_amount', message: `Item ${payoutId} needs an amount` };
    }
    const decision = evaluateSend({ amount, walletAddress, monthToDate: 0 });
    if (!decision.ok && decision.code === 'per_item_limit') return { ...decision, message: `Item ${payoutId}: ${decision.message}` };
    if (!decision.ok && decision.code !== 'monthly_limit' && decision.code !== 'disbursement_paused') {
      return decision;
    }
    const record = {
      payoutId,
      origin: ORIGIN_PARTNER_VOLUME,
      recordClass: recordClassForOrigin(ORIGIN_PARTNER_VOLUME),
      countsAsDataUpload: false,
      countsAsDataTrade: false,
      email,
      externalUserRef: raw?.externalUserRef ? String(raw.externalUserRef).trim().slice(0, 128) : null,
      walletAddress,
      amount,
      reason: raw?.reason ? String(raw.reason).trim().slice(0, 64) : 'partner_payout',
    };
    assertSeparateFromDataUploads(record);
    normalized.push(record);
  }
  return { ok: true, items: normalized };
}

function planWalletBind({ existingWallet, walletOwnerId, userId } = {}) {
  const current = normalizeWallet(existingWallet);
  if (current) return { setWallet: false };
  if (walletOwnerId && walletOwnerId !== userId) return { setWallet: false };
  return { setWallet: true };
}

function samePayload(existing, incoming) {
  return existing.emailNormalized === incoming.email
    && ethers.getAddress(existing.walletAddress) === incoming.walletAddress
    && Number(existing.amount) === incoming.amount
    && existing.reason === incoming.reason
    && (existing.externalUserRef || null) === (incoming.externalUserRef || null);
}

function partnerKeyFor(slug) {
  const normalized = String(slug || '').trim().toLowerCase();
  const direct = normalized === 'seesaw'
    ? String(process.env.SEESAW_DISBURSEMENT_API_KEY || '').trim()
    : '';
  if (direct) return direct;
  try {
    const map = JSON.parse(process.env.DISBURSEMENT_PARTNER_KEYS || '{}');
    return String(map[normalized] || '').trim();
  } catch {
    return '';
  }
}

function partnerKeyMatches(slug, presented) {
  const expected = partnerKeyFor(slug);
  const given = String(presented || '');
  if (!expected || !given) return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(given);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

module.exports = {
  BSC_CHAIN_ID,
  BSC_USDT,
  MAX_BATCH_ITEMS,
  limits,
  isPaused,
  roundAmount,
  normalizeEmail,
  normalizeWallet,
  tokenAddress,
  chainId,
  evaluateSend,
  validatePartnerItems,
  planWalletBind,
  samePayload,
  partnerKeyFor,
  partnerKeyMatches,
};
