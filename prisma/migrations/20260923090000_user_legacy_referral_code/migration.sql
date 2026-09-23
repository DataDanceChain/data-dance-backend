-- User.legacyReferralCode (String? @unique) was added to schema.prisma in da581fe ("Show short
-- referral codes while keeping old ones valid") without a migration. A database built by
-- `prisma migrate deploy` therefore lacked the column, and every query on User failed.
--
-- IDEMPOTENT on purpose: environments where the column was created outside the migration history
-- (`prisma migrate dev` / `db push` on a server) already have it, and this must be a no-op there.
-- The unique index name is the one Prisma derives for `@unique`, so `migrate diff` stays clean.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "legacyReferralCode" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "User_legacyReferralCode_key" ON "User"("legacyReferralCode");
