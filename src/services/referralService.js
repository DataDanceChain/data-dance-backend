// referral service: build referral overview up to 3 levels
const prisma = require('../utils/prisma');
const { recordTaskProgress } = require('./taskService');
const { REFERRAL_MESSAGES } = require('../constants/messages');
const { createLogger } = require('../utils/logger');
const { distributeUplineRewards } = require('./distributionService');
const {
  MOTHERS_DAY_2026_SLUG,
  MOTHERS_DAY_2026,
  SUMMER_TRAVEL_2026_SLUG,
  SUMMER_TRAVEL_2026,
  POINT_SOURCE_SUMMER_TRAVEL_INVITER,
  POINT_SOURCE_SUMMER_TRAVEL_INVITEE,
  POINT_SOURCE_SUMMER_TRAVEL_BONUS,
  normalizeReferralCampaignInput,
} = require('../constants/referralCampaigns');
const { assertReferralCampaignUsable, resolveStayBonusRules } = require('../utils/stayBonus');
const { getReferralRulesPayload } = require('../constants/referralCopy');
const {
  hasCompletedFirstValidUpload,
  getLatestValidUploadAt,
} = require('../utils/firstValidUpload');
const {
  hasCompletedFirstValidSummerOrder,
  countUserSummerStayOrders,
} = require('../utils/summerTravelEligibility');

const logger = createLogger('referralService');
const { ensureDisplayReferralCode, findUserByReferralCode } = require('../utils/referralUtils');
const { formatReferralCodeForDisplay, normalizeReferralCodeInput } = require('../utils/referralCodeFormat');

/** Standard (non-campaign) direct referral — immediate inviter bonus and upline distribution base */
const DIRECT_REFERRAL_BONUS_POINTS = 150;

function laterOf(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return new Date(a).getTime() >= new Date(b).getTime() ? a : b;
}

/** inviteeId -> when the inviter's 150-point REFERRAL_DIRECT bonus for them was first paid. */
async function getDirectBonusPaidAt(inviteeIds) {
  const paidAt = new Map();
  if (!inviteeIds.length) return paidAt;
  const rows = await prisma.point.findMany({
    where: { source: 'REFERRAL_DIRECT', sourceId: { in: inviteeIds } },
    select: { sourceId: true, createdAt: true },
  });
  for (const row of rows) {
    const prev = paidAt.get(row.sourceId);
    if (!prev || new Date(row.createdAt) < new Date(prev)) paidAt.set(row.sourceId, row.createdAt);
  }
  return paidAt;
}

const atOrAfter = (a, b) => new Date(a).getTime() >= new Date(b).getTime();

/**
 * Per-node facts behind `qualified`, kept off the API payload (node -> facts), so a loaded tree can
 * be re-judged under a later floor without walking it again (see qualifiedLevelCountsSince).
 * facts = { id, inviteTime, latestUploadAt (null: no eligible upload ever), bonusPaidAt
 * (undefined: not looked up yet, null: never paid) }.
 */
const referralNodeFacts = new WeakMap();

/**
 * Rule (Sloan, 2026-09-28: 后绑码的邀请关系方面的奖励只算绑定后的): an invitee qualifies through an
 * upload made at or after the latest bind on the path from the viewer down to them (their own bind
 * and every bind in between). So when a user with an existing downline binds an inviter late, that
 * downline's earlier activity counts for nobody above the new bind. For a chain where everyone signed
 * up with a code, each parent's bind precedes the child's, so this is just the invitee's own bind.
 * `floor` is the cutoff inherited from above: null for the viewer's own overview, or the claimant's
 * own (upward) bind time for an upline-rebate check.
 *
 * Never take back what was earned: an invitee whose direct bonus was already paid (possibly under the
 * pre-2026-09-28 rule, for an upload made before a late bind) stays qualified, if paid at or after
 * `floor`. Like everyone else they still need an eligible upload at some point: before 2026-06-02
 * (ef34c4c) the bonus was paid at signup with no upload at all, and those invitees stay unqualified,
 * exactly as on main.
 */
function needsBonusLookup(facts, floor) {
  if (!facts.latestUploadAt || facts.bonusPaidAt !== undefined) return false;
  return !atOrAfter(facts.latestUploadAt, laterOf(floor, facts.inviteTime));
}

function isQualified(facts, floor) {
  if (!facts.latestUploadAt) return false;
  if (atOrAfter(facts.latestUploadAt, laterOf(floor, facts.inviteTime))) return true;
  return Boolean(facts.bonusPaidAt) && (!floor || atOrAfter(facts.bonusPaidAt, floor));
}

/** Looks up the bonus payment only for invitees whose uploads all predate their cutoff (none in a
 * tree where everyone signed up with a code), in one query. */
