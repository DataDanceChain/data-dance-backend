const prisma = require('../../utils/prisma');
const { generateUniqueReferralCode } = require('../../utils/referralUtils');
const { attestHashOnChain } = require('../../utils/commerceAttestChain');
const commerceService = require('../commerceService');
const procurementService = require('../procurementService');
const {
  ORIGIN_PARTNER_VOLUME,
  ORIGIN_INTERNAL_REWARD,
  recordClassForOrigin,
  isPartnerVolume,
  countsAsDataUpload,
} = require('./classify');
const {
  evaluateSend,
  validatePartnerItems,
  samePayload,
  tokenAddress,
  chainId,
  normalizeWallet,
  roundAmount,
  planWalletBind,
} = require('./policy');
const { buildDisbursementReceipt, hashDisbursementReceipt } = require('./receipt');
const { sendBscUsdt } = require('./bscPayout');

const PARTNERS = {
  seesaw: 'Seesaw',
};
const IN_FLIGHT_MS = 15 * 60 * 1000;
const RECONCILE_REASON = 'Payout submission did not record a transaction hash. Reconcile the BSC wallet before retrying.';

function httpError(statusCode, code, message) {
  return Object.assign(new Error(message), { statusCode, code });
}

function publicItem(item) {
  return {
    payoutId: item.payoutId,
    origin: item.origin,
    recordClass: item.recordClass,
    countsAsDataUpload: item.countsAsDataUpload === true,
    countsAsDataTrade: item.countsAsDataTrade === true,
    partnerSlug: item.partner?.slug || null,
    userId: item.userId || null,
    externalUserRef: item.externalUserRef || null,
    email: item.email || null,
    walletAddress: item.walletAddress,
    amount: item.amount,
    asset: item.asset,
    chainId: item.chainId,
    reason: item.reason || null,
    status: item.status,
    txHash: item.txHash || null,
    attestationHash: item.attestationHash || null,
    attestationTxHash: item.attestationTxHash || null,
    attestedAt: item.attestedAt || null,
    failureReason: item.failureReason || null,
    confirmedAt: item.confirmedAt || null,
  };
}

function publicBatch(batch) {
  const items = batch.items || [];
  return {
    id: batch.id,
    origin: batch.origin,
    externalBatchId: batch.externalBatchId,
    partnerSlug: batch.partner?.slug || null,
    status: batch.status,
    itemCount: batch.itemCount,
    totalAmount: batch.totalAmount,
    countsAsDataUpload: false,
    items: items.map(publicItem),
  };
}

async function resolvePartnerUser(email, walletAddress) {
  const existing = await prisma.user.findUnique({ where: { email } });
  const walletOwner = await prisma.user.findFirst({
    where: { walletAddress },
    select: { id: true },
  });
  const bind = planWalletBind({
    existingWallet: existing?.walletAddress,
    walletOwnerId: walletOwner?.id || null,
    userId: existing?.id || null,
  });
  if (!existing) {
    const referralCode = await generateUniqueReferralCode();
    const created = await prisma.user.create({
      data: {
        email,
        authType: 'seesaw',
        userType: 'regular',
        referralCode,
        ...(bind.setWallet ? { walletAddress, chainId: chainId() } : {}),
        profile: { create: { language: 'en' } },
      },
    });
    return created.id;
  }
  if (bind.setWallet) {
    await prisma.user.update({
      where: { id: existing.id },
      data: { walletAddress, chainId: existing.chainId || chainId() },
    });
  }
  return existing.id;
}

async function ensurePartner(slug) {
  const key = String(slug || '').trim().toLowerCase();
  const name = PARTNERS[key];
  if (!name) throw httpError(404, 'unknown_partner', 'Unknown disbursement partner');
  return prisma.disbursementPartner.upsert({
    where: { slug: key },
    update: {},
    create: { slug: key, name, status: 'active' },
  });
}

