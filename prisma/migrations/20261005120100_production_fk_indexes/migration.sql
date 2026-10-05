-- Five indexes on foreign-key columns that production's database already has, although no migration
-- created them (live schema-only dump, 2026-10-05): they were added outside the migration history.
-- Declaring them keeps every database built by `prisma migrate deploy` identical to production, and
-- keeps `prisma migrate diff` from proposing to drop them there.
--
-- IDEMPOTENT on purpose, like 20260923090000_user_legacy_referral_code: production already has these
-- indexes under exactly these names and definitions, so this migration is a no-op there.

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CrawlerData_taskId_idx" ON "CrawlerData"("taskId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "CrawlerTask_userId_idx" ON "CrawlerTask"("userId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Point_userId_idx" ON "Point"("userId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ProcurementAllocation_userId_idx" ON "ProcurementAllocation"("userId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "User_organizationId_idx" ON "User"("organizationId");