async function fillBonusPaidAt(factsList) {
  if (!factsList.length) return;
  const paidAt = await getDirectBonusPaidAt([...new Set(factsList.map((f) => f.id))]);
  for (const f of factsList) f.bonusPaidAt = paidAt.get(f.id) || null;
}

/** Depth-first over a loaded tree with each node's cutoff: `floor` at the top, then the later of it
 * and every bind on the way down. */
function visitWithFloor(nodes, floor, fn) {
  for (const n of nodes) {
    const facts = referralNodeFacts.get(n);
    if (!facts) throw new Error('referral node was not loaded by getReferralOverview');
    fn(n, facts, floor);
    visitWithFloor(n.referrals, laterOf(floor, facts.inviteTime), fn);
  }
}

/** Every node that needs its bonus payment looked up under `floor`, across the whole tree, in one
 * query (none in a tree where everyone signed up with a code). */
async function fillBonusPaidAtForTree(referrals, floor) {
  const missing = [];
  visitWithFloor(referrals, floor, (n, facts, nodeFloor) => {
    if (needsBonusLookup(facts, nodeFloor)) missing.push(facts);
  });
  await fillBonusPaidAt(missing);
}

/** Loads the tree and each node's facts; `qualified` is judged afterwards by judgeReferralTree, so
 * the bonus lookup is one query for the whole tree rather than one per parent. */
async function fetchReferrals(userId, level, maxLevel) {
  if (level > maxLevel) return [];
  // Standard referral rewards UI / tasks only apply to non-campaign invites.
  // Mother's Day (campaignSlug set) uses separate Point sources and skips referral-* tasks.
  const refs = await prisma.referral.findMany({
    where: { inviterId: userId, campaignSlug: null },
    include: { invitee: { select: { id: true, email: true, name: true } } }
  });
  const latestUploadAt = await getLatestValidUploadAt(refs.map((r) => r.invitee.id));
  const result = [];
  for (const r of refs) {
    const node = {
      id: r.invitee.id,
      email: r.invitee.email,
      nickname: r.invitee.name,
      level,
      qualified: false,
      inviteTime: r.createdAt,
      referrals: await fetchReferrals(r.invitee.id, level + 1, maxLevel)
    };
    referralNodeFacts.set(node, {
      id: r.invitee.id,
      inviteTime: r.createdAt,
      latestUploadAt: latestUploadAt.get(r.invitee.id) || null,
      bonusPaidAt: undefined,
    });
    result.push(node);
  }
  return result;
}

/** Sets `qualified` on every node of a freshly loaded tree under `floor`. */
async function judgeReferralTree(referrals, floor) {
  await fillBonusPaidAtForTree(referrals, floor);
  visitWithFloor(referrals, floor, (n, facts, nodeFloor) => {
    n.qualified = isQualified(facts, nodeFloor);
  });
}

/**
 * Qualified descendants per level of an already-loaded tree (getReferralOverview(...).referrals)
 * under the extra cutoff `since`: the same answer as getReferralOverview(userId, { since }), but
 * without walking the tree again. At most one extra query, and only when some descendant's
 * uploads all predate their cutoff. The task-claim upline-rebate check uses it.
 */
async function qualifiedLevelCountsSince(referrals, since) {
  const floor = since || null;
  await fillBonusPaidAtForTree(referrals, floor);
  const counts = { 1: 0, 2: 0, 3: 0, 4: 0 };
  visitWithFloor(referrals, floor, (n, facts, nodeFloor) => {
    if (counts[n.level] != null && isQualified(facts, nodeFloor)) counts[n.level]++;
  });
  return counts;
}

function countQualifiedReferralsByLevel(nodes, counts = { 1: 0, 2: 0, 3: 0, 4: 0 }) {
  nodes.forEach((n) => {
    if (n.qualified && counts[n.level] != null) counts[n.level]++;
    countQualifiedReferralsByLevel(n.referrals, counts);
  });
  return counts;
}

async function hasReferralRewardsBeenProcessedForInvitee(inviteeId) {
  const existing = await prisma.point.findFirst({
    where: { source: 'REFERRAL_DIRECT', sourceId: inviteeId },
    select: { id: true },
  });
  return Boolean(existing);
}

/**
 * `since` (optional Date): count only descendants who qualified at or after it. The task claim path
 * passes the claimant's own bind time when deciding whether their upline earns a rebate.
 */