async function monthToDateTotal(now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const sum = await prisma.disbursementItem.aggregate({
    _sum: { amount: true },
    where: {
      // 'processing' with a submission date: a submitted payout claimed for its re-check.
      status: { in: ['submitted', 'processing', 'confirmed'] },
      OR: [
        { confirmedAt: { gte: start } },
        { submittedAt: { gte: start } },
      ],
    },
  });
  return Number(sum._sum.amount || 0);
}

async function refreshBatchStatus(batchId) {
  const items = await prisma.disbursementItem.findMany({ where: { batchId } });
  const totalAmount = items.reduce((sum, item) => sum + Number(item.amount || 0), 0);
  let status = 'accepted';
  if (items.length && items.every((item) => item.status === 'confirmed')) status = 'completed';
  else if (items.some((item) => item.status === 'confirmed' || item.status === 'failed' || item.status === 'held')) {
    status = 'partial';
  } else if (items.some((item) => item.status === 'processing' || item.status === 'submitted')) {
    status = 'processing';
  }
  return prisma.disbursementBatch.update({
    where: { id: batchId },
    data: { status, itemCount: items.length, totalAmount },
    include: { partner: true, items: { include: { partner: true }, orderBy: { createdAt: 'asc' } } },
  });
}

async function attestConfirmedItem(item, partnerSlug) {
  const paidAt = item.confirmedAt || new Date();
  const receipt = buildDisbursementReceipt({
    payoutId: item.payoutId,
    origin: item.origin,
    partnerSlug,
    email: item.emailNormalized || item.email,
    walletAddress: item.walletAddress,
    amount: item.amount,
    asset: item.asset,
    chainId: item.chainId,
    tokenAddress: item.tokenAddress,
    bscTxHash: item.txHash,
    paidAt,
    reason: item.reason,
  });
  const attestationHash = hashDisbursementReceipt(receipt);
  const chain = await attestHashOnChain(attestationHash);
  return prisma.disbursementItem.update({
    where: { id: item.id },
    data: {
      attestationHash,
      attestationPayload: receipt,
      attestationTxHash: chain.ok ? chain.txHash : item.attestationTxHash,
      attestedAt: chain.ok ? new Date() : item.attestedAt,
      failureReason: chain.ok ? null : (chain.reason || item.failureReason),
    },
    include: { partner: true },
  });
}

async function markRewardPaid(item) {
  if (!item.redemptionId || !item.txHash) return;
  const redemption = await prisma.pointsRedemption.update({
    where: { id: item.redemptionId },
    data: {
      status: 'paid',
      paidAt: item.confirmedAt || new Date(),
      vendor: 'bsc_usdt',
      vendorReference: item.txHash,
    },
  });
  if (redemption.orderId) {
    await procurementService.syncRedemptionCost(redemption.orderId, redemption);
  }
}

/** The audit row of an ops call on a payout: what it was, what it becomes, where the money goes. */
function payoutAuditEntry(item, step, statusAfter, extra = {}) {
  return {
    target: { type: 'disbursement_item', id: item.id, label: item.payoutId || null },
    detail: {
      step,
      statusBefore: item.status,
      statusAfter,
      amount: item.amount,
      asset: item.asset,
      chainId: item.chainId,
      walletAddress: item.walletAddress,
      redemptionId: item.redemptionId || null,
      txHash: item.txHash || null,
      ...extra,
    },
  };
}

/**
 * With `audit` (an ops route), a write and its audit row commit in one transaction: `write(db)`
 * makes the change, `changed(result)` says whether it changed anything (no change, no row), and
 * `entry` is the row (or a function of the result). Without `audit` the write runs as before.
 */
async function auditedWrite(audit, entry, write, changed = () => true) {
  if (!audit) return write(prisma);
  return prisma.$transaction(async (tx) => {
    const result = await write(tx);
    if (changed(result)) await audit(tx, typeof entry === 'function' ? entry(result) : entry);
    return result;
  });
}

