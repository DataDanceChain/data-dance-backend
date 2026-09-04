-- AlterTable
ALTER TABLE "PrivacyRequest" ADD COLUMN IF NOT EXISTS "opsNote" TEXT;
ALTER TABLE "PrivacyRequest" ADD COLUMN IF NOT EXISTS "resolvedAt" TIMESTAMP(3);
ALTER TABLE "PrivacyRequest" ADD COLUMN IF NOT EXISTS "resolvedBy" TEXT;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PrivacyRequest_status_createdAt_idx" ON "PrivacyRequest"("status", "createdAt");