async function getReferralOverview(userId, { since } = {}) {
  // fetch nested referrals up to 4 levels for user info
  const referrals = await fetchReferrals(userId, 1, 4);
  await judgeReferralTree(referrals, since || null);
  // flatten to count network size
  const flatten = (nodes) => nodes.reduce((acc, n) => acc + 1 + flatten(n.referrals), 0);
  // count referrals per level (levels 1-4)
  const levelCounts = { 1: 0, 2: 0, 3: 0, 4: 0 };
  function countLevels(nodes) {
    nodes.forEach(n => {
      if (levelCounts[n.level] != null) levelCounts[n.level]++;
      countLevels(n.referrals);
    });
  }
  countLevels(referrals);
  const qualifiedLevelCounts = countQualifiedReferralsByLevel(referrals);
  // compute claimed points by level from point records
  const pointRecords = await prisma.point.findMany({
    where: { userId, source: { in: ['REFERRAL_DIRECT','REFERRAL_LEVEL_2','REFERRAL_LEVEL_3','REFERRAL_LEVEL_4'] } },
    select: { amount: true, source: true }
  });
  const claimedByLevel = { level1: 0, level2: 0, level3: 0, level4: 0 };
  pointRecords.forEach(record => {
    switch (record.source) {
      case 'REFERRAL_DIRECT': claimedByLevel.level1 += record.amount; break;
      case 'REFERRAL_LEVEL_2': claimedByLevel.level2 += record.amount; break;
      case 'REFERRAL_LEVEL_3': claimedByLevel.level3 += record.amount; break;
      case 'REFERRAL_LEVEL_4': claimedByLevel.level4 += record.amount; break;
    }
  });
  // fetch referral task point values
  const referralTasks = await prisma.task.findMany({ where: { id: { in: ['referral-1','referral-2','referral-3','referral-4'] } }, select: { id: true, points: true } });
  const levelPoints = {};
  referralTasks.forEach(t => {
    const lvl = parseInt(t.id.split('-')[1], 10) || 1;
    levelPoints[`level${lvl}`] = t.points;
  });
  // compute unclaimed points per level based on qualified referrals (first valid upload)
  const unclaimedByLevel = {};
  [1,2,3,4].forEach(lvl => {
    const key = `level${lvl}`;
    const totalRefs = qualifiedLevelCounts[lvl] || 0;
    const claimedCount = levelPoints[key] ? claimedByLevel[key] / levelPoints[key] : 0;
    const unclaimedCount = Math.max(totalRefs - claimedCount, 0);
    unclaimedByLevel[key] = unclaimedCount * (levelPoints[key] || 0);
  });
  // combine claimed and unclaimed
  const earnedByLevel = [
    claimedByLevel.level1 + unclaimedByLevel.level1,
    claimedByLevel.level2 + unclaimedByLevel.level2,
    claimedByLevel.level3 + unclaimedByLevel.level3,
    claimedByLevel.level4 + unclaimedByLevel.level4
  ];
  const totalReferralPoints = earnedByLevel.reduce((a, b) => a + b, 0);
  const unclaimReferralAwards = Object.values(unclaimedByLevel).reduce((a, b) => a + b, 0);
  // prepare levelPoints mapping from referralTasks
  const levelPointsMap = {};
  referralTasks.forEach(t => {
    const lvl = parseInt(t.id.split('-')[1], 10);
    levelPointsMap[lvl] = t.points;
  });
  // annotate each referral node with theirPoints
  // 注意：yourReward现在由新的通用分润系统在任务完成时动态计算，基于百分比而非固定分值
  function annotate(nodes) {
    nodes.forEach(n => {
      const qualifiedChildren = n.referrals.filter((child) => child.qualified).length;
      n.theirPoints = qualifiedChildren * DIRECT_REFERRAL_BONUS_POINTS;
      annotate(n.referrals);
    });
  }
  annotate(referrals);
  // Display heuristic for downstream depth (not tied to direct-invite bonus amount).
  const lvl234Count = (levelCounts[2] || 0) + (levelCounts[3] || 0) + (levelCounts[4] || 0);
  const networkActivity = totalReferralPoints + lvl234Count * 50;

  return {
    referrals,
    levelCounts,
    qualifiedLevelCounts,
    earnedByLevel,
    totalReferralPoints,
    unclaimReferralAwards,
    networkActivity,
    rules: getReferralRulesPayload(),
  };
}

async function claimReferralRewards(userId) {
  const uts = await prisma.userTask.findMany({
    where: { userId, status: 'LIVE', claimed: false, task: { awardId: 'referral-rewards' } },
    include: { task: true }
  });
  if (uts.length === 0) throw new Error('No referral rewards to claim');

  const totalAwarded = uts.reduce((sum, ut) => sum + ut.task.points, 0);
  const now = new Date();

  await prisma.$transaction(async (tx) => {
    await tx.userTask.updateMany({
      where: { userId, status: 'LIVE', claimed: false, task: { awardId: 'referral-rewards' } },
      data: { claimed: true }
    });
    for (const ut of uts) {
      const [, levelStr] = ut.taskId.split('-');
      const level = parseInt(levelStr, 10) || 1;
      const source = level === 1 ? 'REFERRAL_DIRECT' : `REFERRAL_LEVEL_${level}`;
      await tx.point.create({
        data: { userId, amount: ut.task.points, source, sourceId: ut.taskId, createdAt: now },
      });
    }
    if (totalAwarded !== 0) {
      await tx.user.update({
        where: { id: userId },
        data: { totalPoints: { increment: totalAwarded } },
      });
    }
  });

  return { claimedAt: now, totalPoints: totalAwarded, count: uts.length };
}