/** A reconcile claim older than this was left by a crash and may be taken over. */
const RECONCILE_CLAIM_STALE_MS = 15 * 60 * 1000;

/**
 * The reconcile step of a confirmed payout (attest it, mark its redemption paid) runs for one
 * caller at a time: the claim sets `reconcileClaimedAt` with a conditional update on the payout as
 * it was read (confirmed, same hash, no live claim), so of two calls at once exactly one wins and
 * the other changes and sends nothing. With an audit, the claim and its row commit together, before
 * the attestation is sent. Answers the claim time, or null when the call lost.
 */
async function claimReconcile(audit, existing) {
  const claimedAt = new Date();
  const staleBefore = new Date(claimedAt.getTime() - RECONCILE_CLAIM_STALE_MS);
  const claimed = await auditedWrite(
    audit,
    payoutAuditEntry(existing, 'reconcile', existing.status),
    (db) => db.disbursementItem.updateMany({
      where: {
        id: existing.id,
        status: 'confirmed',
        txHash: existing.txHash,
        OR: [{ reconcileClaimedAt: null }, { reconcileClaimedAt: { lt: staleBefore } }],
      },
      data: { reconcileClaimedAt: claimedAt },
    }),
    (result) => result.count === 1,
  );
  return claimed.count === 1 ? claimedAt : null;
}

async function releaseReconcile(id, claimedAt) {
  await prisma.disbursementItem.updateMany({
    where: { id, reconcileClaimedAt: claimedAt },
    data: { reconcileClaimedAt: null },
  });
}

function reloadItem(id) {
  return prisma.disbursementItem.findUnique({ where: { id }, include: { partner: true } });
}

/**
 * Process one payout. With `audit` (the ops route), the call's first change to the payout is
 * written in one transaction with its audit row, before any transfer is sent: one row per call
 * that changes the payout, none for a call that changes nothing. A failed audit write changes
 * nothing and sends nothing.
 */
