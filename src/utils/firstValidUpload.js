const prisma = require('./prisma');

/**
 * A "valid upload" is any persisted crawlerData row for the user (same basis as
 * new-user-first-upload / data-collection tasks).
 */
async function hasCompletedFirstValidUpload(userId, db = prisma) {
  const count = await db.crawlerData.count({ where: { userId } });
  return count > 0;
}

/** Returns invitee user IDs that have at least one crawlerData row. */
async function getUsersWithValidUploads(userIds, db = prisma) {
  if (!userIds?.length) return new Set();
  const rows = await db.crawlerData.groupBy({
    by: ['userId'],
    where: { userId: { in: userIds } },
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
  hasCompletedFirstValidUpload,
  getUsersWithValidUploads,
  isStandardReferralInvitee,
};