/**
 * Pays a referral bonus at most once, even when two requests reach the payout together (two uploads
 * in parallel, or a login overlapping an upload). Point has no unique key, so the lookup callers do
 * before this is only a fast path. `pay` must update the inviter's User row before anything else and
 * then call assertNotPaidYet: that row lock is held until commit, so a concurrent payout for the same
 * invitee (who has exactly one inviter) waits on it, and its re-check then sees the first payout's
 * committed Point row (under READ COMMITTED every statement takes a fresh snapshot) and rolls back.
 * Resolves true when this call paid, false when another request already had.
 */
async function payOnceInTransaction(pay) {
  try {
    await prisma.$transaction(pay);
    return true;
  } catch (err) {
    if (err?.code === 'REFERRAL_ALREADY_PAID') return false;
    throw err;
  }
}

async function assertNotPaidYet(tx, where) {
  const existing = await tx.point.findFirst({ where, select: { id: true } });
  if (existing) {
    const err = new Error('Referral reward already paid');
    err.code = 'REFERRAL_ALREADY_PAID';
    throw err;
  }
}

/**
 * Process a new referral: create Referral row and propagate progress up to 4 levels
 * @param {string} newUserId - the invitee user ID
 * @param {string} inviterId - the direct inviter user ID
 * @param {string} referralCode - the referral code used
 */
/**
 * Campaign flat bonuses — no multi-level tasks or upline distribution.
 * Mother's Day: immediate on signup. Summer Travel: call after first valid summer stay.
 */
async function processCampaignReferral(newUserId, inviterId, campaignSlug) {
  let inviterAmount = 0;
  let inviteeAmount = 0;
  let inviterSource = null;
  let inviteeSource = null;
  if (campaignSlug === MOTHERS_DAY_2026_SLUG) {
    inviterAmount = MOTHERS_DAY_2026.inviterPoints;
    inviteeAmount = MOTHERS_DAY_2026.inviteePoints;
    inviterSource = 'REFERRAL_CAMPAIGN_MOTHERS_DAY_INVITER';
    inviteeSource = 'REFERRAL_CAMPAIGN_MOTHERS_DAY_INVITEE';
  } else if (campaignSlug === SUMMER_TRAVEL_2026_SLUG) {
    const stayRules = await resolveStayBonusRules();
    inviterAmount = stayRules?.inviterPoints || SUMMER_TRAVEL_2026.inviterPoints;
    inviteeAmount = stayRules?.inviteePoints || SUMMER_TRAVEL_2026.inviteePoints;
    inviterSource = POINT_SOURCE_SUMMER_TRAVEL_INVITER;
    inviteeSource = POINT_SOURCE_SUMMER_TRAVEL_INVITEE;
  } else {
    throw new Error(`Unsupported campaign for referral rewards: ${campaignSlug}`);
  }

  // Idempotency: skip if inviter already credited for this invitee
  const already = await prisma.point.findFirst({
    where: {
      userId: inviterId,
      source: inviterSource,
      sourceId: newUserId,
    },
    select: { id: true },
  });
  if (already) {
    logger.info('Campaign referral rewards already issued', {
      campaignSlug,
      inviterId,
      inviteeId: newUserId,
    });
    return { skipped: true, reason: 'already_processed' };
  }

  const paid = await payOnceInTransaction(async (tx) => {
    await tx.user.update({
      where: { id: inviterId },
      data: { totalPoints: { increment: inviterAmount } },
    });
    await assertNotPaidYet(tx, { userId: inviterId, source: inviterSource, sourceId: newUserId });
    await tx.point.create({
      data: {
        userId: inviterId,
        amount: inviterAmount,
        source: inviterSource,
        sourceId: newUserId,
      },
    });
    await tx.user.update({
      where: { id: newUserId },
      data: { totalPoints: { increment: inviteeAmount } },
    });
    await tx.point.create({
      data: {
        userId: newUserId,
        amount: inviteeAmount,
        source: inviteeSource,
        sourceId: inviterId,
      },
    });
  });
  if (!paid) {
    logger.info('Campaign referral rewards already issued by a concurrent request', {
      campaignSlug,
      inviterId,
      inviteeId: newUserId,
    });
    return { skipped: true, reason: 'already_processed' };
  }

  logger.info('Campaign referral rewards issued', {
    campaignSlug,
    inviterId,
    inviteeId: newUserId,
    inviterAmount,
    inviteeAmount,
  });
  return { skipped: false, inviterAmount, inviteeAmount };
}