async function processItem(itemId, { audit } = {}) {
  const existing = await prisma.disbursementItem.findFirst({
    where: { OR: [{ id: itemId }, { payoutId: String(itemId) }] },
    include: { partner: true },
  });
  if (!existing) throw httpError(404, 'payout_not_found', 'Payout item not found');
  if (isPartnerVolume(existing) && countsAsDataUpload(existing)) {
    throw httpError(409, 'partner_volume_not_data_upload', 'Partner volume cannot be processed as a data upload');
  }

  if (existing.status === 'confirmed' && existing.txHash) {
    // Attested and not a redemption: nothing left to do (no change, no audit row).
    if (existing.attestationTxHash && !existing.redemptionId) return existing;
    const claimedAt = await claimReconcile(audit, existing);
    // The loser sees the payout as the winner left it.
    if (!claimedAt) return reloadItem(existing.id);
    try {
      const attested = existing.attestationTxHash
        ? existing
        : await attestConfirmedItem(existing, existing.partner?.slug || null);
      await markRewardPaid(attested);
    } finally {
      await releaseReconcile(existing.id, claimedAt);
    }
    return reloadItem(existing.id);
  }

  if (existing.txHash && existing.status === 'submitted') {
    // The re-check can send a new transfer (when the stored hash never confirmed), so only one
    // caller may run it: the claim moves the payout from 'submitted' to 'processing' (keeping its
    // hash) and exactly one updateMany wins it. With an audit, the claim and its row commit
    // together. The loser sees the payout as the winner left it.
    const claimed = await auditedWrite(
      audit,
      payoutAuditEntry(existing, 'recheck', 'processing'),
      (db) => db.disbursementItem.updateMany({
        where: { id: existing.id, status: 'submitted', txHash: existing.txHash },
        data: { status: 'processing' },
      }),
      (result) => result.count === 1,
    );
    if (claimed.count !== 1) return reloadItem(existing.id);
    let sent;
    try {
      sent = await sendBscUsdt({
        to: existing.walletAddress,
        amount: existing.amount,
        existingTxHash: existing.txHash,
      });
    } catch (error) {
      // Released as it was claimed: still 'submitted' with its hash, for the next re-check.
      await prisma.disbursementItem.updateMany({
        where: { id: existing.id, status: 'processing', txHash: existing.txHash },
        data: { status: 'submitted', failureReason: error.message || 'BSC payout re-check failed' },
      });
      throw error;
    }
    const confirmed = await prisma.disbursementItem.update({
      where: { id: existing.id },
      data: {
        status: 'confirmed',
        txHash: sent.txHash,
        confirmedAt: new Date(),
        failureReason: null,
      },
      include: { partner: true },
    });
    const attested = await attestConfirmedItem(confirmed, confirmed.partner?.slug || null);
    await markRewardPaid(attested);
    return attested;
  }

  if (existing.failureReason === RECONCILE_REASON) {
    return existing;
  }

  if (existing.status === 'processing') {
    const age = Date.now() - new Date(existing.updatedAt).getTime();
    if (age < IN_FLIGHT_MS) {
      throw httpError(409, 'disbursement_in_flight', 'This payout is already being submitted');
    }
    return auditedWrite(
      audit,
      payoutAuditEntry(existing, 'hold', 'held', { holdCode: 'reconcile' }),
      (db) => db.disbursementItem.update({
        where: { id: existing.id },
        data: { status: 'held', failureReason: RECONCILE_REASON },
        include: { partner: true },
      }),
    );
  }

  const spent = await monthToDateTotal();
  const decision = evaluateSend({
    amount: existing.amount,
    walletAddress: existing.walletAddress,
    monthToDate: spent,
    token: existing.tokenAddress,
    chain: existing.chainId,
  });
  if (!decision.ok) {
    return auditedWrite(
      audit,
      payoutAuditEntry(existing, 'hold', 'held', { holdCode: decision.code || null }),
      (db) => db.disbursementItem.update({
        where: { id: existing.id },
        data: { status: 'held', failureReason: decision.message },
        include: { partner: true },
      }),
    );
  }

  // The claim: with an audit, the claim and its row commit together before the transfer.
  const locked = await auditedWrite(
    audit,
    payoutAuditEntry(
      { ...existing, amount: decision.amount, walletAddress: decision.walletAddress },
      'send',
      'processing',
    ),
    (db) => db.disbursementItem.updateMany({
      where: {
        id: existing.id,
        txHash: null,
        status: { in: ['accepted', 'failed', 'held'] },
      },
      data: { status: 'processing', failureReason: null },
    }),
    (result) => result.count === 1,
  );
  if (locked.count !== 1) {
    const current = await prisma.disbursementItem.findUnique({
      where: { id: existing.id },
      include: { partner: true },
    });
    return current;
  }

  try {
    const sent = await sendBscUsdt({
      to: decision.walletAddress,
      amount: decision.amount,
    });
    const confirmed = await prisma.disbursementItem.update({
      where: { id: existing.id },
      data: {
        status: 'confirmed',
        txHash: sent.txHash,
        walletAddress: decision.walletAddress,
        amount: decision.amount,
        submittedAt: new Date(),
        confirmedAt: new Date(),
        failureReason: null,
      },
      include: { partner: true },
    });
    const attested = await attestConfirmedItem(confirmed, confirmed.partner?.slug || null);
    await markRewardPaid(attested);
    return attested;
  } catch (error) {
    const unconfigured = error.code === 'payout_signer_unconfigured';
    return prisma.disbursementItem.update({
      where: { id: existing.id },
      data: {
        status: unconfigured ? 'accepted' : 'failed',
        failureReason: error.message || 'BSC payout failed',
      },
      include: { partner: true },
    });
  }
}

