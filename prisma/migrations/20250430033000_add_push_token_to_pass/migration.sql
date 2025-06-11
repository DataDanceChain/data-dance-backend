-- Add pushToken field to Pass table
ALTER TABLE "Pass" ADD COLUMN "pushToken" TEXT;

-- Add unique constraint to pushToken
ALTER TABLE "Pass" ADD CONSTRAINT "Pass_pushToken_key" UNIQUE ("pushToken"); 