/**
 * Inviter must complete Task 01 (≥1 valid summer stay) before campaign invites unlock.
 */
async function assertSummerTravelInviterEligible(inviterId) {
  const ok = await hasCompletedFirstValidSummerOrder(inviterId);
  if (!ok) {
    const err = new Error('Complete Task 01 first to unlock Summer Travel invites.');
    err.code = 'CAMPAIGN_INVITER_LOCKED';
    throw err;
  }
}

/**
 * When the invitee bound their inviter (Referral.createdAt). Referral rewards count only the
 * invitee's activity at or after this instant (Sloan, 2026-09-28: 后绑码的邀请关系方面的奖励只算绑定后的).
 * For a user who signed up with a code this is their registration, so nothing changes for them.
 */
async function getReferralBindTime(inviteeId) {
  const referral = await prisma.referral.findUnique({
    where: { inviteeId },
    select: { createdAt: true },
  });
  return referral?.createdAt || null;
}

async function tryProcessSummerTravelReferralRewards(inviteeId, inviterId, boundAt = null) {
  const stayRules = await resolveStayBonusRules();
  if (!stayRules?.isActive) {
    logger.info('Summer Travel referral settlement skipped — campaign inactive', {
      inviteeId,
      inviterId,
    });
    return { skipped: true, reason: 'campaign_inactive' };
  }
  const since = boundAt || (await getReferralBindTime(inviteeId));
  if (!since) {
    logger.info('Summer Travel referral settlement skipped — no referral row', { inviteeId, inviterId });
    return { skipped: true, reason: 'no_referral' };
  }
  if (!(await hasCompletedFirstValidSummerOrder(inviteeId, prisma, { since }))) {
    logger.info('Summer Travel referral deferred until invitee summer stay upload', {
      inviteeId,
      inviterId,
    });
    return { deferred: true };
  }
  return processCampaignReferral(inviteeId, inviterId, SUMMER_TRAVEL_2026_SLUG);
}

async function processReferralRewardsForInvitee(newUserId, inviterId, referralCode) {
  if (await hasReferralRewardsBeenProcessedForInvitee(newUserId)) {
    logger.info('Referral rewards already processed for invitee', { newUserId, inviterId });
    return { alreadyProcessed: true };
  }

  try {
    // Award direct referral bonus (standard / non-campaign) after first valid upload
    const paid = await payOnceInTransaction(async (tx) => {
      await tx.user.update({
        where: { id: inviterId },
        data: { totalPoints: { increment: DIRECT_REFERRAL_BONUS_POINTS } }
      });
      await assertNotPaidYet(tx, { source: 'REFERRAL_DIRECT', sourceId: newUserId });

      await tx.point.create({
        data: {
          userId: inviterId,
          amount: DIRECT_REFERRAL_BONUS_POINTS,
          source: 'REFERRAL_DIRECT',
          sourceId: newUserId
        }
      });

      logger.info(REFERRAL_MESSAGES.DIRECT_REWARD_AWARDED(inviterId, DIRECT_REFERRAL_BONUS_POINTS));

      try {
        const distributionResult = await distributeUplineRewards(
          inviterId,
          DIRECT_REFERRAL_BONUS_POINTS,
          tx,
          `referral_direct_${newUserId}`
        );
        logger.info('Upline distribution completed for direct referral bonus', {
          inviterId,
          inviteeId: newUserId,
          baseReward: DIRECT_REFERRAL_BONUS_POINTS,
          distributionResult
        });
      } catch (distributionError) {
        logger.error('Upline distribution failed for direct referral bonus', {
          inviterId,
          inviteeId: newUserId,
          baseReward: DIRECT_REFERRAL_BONUS_POINTS,
          error: distributionError.message
        });
      }
    });
    if (!paid) {
      logger.info('Referral rewards already processed for invitee by a concurrent request', { newUserId, inviterId });
      return { alreadyProcessed: true };
    }

    try {
      const { awardReferralBoost, syncRaffleTicketsForInviter } = require('./campaignEffects');
      await awardReferralBoost(inviterId, newUserId);
      await syncRaffleTicketsForInviter(inviterId);
    } catch (boostError) {
      logger.error('Referral campaign boost failed', {
        inviterId,
        inviteeId: newUserId,
        error: boostError.message,
      });
    }

    await recordTaskProgress(inviterId, 'referral-1', 1);

    let currentInvitee = newUserId;
    for (let level = 2; level <= 4; level++) {
      const parent = await prisma.referral.findUnique({ where: { inviteeId: currentInvitee }, select: { inviterId: true } });
      if (!parent?.inviterId) break;
      await recordTaskProgress(parent.inviterId, `referral-${level}`, 1);
      logger.info(REFERRAL_MESSAGES.MULTILEVEL_PROGRESS(parent.inviterId, level));
      currentInvitee = parent.inviterId;
    }

    return { processed: true };
  } catch (error) {
    logger.error('Error processing referral rewards for invitee', { error: error.message, newUserId, inviterId });
    throw error;
  }
}

