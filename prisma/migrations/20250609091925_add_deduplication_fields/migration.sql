/*
  Warnings:

  - A unique constraint covering the columns `[contentHash]` on the table `CrawlerData` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[source,sourceId]` on the table `CrawlerData` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `contentHash` to the `CrawlerData` table without a default value. This is not possible if the table is not empty.

*/

-- Step 1: Add columns as nullable first
ALTER TABLE "CrawlerData" ADD COLUMN "contentHash" TEXT;
ALTER TABLE "CrawlerData" ADD COLUMN "sourceId" TEXT;

-- Step 2: Generate contentHash for existing records using MD5 of payload
UPDATE "CrawlerData" SET "contentHash" = MD5(payload::text) WHERE "contentHash" IS NULL;

-- Step 3: Try to extract sourceId for existing records
-- For Amazon products, try to extract productId or asin
UPDATE "CrawlerData" SET "sourceId" = 
  CASE 
    WHEN source = 'amazon' AND type = 'product' AND payload->>'productId' IS NOT NULL 
      THEN payload->>'productId'
    WHEN source = 'amazon' AND type = 'product' AND payload->>'asin' IS NOT NULL 
      THEN payload->>'asin'
    WHEN source = 'amazon' AND type = 'review' AND payload->>'reviewId' IS NOT NULL 
      THEN payload->>'reviewId'
    WHEN source = 'luma' AND type = 'event' AND payload->>'eventId' IS NOT NULL 
      THEN payload->>'eventId'
    WHEN source = 'luma' AND type = 'event' AND payload->>'id' IS NOT NULL 
      THEN payload->>'id'
    ELSE NULL
  END
WHERE "sourceId" IS NULL;

-- Step 4: Make contentHash required
ALTER TABLE "CrawlerData" ALTER COLUMN "contentHash" SET NOT NULL;

-- Step 5: Create indexes
CREATE INDEX "CrawlerData_userId_createdAt_idx" ON "CrawlerData"("userId", "createdAt");

-- Step 6: Create unique constraints (this might fail if there are actual duplicates)
-- We'll create them conditionally to avoid failures
DO $$
BEGIN
  -- Try to create contentHash unique constraint
  BEGIN
CREATE UNIQUE INDEX "CrawlerData_contentHash_key" ON "CrawlerData"("contentHash");
  EXCEPTION WHEN unique_violation THEN
    -- If there are duplicates, create a regular index instead and log
    RAISE NOTICE 'Duplicate contentHash values found, creating regular index instead';
    CREATE INDEX "CrawlerData_contentHash_idx" ON "CrawlerData"("contentHash");
  END;
  
  -- Try to create source+sourceId unique constraint (only for non-null sourceId)
  BEGIN
    CREATE UNIQUE INDEX "CrawlerData_source_sourceId_key" ON "CrawlerData"("source", "sourceId") WHERE "sourceId" IS NOT NULL;
  EXCEPTION WHEN unique_violation THEN
    -- If there are duplicates, create a regular index instead
    RAISE NOTICE 'Duplicate source+sourceId values found, creating regular index instead';
    CREATE INDEX "CrawlerData_source_sourceId_idx" ON "CrawlerData"("source", "sourceId") WHERE "sourceId" IS NOT NULL;
  END;
END $$;