async function processBatch(batchId) {
  const items = await prisma.disbursementItem.findMany({
    where: { batchId },
    orderBy: { createdAt: 'asc' },
  });
  for (const item of items) {
    if (item.status === 'confirmed' && item.attestationTxHash) continue;
    await processItem(item.id);
  }
  return refreshBatchStatus(batchId);
}

async function acceptPartnerBatch(slug, { batchId, items } = {}) {
  const externalBatchId = String(batchId || '').trim();
  if (!externalBatchId) throw httpError(400, 'invalid_batch', 'batchId is required');
  const partner = await ensurePartner(slug);
  if (partner.status !== 'active') throw httpError(403, 'partner_inactive', 'Partner disbursement is inactive');

  const validated = validatePartnerItems(items);
  if (!validated.ok) throw httpError(400, validated.code, validated.message);

  const existing = await prisma.disbursementBatch.findUnique({
    where: { partnerId_externalBatchId: { partnerId: partner.id, externalBatchId } },
    include: { items: true, partner: true },
  });
  if (existing) {
    const incomingIds = validated.items.map((item) => item.payoutId).sort();
    const existingIds = existing.items.map((item) => item.payoutId).sort();
    const sameIds = incomingIds.length === existingIds.length
      && incomingIds.every((id, index) => id === existingIds[index]);
    const sameBodies = sameIds && validated.items.every((item) => {
      const row = existing.items.find((candidate) => candidate.payoutId === item.payoutId);
      return row && samePayload(row, item);
    });
    if (!sameBodies) {
      throw httpError(409, 'batch_conflict', 'This batchId was already submitted with different items');
    }
    const processed = await processBatch(existing.id);
    return { replayed: true, batch: processed };
  }

  const payoutIds = validated.items.map((item) => item.payoutId);
  const clash = await prisma.disbursementItem.findFirst({ where: { payoutId: { in: payoutIds } } });
  if (clash) throw httpError(409, 'payout_id_taken', `payoutId ${clash.payoutId} already exists`);

  const token = tokenAddress();
  const payoutChainId = chainId();
  const userIds = new Map();
  for (const item of validated.items) {
    if (!userIds.has(item.email)) {
      userIds.set(item.email, await resolvePartnerUser(item.email, item.walletAddress));
    }
  }
  const created = await prisma.disbursementBatch.create({
    data: {
      partnerId: partner.id,
      origin: ORIGIN_PARTNER_VOLUME,
      externalBatchId,
      status: 'accepted',
      itemCount: validated.items.length,
      totalAmount: validated.items.reduce((sum, item) => sum + item.amount, 0),
      items: {
        create: validated.items.map((item) => ({
          payoutId: item.payoutId,
          partnerId: partner.id,
          origin: ORIGIN_PARTNER_VOLUME,
          recordClass: item.recordClass,
          countsAsDataUpload: false,
          countsAsDataTrade: false,
          externalUserRef: item.externalUserRef,
          email: item.email,
          emailNormalized: item.email,
          userId: userIds.get(item.email),
          walletAddress: item.walletAddress,
          amount: item.amount,
          asset: 'USDT',
          chainId: payoutChainId,
          tokenAddress: token,
          reason: item.reason,
          status: 'accepted',
        })),
      },
    },
  });

  const processed = await processBatch(created.id);
  return { replayed: false, batch: processed };
}

async function getPartnerItem(slug, payoutId) {
  const partner = await ensurePartner(slug);
  const item = await prisma.disbursementItem.findFirst({
    where: { payoutId: String(payoutId), partnerId: partner.id, origin: ORIGIN_PARTNER_VOLUME },
    include: { partner: true },
  });
  if (!item) throw httpError(404, 'payout_not_found', 'Payout item not found');
  return item;
}