/**
 * Standard referral: link at signup, pay inviter only after invitee's first valid upload made at or
 * after the bind. A user who binds a code after registering has to upload again before the inviter
 * (and, through the direct bonus, the upline and referral-N tasks) is rewarded.
 */
async function tryProcessReferralRewardsIfEligible(newUserId, inviterId, referralCode, boundAt = null) {
  const since = boundAt || (await getReferralBindTime(newUserId));
  if (!since) {
    logger.info('Referral rewards skipped — no referral row for invitee', { inviteeId: newUserId, inviterId });
    return { skipped: true, reason: 'no_referral' };
  }
  if (!(await hasCompletedFirstValidUpload(newUserId, prisma, { since }))) {
    logger.info('Referral rewards deferred until invitee first valid upload', {
      inviteeId: newUserId,
      inviterId,
    });
    return { deferred: true };
  }
  return processReferralRewardsForInvitee(newUserId, inviterId, referralCode);
}

async function onInviteeFirstValidUpload(userId) {
  const referral = await prisma.referral.findUnique({
    where: { inviteeId: userId },
    select: { inviterId: true, code: true, campaignSlug: true, createdAt: true },
  });
  if (!referral) {
    return { skipped: true };
  }
  if (referral.campaignSlug === SUMMER_TRAVEL_2026_SLUG) {
    return tryProcessSummerTravelReferralRewards(userId, referral.inviterId, referral.createdAt);
  }
  if (referral.campaignSlug) {
    // Other campaigns (e.g. Mother's Day) settle at signup, not on upload.
    return { skipped: true };
  }
  return tryProcessReferralRewardsIfEligible(userId, referral.inviterId, referral.code, referral.createdAt);
}

async function processReferral(newUserId, inviterId, referralCode) {
  return tryProcessReferralRewardsIfEligible(newUserId, inviterId, referralCode);
}

/**
 * Get user's referral status including invitation info
 * @param {string} userId - The user ID to get status for
 */
async function getReferralStatus(userId) {
  // Check if user has been invited by someone
  const asInvitee = await prisma.referral.findUnique({
    where: { inviteeId: userId },
    include: {
      inviter: {
        select: {
          id: true,
          name: true,
          referralCode: true
        }
      }
    }
  });

  // Get information about people this user has invited
  // Invites listed for referral UX: standard links only (campaigns use separate economics).
  const asInviter = await prisma.referral.findMany({
    where: { inviterId: userId, campaignSlug: null },
    select: {
      inviteeId: true,
      createdAt: true,
      invitee: {
        select: {
          id: true,
          name: true
        }
      }
    }
  });

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      name: true
    }
  });

  if (!user) {
    throw new Error('User not found');
  }

  const ownReferralCode = await ensureDisplayReferralCode(userId);

  return {
    hasBeenInvited: !!asInvitee,
    inviterInfo: asInvitee && asInvitee.inviter ? {
      id: asInvitee.inviter.id,
      name: asInvitee.inviter.name,
      code: formatReferralCodeForDisplay(asInvitee.inviter.referralCode),
      inviteTime: asInvitee.createdAt
    } : null,
    ownReferralCode: formatReferralCodeForDisplay(ownReferralCode),
    invitedUsers: asInviter.map(ref => ({
      id: ref.inviteeId,
      name: ref.invitee?.name || 'Unknown',
      inviteTime: ref.createdAt
    })),
    rules: getReferralRulesPayload(),
  };
}

/**
 * Use a referral code
 * @param {string} userId - The user ID who is using the code
 * @param {string} code - The referral code to use
 * @throws {Error} with code property for specific error cases
 */
async function countCampaignInvitesAsInviter(userId, campaignSlug) {
  if (!campaignSlug) return 0;
  return prisma.referral.count({
    where: { inviterId: userId, campaignSlug },
  });
}

/** Settled Summer Travel invites (inviter Point rows). */
async function countSummerTravelSettledInvites(userId) {
  return prisma.point.count({
    where: {
      userId,
      source: POINT_SOURCE_SUMMER_TRAVEL_INVITER,
    },
  });
}

