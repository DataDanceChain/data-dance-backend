-- Rename brand fields to creator fields in Pass table
ALTER TABLE "Pass" RENAME COLUMN "brandId" TO "creatorId";
ALTER TABLE "Pass" RENAME COLUMN "brandName" TO "creatorName";
ALTER TABLE "Pass" RENAME COLUMN "brandLogo" TO "creatorLogo";

-- Drop old indexes
DROP INDEX "Pass_brandId_idx";

-- Create new indexes
CREATE INDEX "Pass_creatorId_idx" ON "Pass"("creatorId"); 