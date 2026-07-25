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
 */
async function hasCompletedFirstValidUpload(userId, db = prisma) {
  const count = await db.crawlerData.count({
    where: rewardEligibleUploadWhere({ userId }),
  });
  return count > 0;
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
  getUsersWithValidUploads,
  isStandardReferralInvitee,
};