async function sumPointsBySource(userId, source) {
  const agg = await prisma.point.aggregate({
    where: { userId, source },
    _sum: { amount: true },
  });
  return agg._sum.amount || 0;
}

/**
 * Authenticated Summer Travel campaign stats for the campaign page.
 */
async function getSummerTravel2026Stats(userId) {
  const [user, summerOrderCount, bonusPoints, successfulInvites, linkedInvites] =
    await Promise.all([
      prisma.user.findUnique({
        where: { id: userId },
        select: { referralCode: true },
      }),
      countUserSummerStayOrders(userId),
      sumPointsBySource(userId, POINT_SOURCE_SUMMER_TRAVEL_BONUS),
      countSummerTravelSettledInvites(userId),
      countCampaignInvitesAsInviter(userId, SUMMER_TRAVEL_2026_SLUG),
    ]);

  const stayRules = await resolveStayBonusRules();
  const canInvite = summerOrderCount > 0;
  const pointsPerOrder = stayRules?.pointsPerOrder || SUMMER_TRAVEL_2026.pointsPerOrderDisplay;
  const inviterPoints = stayRules?.inviterPoints || SUMMER_TRAVEL_2026.inviterPoints;
  const inviteePoints = stayRules?.inviteePoints || SUMMER_TRAVEL_2026.inviteePoints;
  const orderPointsEarned = summerOrderCount * pointsPerOrder;
  const invitePointsEarned = successfulInvites * inviterPoints;
  const pendingInvites = Math.max(0, linkedInvites - successfulInvites);

  return {
    slug: SUMMER_TRAVEL_2026_SLUG,
    isActive: Boolean(stayRules?.isActive),
    ownReferralCode: formatReferralCodeForDisplay(user?.referralCode ?? ''),
    canInvite,
    summerOrderCount,
    summerOrderBonusPoints: bonusPoints,
    orderPointsEarned,
    pointsPerOrder,
    successfulInvites,
    pendingInvites,
    linkedInvites,
    invitePointsEarned,
    inviterPoints,
    inviteePoints,
    sites: stayRules?.sites || ['airbnb', 'booking'],
  };
}

/**
 * Upper bound on the upline walk. Real invite chains are a handful of levels deep; the cap only
 * exists so corrupt data can never keep a request (and the late-bind lock) busy indefinitely.
 */
const REFERRAL_UPLINE_WALK_LIMIT = 1000;

function referralCycleError() {
  const err = new Error(
    'This referral code belongs to someone in your own invite network, so it cannot be your inviter'
  );
  err.code = 'REFERRAL_CYCLE';
  return err;
}

/**
 * Would making `inviterId` the inviter of `inviteeId` close a ring (A invites B, then A binds B's
 * code: A→B→A)? Walks the proposed inviter's upline one Referral row at a time (inviteeId is
 * unique, so each user has at most one inviter) and reports a cycle when the walk reaches the
 * invitee. A ring already in the data above the inviter is detected by the visited set and ends
 * the walk (the new edge does not close it: the invitee is not on it); hitting the depth cap is
 * reported as a cycle so an unprovable bind fails closed.
 *
 * @returns {Promise<{ cycle: boolean, reason: 'cycle' | 'root' | 'existing_ring' | 'depth_cap', hops: number }>}
 */
async function findReferralCycle(inviteeId, inviterId, db = prisma) {
  const visited = new Set();
  let current = inviterId;
  for (let hops = 0; hops < REFERRAL_UPLINE_WALK_LIMIT; hops += 1) {
    if (current === inviteeId) return { cycle: true, reason: 'cycle', hops };
    if (visited.has(current)) return { cycle: false, reason: 'existing_ring', hops };
    visited.add(current);
    const row = await db.referral.findUnique({
      where: { inviteeId: current },
      select: { inviterId: true },
    });
    if (!row) return { cycle: false, reason: 'root', hops };
    current = row.inviterId;
  }
  return { cycle: true, reason: 'depth_cap', hops: REFERRAL_UPLINE_WALK_LIMIT };
}

/**
 * Creates the Referral row for an ALREADY-REGISTERED user who binds an inviter later (POST
 * /api/referrals/use-code and a code sent with a later web3auth login), refusing with
 * REFERRAL_CYCLE when the bind would close a ring (decision 11 B, 2026-09-26). Signup with a code
 * does not come here: a brand-new user has no downline, so their bind cannot close a ring.
 *
 * Concurrency: A binding B's code while B binds A's code would each walk an upline that does not
 * yet contain the other's uncommitted row, and both would commit A→B→A. Locking the two users'
 * rows does not cover longer rings (A binds X while Y binds B, with A→B and Y→X already present:
 * the two binds touch disjoint users yet close X→A→B→Y→X). So every late bind takes one
 * transaction-scoped advisory lock, re-walks the upline under it, and inserts before releasing it
 * at commit; under READ COMMITTED each statement then sees every earlier late bind. Late binds are
 * rare and the critical section is a few indexed lookups, so serialising them costs nothing
 * noticeable, and unlike SERIALIZABLE it needs no retry loop. Rewards are settled by the caller
 * after this commits (see settleReferral in web3AuthController for why they cannot share the tx).
 */
