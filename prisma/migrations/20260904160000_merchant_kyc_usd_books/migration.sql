-- AlterTable
ALTER TABLE "LegalEntity" ADD COLUMN IF NOT EXISTS "brNumber" TEXT;
ALTER TABLE "LegalEntity" ADD COLUMN IF NOT EXISTS "beneficialOwner" TEXT;
ALTER TABLE "LegalEntity" ADD COLUMN IF NOT EXISTS "kycStatus" TEXT NOT NULL DEFAULT 'incomplete';
ALTER TABLE "LegalEntity" ADD COLUMN IF NOT EXISTS "kycSubmittedAt" TIMESTAMP(3);
ALTER TABLE "LegalEntity" ADD COLUMN IF NOT EXISTS "kycReviewedAt" TIMESTAMP(3);
ALTER TABLE "LegalEntity" ADD COLUMN IF NOT EXISTS "kycReviewedBy" TEXT;
ALTER TABLE "LegalEntity" ADD COLUMN IF NOT EXISTS "kycNote" TEXT;

-- Books are USD only
UPDATE "LegalEntity" SET "currency" = 'USD' WHERE "currency" IS DISTINCT FROM 'USD';
UPDATE "PurchaseOrder" SET "currency" = 'USD' WHERE "currency" IS DISTINCT FROM 'USD';
UPDATE "Invoice" SET "currency" = 'USD' WHERE "currency" IS DISTINCT FROM 'USD';
UPDATE "Payment" SET "currency" = 'USD' WHERE "currency" IS DISTINCT FROM 'USD';