async function loadRedemption(redemptionId, user) {
  const redemption = await prisma.pointsRedemption.findUnique({
    where: { id: redemptionId },
    include: { order: true, disbursementItem: true },
  });
  if (!redemption) throw httpError(404, 'redemption_not_found', 'Redemption not found');
  if (user) {
    const ownsOrder = redemption.order && commerceService.canAccessRecord(user, redemption.order);
    const created = redemption.createdById === user.id;
    if (!ownsOrder && !created) {
      throw httpError(403, 'forbidden', 'Not authorized to disburse this redemption');
    }
  }
  if (String(redemption.asset || '').toUpperCase() !== 'USDT') {
    throw httpError(400, 'unsupported_asset', 'Automated disbursement currently sends USDT');
  }
  return redemption;
}

/**
 * Pay a USDT redemption out. With `audit` (the ops route): a redemption that already has a payout
 * is processed as processItem does; a new payout is created in one transaction with the audit row
 * (amount, wallet), and the transfer that follows belongs to that row.
 */
async function disburseRedemption(user, redemptionId, { walletAddress, audit } = {}) {
  const redemption = await loadRedemption(redemptionId, user);
  if (redemption.disbursementItem) {
    const item = await processItem(redemption.disbursementItem.id, { audit });
    return { redemption, item };
  }

  const amount = roundAmount(redemption.amount);
  const wallet = normalizeWallet(walletAddress);
  if (!amount) throw httpError(400, 'invalid_amount', 'Amount must be greater than 0');
  if (!wallet) throw httpError(400, 'invalid_wallet', 'A BSC wallet address is required');
  const decision = evaluateSend({ amount, walletAddress: wallet, monthToDate: 0 });
  if (!decision.ok && decision.code === 'per_item_limit') {
    throw httpError(400, decision.code, decision.message);
  }

  const payoutId = `redemption:${redemption.id}`;
  const createdEntry = (created) => ({
    target: { type: 'points_redemption', id: redemption.id },
    detail: {
      step: 'create',
      payoutId,
      itemId: created.items[0]?.id || null,
      amount,
      asset: 'USDT',
      chainId: chainId(),
      walletAddress: wallet,
    },
  });
  const batch = await auditedWrite(audit, createdEntry, (db) => db.disbursementBatch.create({
    data: {
      origin: ORIGIN_INTERNAL_REWARD,
      externalBatchId: payoutId,
      status: 'accepted',
      itemCount: 1,
      totalAmount: amount,
      items: {
        create: {
          payoutId,
          origin: ORIGIN_INTERNAL_REWARD,
          recordClass: recordClassForOrigin(ORIGIN_INTERNAL_REWARD),
          countsAsDataUpload: false,
          countsAsDataTrade: false,
          email: redemption.email,
          emailNormalized: redemption.emailNormalized,
          userId: redemption.userId,
          redemptionId: redemption.id,
          walletAddress: wallet,
          amount,
          asset: 'USDT',
          chainId: chainId(),
          tokenAddress: tokenAddress(),
          reason: 'points_redemption',
          status: 'accepted',
        },
      },
    },
    include: { items: true },
  }));
  const item = await processItem(batch.items[0].id);
  await refreshBatchStatus(batch.id);
  return { redemption, item };
}

async function listItems({ origin, partnerSlug, limit = 50 } = {}) {
  const take = Math.min(100, Math.max(1, Number(limit) || 50));
  const where = {};
  if (origin) {
    if (origin !== ORIGIN_PARTNER_VOLUME && origin !== ORIGIN_INTERNAL_REWARD) {
      throw httpError(400, 'invalid_origin', 'origin must be partner_volume or internal_reward');
    }
    where.origin = origin;
  }
  if (partnerSlug) {
    where.partner = { slug: String(partnerSlug).trim().toLowerCase() };
  }
  const items = await prisma.disbursementItem.findMany({
    where,
    include: { partner: true },
    orderBy: { createdAt: 'desc' },
    take,
  });
  return items.map(publicItem);
}

module.exports = {
  PARTNERS,
  publicItem,
  publicBatch,
  ensurePartner,
  acceptPartnerBatch,
  getPartnerItem,
  processItem,
  processBatch,
  disburseRedemption,
  listItems,
};