async function createLateBindReferral({ inviteeId, inviterId, code, campaignSlug = null }) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('ddc:referral-late-bind'))`;
    const walk = await findReferralCycle(inviteeId, inviterId, tx);
    if (walk.cycle) {
      logger.warn('Late referral bind refused: would create a cycle', {
        inviteeId,
        inviterId,
        reason: walk.reason,
        hops: walk.hops,
      });
      throw referralCycleError();
    }
    if (walk.reason === 'existing_ring') {
      logger.warn('Referral upline already contains a ring', { inviteeId, inviterId });
    }
    return tx.referral.create({
      data: { inviterId, inviteeId, code, campaignSlug },
    });
  });
}

async function useReferralCode(userId, code, referralCampaignRaw = null) {
  let campaignSlug = null;
  try {
    campaignSlug = normalizeReferralCampaignInput(referralCampaignRaw);
  } catch (e) {
    if (e.code) throw e;
    throw e;
  }
  await assertReferralCampaignUsable(campaignSlug);

  if (campaignSlug && !code) {
    const err = new Error('Referral code is required for campaign invites');
    err.code = 'MISSING_CODE';
    throw err;
  }

  // Check if user has already been referred
  const existingReferral = await prisma.referral.findUnique({
    where: { inviteeId: userId },
    include: { inviter: { select: { id: true, name: true } } }
  });

  if (existingReferral) {
    const error = new Error('User has already been referred');
    error.code = 'ALREADY_REFERRED';
    error.data = {
      inviterId: existingReferral.inviterId,
      inviterName: existingReferral.inviter?.name,
      code: formatReferralCodeForDisplay(existingReferral.code),
      createdAt: existingReferral.createdAt
    };
    throw error;
  }

  // Stored (and passed on) without the display prefix: "DDC-ABC123" is recorded as "ABC123".
  code = normalizeReferralCodeInput(code);
  const inviter = await findUserByReferralCode(code, { id: true, name: true, referralCode: true });

  if (!inviter) {
    const error = new Error('Invalid referral code');
    error.code = 'INVALID_CODE';
    throw error;
  }

  // Prevent self-referral
  if (inviter.id === userId) {
    const error = new Error('Cannot use your own referral code');
    error.code = 'SELF_REFERRAL_NOT_ALLOWED';
    throw error;
  }

  if (campaignSlug === SUMMER_TRAVEL_2026_SLUG) {
    await assertSummerTravelInviterEligible(inviter.id);
  }

  try {
    const referralData = await createLateBindReferral({
      inviterId: inviter.id,
      inviteeId: userId,
      code,
      campaignSlug,
    });

    if (campaignSlug === MOTHERS_DAY_2026_SLUG) {
      await processCampaignReferral(userId, inviter.id, campaignSlug);
    } else if (campaignSlug === SUMMER_TRAVEL_2026_SLUG) {
      // Relation only — settle after invitee's first valid summer stay upload.
    } else {
      await tryProcessReferralRewardsIfEligible(userId, inviter.id, code, referralData.createdAt);
    }

    return {
      inviterId: inviter.id,
      inviterName: inviter.name,
      inviteeId: userId,
      code: formatReferralCodeForDisplay(code),
      createdAt: referralData.createdAt,
    };
  } catch (error) {
    if (error.code === 'REFERRAL_CYCLE') throw error; // expected refusal, logged by createLateBindReferral
    console.error('Transaction error in useReferralCode:', error);
    if (error.code === 'P2002') {
      const err = new Error('User has already been referred');
      err.code = 'ALREADY_REFERRED';
      throw err;
    }
    throw error;
  }
}

module.exports = {
  getReferralOverview,
  qualifiedLevelCountsSince,
  claimReferralRewards,
  processReferral,
  processReferralRewardsForInvitee,
  tryProcessReferralRewardsIfEligible,
  onInviteeFirstValidUpload,
  processCampaignReferral,
  getReferralStatus,
  useReferralCode,
  findReferralCycle,
  createLateBindReferral,
  countCampaignInvitesAsInviter,
  countSummerTravelSettledInvites,
  getSummerTravel2026Stats,
  assertSummerTravelInviterEligible,
  tryProcessSummerTravelReferralRewards,
};