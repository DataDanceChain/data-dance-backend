/*
  Warnings:

  - A unique constraint covering the columns `[userId,creatorId]` on the table `Pass` will be added. If there are existing duplicate values, this will fail.

*/
-- Drop the constraint first
ALTER TABLE "Pass" DROP CONSTRAINT IF EXISTS "Pass_pushToken_key";

-- Then drop the index
DROP INDEX IF EXISTS "Pass_pushToken_key";

-- Create new unique index
CREATE UNIQUE INDEX "Pass_userId_creatorId_key" ON "Pass"("userId", "creatorId");
