const prisma = require('./prisma');

/**
 * Seeded data-pack rows are personal inventory only — never reward-eligible.
 * Use this in any crawlerData count that unlocks points / referral / tasks.
 */
const NOT_DATA_PACK_IMPORT = {
  NOT: {
    metadata: {
      path: ['importSource'],
      equals: 'data-pack',
    },
  },
};

function rewardEligibleUploadWhere(where = {}) {
  return { ...where, ...NOT_DATA_PACK_IMPORT };
}

/**
 * A "valid upload" is any persisted crawlerData row for the user that is not a
 * data-pack seed (same basis as new-user-first-upload / data-collection tasks).
 *
 * `since` (a Date) limits the check to uploads created at or after that instant. Referral rewards
 * pass the invitee's bind time (Referral.createdAt): an inviter is only rewarded for what the
 * invitee does after binding (Sloan, 2026-09-28). Without `since` every upload counts.
 */
async function hasCompletedFirstValidUpload(userId, db = prisma, { since } = {}) {
  const where = { userId };
  if (since) where.createdAt = { gte: since };
  const count = await db.crawlerData.count({
    where: rewardEligibleUploadWhere(where),
  });
  return count > 0;
}

/**
 * userId -> createdAt of that user's latest reward-eligible crawlerData row. Users with none are absent.
 * One grouped query, however many users.
 */
async function getLatestValidUploadAt(userIds, db = prisma) {
  const latest = new Map();
  if (!userIds?.length) return latest;
  const rows = await db.crawlerData.groupBy({
    by: ['userId'],
    where: rewardEligibleUploadWhere({ userId: { in: userIds } }),
    _max: { createdAt: true },
  });
  for (const r of rows) latest.set(r.userId, r._max?.createdAt || null);
  return latest;
}

/** Returns invitee user IDs that have at least one reward-eligible crawlerData row. */
async function getUsersWithValidUploads(userIds, db = prisma) {
  if (!userIds?.length) return new Set();
  const rows = await db.crawlerData.groupBy({
    by: ['userId'],
    where: rewardEligibleUploadWhere({ userId: { in: userIds } }),
  });
  return new Set(rows.map((r) => r.userId));
}

async function isStandardReferralInvitee(userId, db = prisma) {
  const referral = await db.referral.findUnique({
    where: { inviteeId: userId },
    select: { campaignSlug: true },
  });
  return Boolean(referral && !referral.campaignSlug);
}

module.exports = {
  NOT_DATA_PACK_IMPORT,
  rewardEligibleUploadWhere,
  hasCompletedFirstValidUpload,
  getLatestValidUploadAt,
  getUsersWithValidUploads,
  isStandardReferralInvitee,
};
