-- Add missing fields to Pass table
ALTER TABLE "Pass" ADD COLUMN IF NOT EXISTS "serialNumber" TEXT;
ALTER TABLE "Pass" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Add unique constraint to serialNumber
ALTER TABLE "Pass" ADD CONSTRAINT "Pass_serialNumber_key" UNIQUE ("serialNumber"); 