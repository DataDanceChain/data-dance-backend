const prisma = require('./prisma');

// Prisma.DbNull, taken from the runtime the generated client itself uses: unit tests replace
// '@prisma/client' with a stub that has no `Prisma` namespace, and this module loads under them.
const { Prisma } = require('@prisma/client');
const DB_NULL = Prisma?.DbNull ?? require('@prisma/client/runtime/library').objectEnumValues.instances.DbNull;

/**
 * Seeded data-pack rows are personal inventory only — never reward-eligible.
 * Use this in any crawlerData count that unlocks points / referral / tasks.
 *
 * Ordinary App uploads carry no `importSource` key. On Postgres `metadata #> '{importSource}'` is
 * then SQL NULL, so a bare `NOT (importSource = 'data-pack')` is NULL too and silently drops every
 * ordinary upload. The inner `NOT importSource IS NULL` turns the missing-key case into FALSE, so
 * the whole filter is `NOT (importSource = 'data-pack' AND importSource IS NOT NULL)`: TRUE for a
 * missing key, JSON null, non-object metadata or any other importSource; FALSE only for data-pack.
 */
const NOT_DATA_PACK_IMPORT = {
  NOT: {
    metadata: {
      path: ['importSource'],
      equals: 'data-pack',
    },
    AND: {
      NOT: {
        metadata: {
          path: ['importSource'],
          equals: DB_NULL,
        },
      },
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
